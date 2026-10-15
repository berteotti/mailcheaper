import "server-only";
import { randomUUID } from "node:crypto";
import { LIMITS, isSendingEnabled } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/credentials";
import { connectDb, getOne, getValue, statement } from "@/lib/db";
import { SEND_OUTCOMES, providerError } from "@/lib/email-provider/outcomes";
import {
	buildInjectMessage,
	buildSend,
	getInjectError,
	getInjectFailure,
	getRestSendError,
	getUniqueArgs,
	isBulkKind,
	toDomainStatus,
} from "@/lib/email-provider/postshiba-rules";
import * as postshiba from "@/lib/postshiba";
import { isRateLimited } from "@/lib/rate-limit";
import { updateRows, updateStatement } from "@/lib/records";
import { getEmailDomain } from "@/lib/sender-rules";
import { normalizeAddress } from "@/lib/validation";

// Under PostShiba's REST send budget (300 a minute per key, 600 per team), shared by every instance (lib/send-rate.js).
const REST_SENDS_PER_SECOND = 4;
// Domain checks share PostShiba's 60 an hour per key with new domains and credentials: each account gets a few,
// and a check within a minute of the last one answers what it found then.
const VERIFY_LIMIT = { name: "postshiba-verify", limit: 6, window: "1 h" };
const CHECK_CACHE_MS = 60_000;
const HOLD = "operator_hold";

// Lowercase letters, digits and dashes: the account id fits and never changes.
export function getTenantSlug(accountId) {
	return `mc-${accountId}`;
}

function credentialContext(accountId, clusterId) {
	return `postshiba-smtp:${accountId}:${clusterId}`;
}

function isCurrent(state, config) {
	return (
		Boolean(state?.provisionedAt) &&
		state.bulkCredential?.clusterId === config.bulkClusterId &&
		state.transactionalCredential?.clusterId === config.transactionalClusterId
	);
}

function getTenant(account) {
	return account?.postshiba?.provisionedAt ? account.postshiba : null;
}

// The account's PostShiba state with the bulk credential's encrypted password, which lives in account_secrets so
// that no other read of the account returns it.
function withPassword(postshiba, password) {
	const state = postshiba ?? {};
	if (!state.bulkCredential || !password) return state;
	return { ...state, bulkCredential: { ...state.bulkCredential, password } };
}

async function loadAccount(accountId) {
	const row = await getOne(
		`SELECT a._id, a.status, a.postshiba, s.postshibaPassword FROM accounts a
		LEFT JOIN account_secrets s ON s.accountId = a._id WHERE a._id = ?`,
		[String(accountId)]
	);
	return row && { ...row, postshiba: withPassword(row.postshiba, row.postshibaPassword) };
}

function readPassword(accountId) {
	return getValue("SELECT postshibaPassword FROM account_secrets WHERE accountId = ?", [String(accountId)]);
}

// Each step is saved as soon as it's done, so a failed attempt picks up where it stopped: an SMTP password is
// only ever shown once. A password goes to account_secrets, in the same transaction as the rest.
async function save(accountId, fields) {
	const id = String(accountId);
	const { password, ...bulkCredential } = fields.bulkCredential ?? {};
	const set = Object.fromEntries(
		Object.entries({ ...fields, ...(fields.bulkCredential && { bulkCredential }) }).map(([key, value]) => [`postshiba.${key}`, value])
	);
	const db = await connectDb();
	const now = Date.now();
	await db.batch([
		updateStatement(db, "accounts", { where: "_id = ?", params: [id] }, { set }),
		...(password
			? [
					statement(
						db,
						`INSERT INTO account_secrets (accountId, postshibaPassword, updatedAt) VALUES (?, ?, ?)
						ON CONFLICT(accountId) DO UPDATE SET postshibaPassword = excluded.postshibaPassword, updatedAt = excluded.updatedAt`,
						[id, password, now]
					),
				]
			: []),
	]);
	return (await loadAccount(id)).postshiba;
}

// A slug PostShiba already has is a tenant an earlier attempt created.
async function findOrCreateTenant(slug) {
	try {
		return await postshiba.createTenant({ name: slug, slug });
	} catch (error) {
		if (error.status !== 422) throw error;
		const tenant = (await postshiba.listTenants()).find((item) => item.slug === slug);
		if (!tenant) throw error;
		return tenant;
	}
}

