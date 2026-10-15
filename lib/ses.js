import "server-only";
import {
	CreateConfigurationSetCommand,
	CreateConfigurationSetEventDestinationCommand,
	CreateEmailIdentityCommand,
	CreateTenantCommand,
	CreateTenantResourceAssociationCommand,
	DeleteConfigurationSetCommand,
	DeleteEmailIdentityCommand,
	DeleteTenantCommand,
	DeleteTenantResourceAssociationCommand,
	GetAccountCommand,
	GetEmailIdentityCommand,
	GetTenantCommand,
	PutEmailIdentityMailFromAttributesCommand,
	SESv2Client,
	SendEmailCommand,
	UpdateReputationEntityCustomerManagedStatusCommand,
	UpdateReputationEntityPolicyCommand,
} from "@aws-sdk/client-sesv2";
import { isSendingEnabled } from "@/lib/config";
import { SEND_OUTCOMES } from "@/lib/email-provider/outcomes";
import { getSesRegion } from "@/lib/pacing";

// Every call to AWS lives in this file, so tests replace it whole (tests/stubs/ses.mjs).
const REGION = getSesRegion();
const CACHE_TTL_MS = 5 * 60_000;
// Reads only: a send that timed out could still have gone out, and the SDK would retry it.
const READ_TIMEOUT_MS = 5000;
const EVENT_TYPES = ["SEND", "REJECT", "BOUNCE", "COMPLAINT", "DELIVERY", "DELIVERY_DELAY", "RENDERING_FAILURE"];
const cache = new Map();
// Sends are never retried by the SDK: a timed-out attempt may have gone out (see sendSesEmail).
const SEND_TIMEOUT_MS = 30_000;
let client;
let sendClient;

