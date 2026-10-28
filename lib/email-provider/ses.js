import "server-only";
import { sendAlert } from "@/lib/alerts";
import { LIMITS } from "@/lib/config";
import { getAll, getOne } from "@/lib/db";
import {
	associateTenantResources,
	createConfigurationSet,
	createDomainIdentity,
	createTenant,
	deleteConfigurationSet,
	deleteDomainIdentity,
	deleteTenant,
	dissociateTenantIdentity,
	enableAutoValidation,
	getDomainIdentity,
	reinstateTenant,
	sendSesEmail,
	sendSesPlatformEmail,
} from "@/lib/ses";
import { updateRows } from "@/lib/records";

// SES allows 64 letters, digits, - and _: the account id fits and never changes.
export function getTenantName(accountId) {
	return `mc-${accountId}`;
}

function getTenant(account) {
	return account?.ses?.provisionedAt ? account.ses : null;
}

// One SES tenant per account, with its own configuration set and the account's own domains. Every step is
// safe to repeat, so a failed attempt is finished by the next one. Shared addresses are identities of their own
// (lib/shared-sender.js), added like domains.
async function provisionTenant(accountId) {
	const account = await getOne("SELECT _id, ses FROM accounts WHERE _id = ?", [String(accountId)]);
	if (!account) throw new Error("Account not found");
	if (account.ses?.provisionedAt) return account.ses;

	const name = getTenantName(account._id);
	await createConfigurationSet(name);
	const { tenantArn, sendingStatus } = await createTenant(name, { accountId: account._id });
	const domains = await getAll("SELECT domain FROM domains WHERE accountId = ? AND (provider = 'ses' OR provider IS NULL)", [account._id]);
	await associateTenantResources(name, { identities: domains.map(({ domain }) => domain), configurationSets: [name] });

	const ses = {
		...account.ses,
		tenantName: name,
		tenantArn,
		configurationSet: name,
		provisionedAt: new Date(),
		tenantStatus: sendingStatus ?? account.ses?.tenantStatus,
	};
	await updateRows("accounts", { where: "_id = ?", params: [account._id] }, { set: { ses } });
	return ses;
}

// SES Auto Validation on the tenant's configuration set (lib/ses.js), for tenants old and new, at their next send or
// domain. Without it, emails go out as they did before: a failure, often a key without
// ses:PutConfigurationSetSuppressionOptions, is tried again an hour later.
const AUTO_VALIDATION_RETRY_MS = 60 * 60_000;

async function ensureAutoValidation(accountId, tenant) {
	if (tenant.autoValidationAt) return tenant;
	if (Date.now() - new Date(tenant.autoValidationFailedAt ?? 0).getTime() < AUTO_VALIDATION_RETRY_MS) return tenant;
	const account = { where: "_id = ?", params: [String(accountId)] };
	try {
		await enableAutoValidation(tenant.configurationSet);
	} catch (error) {
		await updateRows("accounts", account, { set: { "ses.autoValidationFailedAt": new Date() } });
		await sendAlert({
			accountId: null,
			key: "ses-auto-validation",
			title: "SES Auto Validation not enabled",
			detail: `Account ${accountId}: ${error.message}. Its emails go out without it, and MailCheap tries again in an hour.`,
			path: "/admin",
		});
		return tenant;
	}
	const autoValidationAt = new Date();
	await updateRows("accounts", account, { set: { "ses.autoValidationAt": autoValidationAt } });
	return { ...tenant, autoValidationAt };
}

async function ensureTenant(account) {
	return ensureAutoValidation(account._id, getTenant(account) ?? (await provisionTenant(account._id)));
}

// MailCheap's own block is what holds an account on SES; SES pauses tenants itself (lib/tenant-events.js).
async function suspendTenant() {}

// After an admin unblocks an account that SES paused. REINSTATED lets it send while findings stay open.
async function resumeTenant(accountId) {
	const account = await getOne("SELECT _id, ses, pausedBy FROM accounts WHERE _id = ?", [String(accountId)]);
	const isPausedBySes = account?.pausedBy === "ses" || account?.ses?.tenantStatus === "DISABLED";
	if (!account?.ses?.tenantArn || !isPausedBySes) return false;
	await reinstateTenant(account.ses.tenantArn);
	await updateRows("accounts", { where: "_id = ?", params: [account._id] }, { set: { "ses.tenantStatus": "REINSTATED", "ses.tenantStatusAt": new Date() } });
	return true;
}

// Easy DKIM, and a custom MAIL FROM so SPF aligns with the domain.
const RETURN_PATH_PREFIX = "bounce";

function getMailFromDomain(domain) {
	return `${RETURN_PATH_PREFIX}.${domain}`;
}

async function addDomain({ account, domain }) {
	const { tenantName, configurationSet } = await ensureTenant(account);
	await createDomainIdentity(domain, { configurationSet, mailFromDomain: getMailFromDomain(domain) });
	await associateTenantResources(tenantName, { identities: [domain] });
	return { providerDomainId: null };
}

// Read fresh: SES has no budget on reads that matters here.
function readDomain({ domain }) {
	return getDomainIdentity(domain.domain);
}

async function removeDomain({ account, domain }) {
	if (account.ses?.tenantName) await dissociateTenantIdentity(account.ses.tenantName, domain.domain);
	await deleteDomainIdentity(domain.domain);
}

// SES's rate is one number for every customer and every kind of email (lib/send-rate.js).
function getSendLane() {
	return { name: "ses", rate: LIMITS.sendRatePerSecond };
}

// SES returns tags with every event, so a bounce or complaint always says which account it belongs to.
function getMessageTags(message) {
	const tags = [
		{ name: "message_id", value: String(message._id) },
		{ name: "account_id", value: String(message.accountId) },
		{ name: "kind", value: message.kind },
	];
	if (message.campaignId) tags.push({ name: "campaign_id", value: String(message.campaignId) });
	return tags;
}

async function sendEmail({ tenant, message, email, feedbackId }) {
	const { sesMessageId } = await sendSesEmail({
		...email,
		headers: { ...email.headers, "Feedback-ID": feedbackId },
		tags: getMessageTags(message),
		tenantName: tenant.tenantName,
		configurationSet: tenant.configurationSet,
	});
	return { providerMessageId: sesMessageId };
}

function describeTenant(account) {
	const tenant = getTenant(account);
	return tenant ? { id: tenant.tenantName, status: tenant.tenantStatus ?? null, detail: tenant.lastFinding ?? null } : null;
}

// An account's purge, once its identities are gone: the tenant and its configuration set.
async function removeTenant(account) {
	const { tenantName, configurationSet } = account.ses ?? {};
	if (tenantName) await deleteTenant(tenantName);
	if (configurationSet) await deleteConfigurationSet(configurationSet);
}

function isConfigured() {
	return Boolean(process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY);
}

export const sesProvider = Object.freeze({
	id: "ses",
	name: "Amazon SES",
	returnPathPrefix: RETURN_PATH_PREFIX,
	isConfigured,
	sendPlatformEmail: sendSesPlatformEmail,
	getTenant,
	provisionTenant,
	ensureTenant,
	suspendTenant,
	resumeTenant,
	describeTenant,
	removeTenant,
	getMailFromDomain,
	addDomain,
	readDomain,
	removeDomain,
	getSendLane,
	sendEmail,
});