async function issueBulkCredential(accountId, state, config) {
	const credential = await postshiba.createSmtpCredential({ clusterId: config.bulkClusterId, tenantId: state.tenantId });
	if (!credential?.password || !credential.username) throw new Error("PostShiba didn't return the SMTP credential's login");
	return save(accountId, {
		bulkCredential: {
			credentialId: credential.id,
			username: credential.username,
			password: await encryptSecret(credential.password, { context: credentialContext(accountId, config.bulkClusterId) }),
			clusterId: config.bulkClusterId,
		},
	});
}

// One tenant per account, with an SMTP credential on each cluster: inject needs the bulk one's login, and
// POST /sends needs a live credential on the transactional cluster, not its password. On a single cluster,
// the bulk credential is that live credential.
async function provisionTenant(accountId) {
	const config = postshiba.getPostshibaConfig();
	const account = await loadAccount(accountId);
	if (!account) throw new Error("Account not found");
	let state = account.postshiba ?? {};
	if (isCurrent(state, config) && state.bulkCredential?.password) return state;

	if (!state.tenantId) {
		const tenant = await findOrCreateTenant(getTenantSlug(account._id));
		state = await save(account._id, {
			tenantId: tenant.id,
			tenantSlug: tenant.slug,
			tenantStatus: tenant.suspended ? "suspended" : "active",
			tenantStatusAt: new Date(),
		});
	}
	// A bulk credential without its password (account_secrets lost it) is issued again: inject can't log in without it.
	if (state.bulkCredential?.clusterId !== config.bulkClusterId || !state.bulkCredential?.password) {
		state = await issueBulkCredential(account._id, state, config);
	}
	if (state.transactionalCredential?.clusterId !== config.transactionalClusterId) {
		const credentialId =
			config.transactionalClusterId === config.bulkClusterId
				? state.bulkCredential.credentialId
				: (await postshiba.createSmtpCredential({ clusterId: config.transactionalClusterId, tenantId: state.tenantId })).id;
		state = await save(account._id, { transactionalCredential: { credentialId, clusterId: config.transactionalClusterId } });
	}
	state = await save(account._id, { provisionedAt: state.provisionedAt ?? new Date() });
	// Blocked before its tenant existed: the tenant starts suspended too.
	if (account.status === "paused" && state.tenantStatus === "active") await suspendTenant(account._id);
	return state;
}

// Accounts come from reads that leave the password out: it's read from account_secrets here.
async function ensureTenant(account) {
	const config = postshiba.getPostshibaConfig();
	const state = getTenant(account);
	if (state && isCurrent(state, config)) {
		const password = state.bulkCredential?.password ?? (await readPassword(account._id));
		if (password) return withPassword(state, password);
	}
	return provisionTenant(account._id);
}

async function setTenantStatus(accountId, status) {
	// A hold stays until PostShiba lifts it: suspending on top of it doesn't hide it.
	const isSuspend = status === "suspended";
	await updateRows(
		"accounts",
		{
			where: `_id = ?${isSuspend ? " AND coalesce(json_extract(postshiba, '$.tenantStatus'), '') != ?" : ""}`,
			params: [String(accountId), ...(isSuspend ? [HOLD] : [])],
		},
		{ set: { "postshiba.tenantStatus": status, "postshiba.tenantStatusAt": new Date() } }
	);
}

async function findTenantId(accountId) {
	return (await getValue("SELECT json_extract(postshiba, '$.tenantId') FROM accounts WHERE _id = ?", [String(accountId)])) ?? null;
}

// With the account's block: nothing the tenant sends goes out, welcome and confirmation emails included.
async function suspendTenant(accountId) {
	const tenantId = await findTenantId(accountId);
	if (!tenantId) return;
	try {
		await postshiba.suspendTenant(tenantId);
	} catch (error) {
		if (error.providerCode !== HOLD) throw error;
		return setTenantStatus(accountId, HOLD);
	}
	await setTenantStatus(accountId, "suspended");
}

// PostShiba refuses while its abuse team holds the tenant; the account stays blocked with that reason.
async function resumeTenant(accountId) {
	const tenantId = await findTenantId(accountId);
	if (!tenantId) return false;
	try {
		await postshiba.resumeTenant(tenantId);
	} catch (error) {
		if (error.providerCode !== HOLD) throw error;
		await setTenantStatus(accountId, HOLD);
		throw providerError(SEND_OUTCOMES.tenantPaused, "PostShiba's abuse team holds this tenant (operator_hold): ask PostShiba support to lift it first", {
			hold: HOLD,
		});
	}
	await setTenantStatus(accountId, "active");
	return true;
}