// Only MailCheap's own keys: never the default AWS chain (~/.aws, instance roles), which could belong to
// another AWS account. Vercel reserves the AWS_* names, hence SES_*.
function getCredentials() {
	const { SES_ACCESS_KEY_ID: accessKeyId, SES_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
	if (!accessKeyId || !secretAccessKey) throw new Error("SES is not configured (SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY)");
	return { accessKeyId, secretAccessKey };
}

function getClient() {
	client ??= new SESv2Client({ region: REGION, credentials: getCredentials() });
	return client;
}

function getSendClient() {
	// SES_ENDPOINT only exists on the local stage, to send to a mock SES.
	sendClient ??= new SESv2Client({ region: REGION, credentials: getCredentials(), maxAttempts: 1, endpoint: process.env.SES_ENDPOINT || undefined });
	return sendClient;
}

function read(command) {
	return getClient().send(command, { abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
}

function write(command) {
	return getClient().send(command);
}

// Creating what already exists is how retries land here: it counts as done.
async function writeOnce(command) {
	try {
		return await write(command);
	} catch (error) {
		if (error?.name === "AlreadyExistsException") return null;
		throw error;
	}
}

// Deleting what's gone already counts as done too.
async function deleteOnce(command) {
	try {
		await write(command);
	} catch (error) {
		if (error?.name !== "NotFoundException") throw error;
	}
}

function getAwsAccountId() {
	const id = process.env.SES_AWS_ACCOUNT_ID;
	if (!/^\d{12}$/.test(id ?? "")) throw new Error("SES is not configured (SES_AWS_ACCOUNT_ID)");
	return id;
}

export function getIdentityArn(identity) {
	return `arn:aws:ses:${REGION}:${getAwsAccountId()}:identity/${identity}`;
}

function getConfigurationSetArn(name) {
	return `arn:aws:ses:${REGION}:${getAwsAccountId()}:configuration-set/${name}`;
}

function getReputationPolicyArn(policy) {
	return `arn:aws:ses:${REGION}:aws:reputation-policy/${policy}`;
}

async function cached(key, { fresh }, load) {
	const hit = cache.get(key);
	if (!fresh && hit && hit.expiresAt > Date.now()) return hit.promise;
	const entry = { promise: load(), expiresAt: Date.now() + CACHE_TTL_MS };
	cache.set(key, entry);
	const value = await entry.promise;
	if (value?.error && cache.get(key) === entry) cache.delete(key);
	return value;
}

// The AWS account as a whole, for the admin page.
export function getSesAccount({ fresh = false } = {}) {
	return cached("account", { fresh }, loadSesAccount);
}

async function loadSesAccount() {
	try {
		const account = await read(new GetAccountCommand({}));
		return {
			productionAccess: Boolean(account.ProductionAccessEnabled),
			reviewStatus: account.Details?.ReviewDetails?.Status || null,
			sendingEnabled: Boolean(account.SendingEnabled),
			enforcementStatus: account.EnforcementStatus,
			max24HourSend: account.SendQuota?.Max24HourSend ?? 0,
			maxSendRate: account.SendQuota?.MaxSendRate ?? 0,
			sentLast24Hours: account.SendQuota?.SentLast24Hours ?? 0,
		};
	} catch (error) {
		return { error: error.message };
	}
}

// One configuration set per customer account: its events go to the SNS topic of /api/webhooks/ses.
export async function createConfigurationSet(name) {
	const topicArn = process.env.SES_SNS_TOPIC_ARN;
	if (!topicArn) throw new Error("SES is not configured (SES_SNS_TOPIC_ARN)");
	await writeOnce(new CreateConfigurationSetCommand({ ConfigurationSetName: name, ReputationOptions: { ReputationMetricsEnabled: true } }));
	await writeOnce(
		new CreateConfigurationSetEventDestinationCommand({
			ConfigurationSetName: name,
			EventDestinationName: "mailcheap-events",
			EventDestination: { Enabled: true, MatchingEventTypes: EVENT_TYPES, SnsDestination: { TopicArn: topicArn } },
		})
	);
}

// Each tenant keeps its own suppression list, like each account keeps its own in MailCheap.
export async function createTenant(name, { accountId }) {
	await writeOnce(
		new CreateTenantCommand({
			TenantName: name,
			Tags: [{ Key: "account_id", Value: String(accountId) }],
			SuppressionAttributes: { SuppressionScope: "TENANT", SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
		})
	);
	const { Tenant: tenant } = await read(new GetTenantCommand({ TenantName: name }));
	await write(
		new UpdateReputationEntityPolicyCommand({
			ReputationEntityType: "RESOURCE",
			ReputationEntityReference: tenant.TenantArn,
			ReputationEntityPolicy: getReputationPolicyArn("standard"),
		})
	);
	return { tenantArn: tenant.TenantArn, sendingStatus: tenant.SendingStatus ?? null };
}

export async function associateTenantResources(tenantName, { identities = [], configurationSets = [] }) {
	const arns = [...identities.map(getIdentityArn), ...configurationSets.map(getConfigurationSetArn)];
	for (const arn of arns) await writeOnce(new CreateTenantResourceAssociationCommand({ TenantName: tenantName, ResourceArn: arn }));
}

export function dissociateTenantIdentity(tenantName, identity) {
	return deleteOnce(new DeleteTenantResourceAssociationCommand({ TenantName: tenantName, ResourceArn: getIdentityArn(identity) }));
}

// An account's purge, once its identities are gone: SES drops the tenant's associations with it.
export async function deleteTenant(name) {
	await deleteOnce(new DeleteTenantCommand({ TenantName: name }));
}

export async function deleteConfigurationSet(name) {
	await deleteOnce(new DeleteConfigurationSetCommand({ ConfigurationSetName: name }));
}

// After an admin resumes an account that SES paused. REINSTATED lets it send while findings stay open.
export async function reinstateTenant(tenantArn) {
	await write(
		new UpdateReputationEntityCustomerManagedStatusCommand({
			ReputationEntityType: "RESOURCE",
			ReputationEntityReference: tenantArn,
			SendingStatus: "REINSTATED",
		})
	);
}

// Easy DKIM with 2048-bit keys, and a custom MAIL FROM so SPF aligns with the customer's domain.
export async function createDomainIdentity(domain, { configurationSet, mailFromDomain }) {
	await writeOnce(
		new CreateEmailIdentityCommand({
			EmailIdentity: domain,
			DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
			ConfigurationSetName: configurationSet,
		})
	);
	await write(
		new PutEmailIdentityMailFromAttributesCommand({
			EmailIdentity: domain,
			MailFromDomain: mailFromDomain,
			BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
		})
	);
}

export function deleteDomainIdentity(domain) {
	return deleteOnce(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
}

function dnsRecords(domain, identity) {
	const dkim = (identity.DkimAttributes?.Tokens || []).map((token) => ({
		purpose: "dkim",
		type: "CNAME",
		name: `${token}._domainkey.${domain}`,
		value: `${token}.dkim.amazonses.com`,
	}));
	const mailFrom = identity.MailFromAttributes?.MailFromDomain;
	const bounce = mailFrom
		? [
				{ purpose: "mail-from", type: "MX", name: mailFrom, value: `10 feedback-smtp.${REGION}.amazonses.com` },
				{ purpose: "mail-from", type: "TXT", name: mailFrom, value: "v=spf1 include:amazonses.com ~all" },
			]
		: [];
	return [...dkim, ...bounce];
}

// One domain, read fresh: the domains page and "Check now" only ever ask for the account's own.
export async function getDomainIdentity(domain) {
	try {
		const identity = await read(new GetEmailIdentityCommand({ EmailIdentity: domain }));
		return {
			verified: Boolean(identity.VerifiedForSendingStatus),
			dkimStatus: identity.DkimAttributes?.Status || "NOT_STARTED",
			mailFromStatus: identity.MailFromAttributes?.MailFromDomainStatus || null,
			records: dnsRecords(domain, identity),
		};
	} catch (error) {
		if (error?.name === "NotFoundException") return { missing: true };
		return { error: error.message };
	}
}

// MailCheap's own emails on a self-hosted server without Resend: from EMAIL_FROM, on any identity the AWS account
// verified, outside every tenant. SENDING_ENABLED is for customers' emails; sign-in codes go before sending is on.
export async function sendSesPlatformEmail({ from, to, subject, text, html }) {
	const result = await getClient().send(
		new SendEmailCommand({
			FromEmailAddress: from,
			Destination: { ToAddresses: [to] },
			Content: {
				Simple: {
					Subject: { Data: subject, Charset: "UTF-8" },
					Body: { Text: { Data: text, Charset: "UTF-8" }, ...(html && { Html: { Data: html, Charset: "UTF-8" } }) },
				},
			},
		})
	);
	return { sesMessageId: result.MessageId };
}

function isBeforeRequest(error) {
	return error?.name === "CredentialsProviderError" || /credential/i.test(String(error?.message));
}

// One attempt, never retried by the SDK. An error SES answered with (or no credentials to sign with) means
// nothing was sent. No answer at all (network, timeout) means it may have been: the error is marked ambiguous,
// with the unanswered outcome, and the message is never sent again (lib/sending.js); its SES events settle it.
export async function sendSesEmail({ from, to, replyTo, subject, html, text, headers = {}, tags = [], tenantName, configurationSet }) {
	if (!isSendingEnabled()) throw new Error("Sending is off (SENDING_ENABLED is not true)");
	if (!tenantName || !configurationSet) throw new Error("Every email needs the account's SES tenant and configuration set");

	const command = new SendEmailCommand({
		FromEmailAddress: from,
		Destination: { ToAddresses: [to] },
		ReplyToAddresses: replyTo ? [replyTo] : undefined,
		ConfigurationSetName: configurationSet,
		TenantName: tenantName,
		EmailTags: tags.map(({ name, value }) => ({ Name: name, Value: value })),
		Content: {
			Simple: {
				Subject: { Data: subject, Charset: "UTF-8" },
				Body: {
					Html: { Data: html, Charset: "UTF-8" },
					Text: { Data: text, Charset: "UTF-8" },
				},
				Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })),
			},
		},
	});
	const client = getSendClient();
	try {
		const result = await client.send(command, { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
		return { sesMessageId: result.MessageId };
	} catch (error) {
		if (!error?.$metadata?.httpStatusCode && !isBeforeRequest(error)) Object.assign(error, { ambiguous: true, outcome: SEND_OUTCOMES.unanswered });
		throw error;
	}
}