function describeTenant(account) {
	const state = getTenant(account) ?? account?.postshiba;
	return state?.tenantId ? { id: state.tenantId, slug: state.tenantSlug, status: state.tenantStatus ?? null, detail: null } : null;
}

// An account's purge: any sending domain still in its tenant, then the tenant with its SMTP credentials.
async function removeTenant(account) {
	const tenantId = account.postshiba?.tenantId;
	if (!tenantId) return;
	const domains = (await postshiba.listSendingDomains()).filter((domain) => domain.tenant_id === tenantId);
	for (const domain of domains) await postshiba.deleteSendingDomain(domain.id);
	await postshiba.deleteTenant(tenantId);
}

// PostShiba owns MAIL FROM, at rp.<domain> once its CNAME is in.
const RETURN_PATH_PREFIX = "rp";

function getMailFromDomain(domain) {
	return `${RETURN_PATH_PREFIX}.${domain}`;
}

// A domain belongs to one tenant at PostShiba; a name it already has is one an earlier attempt created.
async function findOrCreateDomain({ name, tenantId }) {
	try {
		return await postshiba.createSendingDomain({ name, tenantId });
	} catch (error) {
		if (error.status !== 422) throw error;
		const domain = (await postshiba.listSendingDomains()).find((item) => item.name === name);
		if (!domain) throw error;
		if (domain.tenant_id !== tenantId) throw Object.assign(new Error(`${name} is set up at PostShiba for another tenant`), { code: "conflict" });
		return domain;
	}
}

async function addDomain({ account, domain }) {
	const tenant = await ensureTenant(account);
	const created = await findOrCreateDomain({ name: domain, tenantId: tenant.tenantId });
	return { providerDomainId: created.id, status: toDomainStatus(created) };
}

function isCheckedRecently(domain) {
	return domain.checkedAt && Date.now() - new Date(domain.checkedAt).getTime() < CHECK_CACHE_MS;
}

// verify asks PostShiba to look at DNS now, within each account's share of the verification budget. Otherwise,
// or past it, this reads the status PostShiba keeps checking on its own (30 s, 2 and 5 minutes, then every 5).
async function readDomain({ account, domain, verify = false }) {
	if (!domain.providerDomainId) return { missing: true };
	if (verify && isCheckedRecently(domain)) return { unchanged: true };
	const canVerify = verify && !(await isRateLimited({ ...VERIFY_LIMIT, key: String(account._id) }));
	try {
		const found = canVerify ? await postshiba.verifySendingDomain(domain.providerDomainId) : await postshiba.getSendingDomain(domain.providerDomainId);
		return toDomainStatus(found);
	} catch (error) {
		if (error.status === 404) return { missing: true };
		if (canVerify && error.status === 429) return readDomain({ account, domain, verify: false });
		return { error: error.message };
	}
}

function removeDomain({ domain }) {
	return domain.providerDomainId ? postshiba.deleteSendingDomain(domain.providerDomainId) : null;
}

// SEND_RATE_PER_SECOND paces the bulk cluster (its hourly cap / 3600); transactional mail paces under the REST budget.
function getSendLane(kind) {
	return isBulkKind(kind) ? { name: "postshiba-bulk", rate: LIMITS.sendRatePerSecond } : { name: "postshiba-rest", rate: REST_SENDS_PER_SECOND };
}

// A hold seen on a send is kept on the account, where the block that follows (lib/tenant-events.js) leaves it.
async function rejectSend(accountId, error) {
	if (error.hold) await setTenantStatus(accountId, HOLD);
	throw error;
}

async function injectBulk({ tenant, message, email }) {
	const credential = tenant.bulkCredential;
	const password = await decryptSecret(credential.password, { context: credentialContext(message.accountId, credential.clusterId) });
	let result;
	try {
		result = await postshiba.inject({ username: credential.username, password, message: buildInjectMessage({ email, uniqueArgs: getUniqueArgs(message) }) });
	} catch (error) {
		return rejectSend(message.accountId, getInjectError(error));
	}
	const failure = getInjectFailure(result);
	if (failure) return rejectSend(message.accountId, failure);
	return { providerMessageId: null };
}

// Idempotency-Key = the message id: a retry of the same email never sends it twice.
async function sendTransactional({ tenant, message, email }) {
	const { transactionalClusterId } = postshiba.getPostshibaConfig();
	let result;
	try {
		result = await postshiba.createSend({
			clusterId: transactionalClusterId,
			idempotencyKey: String(message._id),
			send: buildSend({ tenantId: tenant.tenantId, email, uniqueArgs: getUniqueArgs(message) }),
		});
	} catch (error) {
		return rejectSend(message.accountId, getRestSendError(error));
	}
	if (result?.suppressed?.length) throw providerError(SEND_OUTCOMES.suppressed, "PostShiba suppresses this address for the account");
	// /sends answers with the email's Message-ID, but PostShiba's events name the message by its own id
	// (sg_message_id): the first event fills it in, as for HTTP inject.
	return { providerMessageId: null };
}

const clusterCache = { value: null, expiresAt: 0 };

// The clusters' plans and caps, for the admin page: one, or the bulk and transactional ones. Kept 5 minutes; an
// error isn't kept.
export async function getClusters({ fresh = false } = {}) {
	if (!fresh && clusterCache.value && clusterCache.expiresAt > Date.now()) return clusterCache.value;
	try {
		const { bulkClusterId, transactionalClusterId } = postshiba.getPostshibaConfig();
		const isSingle = bulkClusterId === transactionalClusterId;
		const [bulk, transactional] = await Promise.all([
			postshiba.getCluster(bulkClusterId),
			isSingle ? null : postshiba.getCluster(transactionalClusterId),
		]);
		Object.assign(clusterCache, { value: { bulk, transactional: transactional ?? bulk, isSingle }, expiresAt: Date.now() + 5 * 60_000 });
		return clusterCache.value;
	} catch (error) {
		return { error: error.message };
	}
}

async function sendEmail({ tenant, message, email }) {
	if (!isSendingEnabled()) throw new Error("Sending is off (SENDING_ENABLED is not true)");
	return isBulkKind(message.kind) ? injectBulk({ tenant, message, email }) : sendTransactional({ tenant, message, email });
}

// MailCheap's own emails on a self-hosted server without Resend go through a tenant of their own, on the
// transactional cluster. A domain belongs to one tenant, so EMAIL_FROM's can't be a newsletter's.
const PLATFORM_TENANT_SLUG = "mc-platform";

async function findPlatformTenantId() {
	const tenant = (await postshiba.listTenants()).find(({ slug }) => slug === PLATFORM_TENANT_SLUG) ?? (await findOrCreateTenant(PLATFORM_TENANT_SLUG));
	return tenant.id;
}

async function sendAsPlatform(tenantId, email) {
	const result = await postshiba.createSend({
		clusterId: postshiba.getPostshibaConfig().transactionalClusterId,
		idempotencyKey: randomUUID(),
		send: buildSend({ tenantId, email, uniqueArgs: { kind: "platform" } }),
	});
	if (result?.suppressed?.length) throw new Error(`PostShiba suppresses ${email.to} for MailCheap's own emails`);
}

// The domain is added to the tenant the first time; until PostShiba verifies it, the error says what DNS needs.
async function explainPlatformError(error, { tenantId, email }) {
	if (error.providerCode !== "domain_unverified") return error;
	const name = getEmailDomain(normalizeAddress(email.from));
	const { records } = toDomainStatus(await findOrCreateDomain({ name, tenantId }));
	const needed = records.map(({ type, name: host, value }) => `${type} ${host} ${value}`).join(" and ");
	return new Error(`PostShiba can't send from ${name} yet: add ${needed} to its DNS. PostShiba checks it again within minutes.`);
}

// Its credential on the transactional cluster is created the first time PostShiba says it's missing.
async function sendPlatformEmail(email) {
	const tenantId = await findPlatformTenantId();
	try {
		return await sendAsPlatform(tenantId, email);
	} catch (error) {
		if (error.providerCode !== "credential_missing") throw await explainPlatformError(error, { tenantId, email });
	}
	await postshiba.createSmtpCredential({ clusterId: postshiba.getPostshibaConfig().transactionalClusterId, tenantId });
	try {
		return await sendAsPlatform(tenantId, email);
	} catch (error) {
		throw await explainPlatformError(error, { tenantId, email });
	}
}

function isConfigured() {
	try {
		postshiba.getPostshibaConfig();
		return true;
	} catch {
		return false;
	}
}

export const postshibaProvider = Object.freeze({
	id: "postshiba",
	name: "PostShiba",
	returnPathPrefix: RETURN_PATH_PREFIX,
	isConfigured,
	sendPlatformEmail,
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
