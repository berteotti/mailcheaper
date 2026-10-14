import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { decryptSecret, encryptSecret } from "../lib/credentials.js";
import { SEND_OUTCOMES } from "../lib/email-provider/outcomes.js";
import {
	buildInjectMessage,
	buildSend,
	encodeHeader,
	getInjectError,
	getInjectFailure,
	getRestSendError,
	getRetryAfter,
	getUniqueArgs,
	isBulkKind,
	toDomainStatus,
} from "../lib/email-provider/postshiba-rules.js";

const KEY = crypto.randomBytes(32);
const env = { CREDENTIALS_ENCRYPTION_KEY: KEY.toString("base64") };
const context = { context: "postshiba-smtp:64f1a2b3c4d5e6f7a8b9c0d1:BuLk01" };

test("SMTP passwords are stored encrypted, open only with the key and their own account, and never twice the same", () => {
	const stored = encryptSecret("once-only-password", context, env);
	assert.match(stored, /^v1\.[\w-]{16}\.[\w-]{22}\.[\w-]+$/);
	assert.ok(!stored.includes("once-only-password"));
	assert.notEqual(encryptSecret("once-only-password", context, env), stored, "a new IV every time");
	assert.equal(decryptSecret(stored, context, env), "once-only-password");
	assert.equal(decryptSecret(stored, context, { CREDENTIALS_ENCRYPTION_KEY: KEY.toString("hex") }), "once-only-password", "hex works too");

	assert.throws(() => decryptSecret(stored, { context: "postshiba-smtp:74f1a2b3c4d5e6f7a8b9c0d2:BuLk01" }, env), /belongs to another account/);
	assert.throws(() => decryptSecret(stored, context, { CREDENTIALS_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64") }), /doesn't decrypt/);
	const [version, iv, tag, data] = stored.split(".");
	const flipped = `${data.slice(0, -2)}${data.at(-2) === "A" ? "B" : "A"}${data.at(-1)}`;
	assert.throws(() => decryptSecret([version, iv, tag, flipped].join("."), context, env), /doesn't decrypt/, "tampering is caught");
	assert.throws(() => decryptSecret(`${version}.${iv}.${tag.slice(0, 8)}.${data}`, context, env), /doesn't decrypt/, "short tags are refused");
	assert.throws(() => decryptSecret("plaintext", context, env), /Not an encrypted credential/);

	for (const value of ["", "short", crypto.randomBytes(16).toString("base64"), crypto.randomBytes(48).toString("base64")]) {
		assert.throws(() => encryptSecret("x", context, { CREDENTIALS_ENCRYPTION_KEY: value }), /must be 32 random bytes/, value);
	}
});

test("PostShiba domains show their two CNAMEs, with statuses in the Domains page's words", () => {
	const domain = {
		name: "mail.example.com",
		dkim_status: "verified",
		return_path_status: "pending",
		sending_allowed: false,
		dkim_manual: false,
		dkim_cname_host: "ps1._domainkey.mail.example.com",
		dkim_cname_target: "HsVtYk.customers.postshiba.com",
		return_path_host: "rp.mail.example.com",
		return_path_target: "rp.postshiba.com",
		last_verification_error: "rp.mail.example.com has no CNAME",
	};
	assert.deepEqual(toDomainStatus(domain), {
		verified: false,
		dkimStatus: "SUCCESS",
		mailFromStatus: "PENDING",
		records: [
			{ purpose: "dkim", type: "CNAME", name: "ps1._domainkey.mail.example.com", value: "HsVtYk.customers.postshiba.com" },
			{ purpose: "mail-from", type: "CNAME", name: "rp.mail.example.com", value: "rp.postshiba.com" },
		],
		lastError: "rp.mail.example.com has no CNAME",
	});
	assert.equal(toDomainStatus({ ...domain, return_path_status: "verified", sending_allowed: true }).verified, true);
	assert.equal(toDomainStatus({ ...domain, dkim_status: "failed" }).dkimStatus, "FAILED");
	assert.equal(toDomainStatus({ ...domain, dkim_status: "something-new" }).dkimStatus, "PENDING");
});

const email = {
	from: '"Field Notes" <hello@field-notes.mailcheapmail.com>',
	to: "reader@example.org",
	replyTo: "jane@example.com",
	subject: "Issue 12",
	html: "<p>Use {{ name }} in Jinja</p>",
	text: "Use {{ name }} in Jinja",
	headers: { "List-Unsubscribe": "<https://field-notes.mailcheapmail.com/api/unsubscribe?token=t>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
};
const message = { _id: "74f1a2b3c4d5e6f7a8b9c0d2", accountId: "64f1a2b3c4d5e6f7a8b9c0d1", kind: "campaign", campaignId: "84f1a2b3c4d5e6f7a8b9c0d3" };

test("campaigns are injected with the account and message in unique args, our unsubscribe headers and no templating", () => {
	const uniqueArgs = getUniqueArgs(message);
	assert.deepEqual(uniqueArgs, { account_id: message.accountId, message_id: message._id, kind: "campaign", campaign_id: message.campaignId });
	assert.deepEqual(getUniqueArgs({ ...message, kind: "welcome", campaignId: undefined }), { account_id: message.accountId, message_id: message._id, kind: "welcome" });

	const injected = buildInjectMessage({ email, uniqueArgs });
	assert.equal(injected.envelope_sender, "hello@field-notes.mailcheapmail.com");
	assert.deepEqual(injected.recipients, [{ email: "reader@example.org" }]);
	assert.equal(injected.template_dialect, "Static", "{{ in an issue stays as written");
	assert.equal(injected.content.html_body, email.html);
	assert.equal(injected.content.text_body, email.text);
	assert.deepEqual(injected.content.headers, {
		From: email.from,
		Subject: "Issue 12",
		"Reply-To": "jane@example.com",
		...email.headers,
		"X-Capsule-Unique-Args": JSON.stringify(uniqueArgs),
	});
	assert.equal(injected.content.headers.To, undefined, "the To header comes from the recipient");
	assert.equal(buildInjectMessage({ email: { ...email, from: "hi@example.com", replyTo: undefined }, uniqueArgs }).content.headers["Reply-To"], undefined);
});

test("a send's issues and last-chance emails go on the bulk cluster, signup and test emails on the transactional one", () => {
	const kinds = ["campaign", "last-chance", "welcome", "confirmation", "test"];
	assert.deepEqual(kinds.map(isBulkKind), [true, true, false, false, false]);
});

test("transactional emails go to POST /sends for the tenant", () => {
	const send = buildSend({ tenantId: "WbLcFd", email, uniqueArgs: getUniqueArgs({ ...message, kind: "test" }) });
	assert.deepEqual(send, {
		tenant: "WbLcFd",
		from: email.from,
		to: ["reader@example.org"],
		reply_to: "jane@example.com",
		subject: "Issue 12",
		html: email.html,
		text: email.text,
		headers: email.headers,
		unique_args: { account_id: message.accountId, message_id: message._id, kind: "test", campaign_id: message.campaignId },
	});
});

test("non-ASCII subjects are encoded words of 75 characters at most, decoding to the subject", () => {
	assert.equal(encodeHeader("Plain subject"), "Plain subject");
	const subject = "Résumé de la semaine — café, crème brûlée et 🍰 pour tout le monde, encore une fois";
	const encoded = encodeHeader(subject);
	const words = encoded.split(" ");
	assert.ok(words.every((word) => /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(word) && word.length <= 75), encoded);
	const decoded = words.map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join("");
	assert.equal(decoded, subject);
});

function postshibaError(status, body = {}, extra = {}) {
	return { status, providerCode: body.error ?? null, detail: body.message ?? "", retryable: body.retryable ?? null, message: `PostShiba: ${status}`, ...extra };
}

test("POST /sends errors become outcomes: a full cluster retries at the next hour, approval and holds pause", () => {
	const at = new Date("2026-10-12T10:45:00Z");
	assert.equal(getRetryAfter("This cluster hit its hourly send limit", at), 15 * 60 + 60);
	assert.equal(getRetryAfter("This cluster hit its 24-hour send limit", at), 3600);

	const hourly = getRestSendError(postshibaError(429, { error: "throttled", message: "This cluster hit its hourly send limit" }));
	assert.equal(hourly.outcome, SEND_OUTCOMES.throttled);
	assert.ok(hourly.retryAfter > 60 && hourly.retryAfter <= 3660);
	assert.equal(getRestSendError(postshibaError(429, { error: "throttled", message: "This cluster hit its 24-hour send limit" })).retryAfter, 3600);
	assert.deepEqual(
		{ ...getRestSendError(postshibaError(429, { error: "rate_limited" })) },
		{ name: "ProviderError", outcome: SEND_OUTCOMES.throttled, retryAfter: 60, providerCode: "rate_limited" }
	);
	assert.equal(getRestSendError(postshibaError(429, { error: "throttled" }, { retryAfter: 42 })).retryAfter, 42, "Retry-After wins");

	const kyc = getRestSendError(postshibaError(403, { error: "kyc_required" }));
	assert.equal(kyc.outcome, SEND_OUTCOMES.approvalPending);
	assert.match(kyc.message, /hasn't approved production sending/);
	assert.equal(getRestSendError(postshibaError(403, { error: "suppressed" })).outcome, SEND_OUTCOMES.suppressed);
	assert.equal(getRestSendError(postshibaError(403, { error: "domain_unverified" })).outcome, SEND_OUTCOMES.domainUnverified);
	assert.equal(getRestSendError(postshibaError(403, { error: "domain_suspended" })).outcome, SEND_OUTCOMES.domainUnverified);
	const hold = getRestSendError(postshibaError(403, { error: "operator_hold" }));
	assert.deepEqual([hold.outcome, hold.hold], [SEND_OUTCOMES.tenantPaused, "operator_hold"]);
	assert.equal(getRestSendError(postshibaError(403, { error: "tenant_suspended" })).hold, undefined);
	assert.equal(getRestSendError(postshibaError(403, { error: "tenant_suspended" })).outcome, SEND_OUTCOMES.tenantPaused);
	assert.equal(getRestSendError(postshibaError(403, { error: "credential_missing" })).outcome, SEND_OUTCOMES.misconfigured);
	assert.equal(getRestSendError(postshibaError(401, { error: "Invalid token or no user signed in" })).outcome, SEND_OUTCOMES.misconfigured);
	assert.equal(getRestSendError(postshibaError(404, { error: "team_mismatch" })).outcome, SEND_OUTCOMES.misconfigured);

	assert.equal(getRestSendError(postshibaError(503, { error: "inject_unavailable", retryable: true })).outcome, SEND_OUTCOMES.unavailable);
	assert.equal(getRestSendError(postshibaError(502, { error: "inject_failed", retryable: true })).outcome, SEND_OUTCOMES.unavailable);
	assert.equal(getRestSendError(postshibaError(502, { error: "inject_failed", retryable: false })).outcome, SEND_OUTCOMES.failed);
	assert.equal(getRestSendError(postshibaError(502, { error: "inject_timeout_unknown" })).outcome, SEND_OUTCOMES.failed, "may have been queued");
	assert.equal(getRestSendError(postshibaError(409, { error: "idempotency_outcome_unknown" })).outcome, SEND_OUTCOMES.failed);
	assert.equal(getRestSendError(postshibaError(409, { error: "idempotency_in_progress" })).retryAfter, 15);
	assert.equal(getRestSendError(postshibaError(422, { error: "invalid", field: "headers" })).outcome, SEND_OUTCOMES.failed);
	assert.equal(getRestSendError(postshibaError(null, {}, { isTimeout: true })).outcome, SEND_OUTCOMES.unavailable, "the key makes a retry safe");
	assert.equal(getRestSendError(postshibaError(500)).outcome, SEND_OUTCOMES.unavailable);
});

test("inject errors only retry what certainly wasn't sent", () => {
	assert.equal(getInjectError(postshibaError(null, {}, { isTimeout: true })).outcome, SEND_OUTCOMES.failed);
	assert.match(getInjectError(postshibaError(null, {}, { isTimeout: true })).message, /may have gone out/);
	assert.equal(getInjectError(postshibaError(null, {}, { message: "fetch failed" })).outcome, SEND_OUTCOMES.unavailable);
	assert.equal(getInjectError(postshibaError(401)).outcome, SEND_OUTCOMES.misconfigured);
	const hourly = getInjectError(postshibaError(429, {}, { detail: "429 hourly send limit reached" }));
	assert.equal(hourly.outcome, SEND_OUTCOMES.throttled);
	assert.ok(hourly.retryAfter > 60);
	assert.equal(getInjectError(postshibaError(429, {}, { detail: "429 daily send limit reached" })).retryAfter, 3600);
	assert.equal(getInjectError(postshibaError(503)).outcome, SEND_OUTCOMES.unavailable);
	assert.equal(getInjectError(postshibaError(500)).outcome, SEND_OUTCOMES.failed);
	assert.equal(getInjectError(postshibaError(550, {}, { detail: "550 kyc_required" })).outcome, SEND_OUTCOMES.approvalPending);

	assert.equal(getInjectFailure({ success_count: 1, fail_count: 0, failed_recipients: [], errors: [] }), null);
	const failure = (errors) => getInjectFailure({ success_count: 0, fail_count: 1, failed_recipients: ["reader@example.org"], errors });
	assert.equal(failure(["550 suppressed"]).outcome, SEND_OUTCOMES.suppressed);
	assert.equal(failure(["550 unverified domain"]).outcome, SEND_OUTCOMES.domainUnverified);
	assert.equal(failure(["550 from header not aligned with verified domain"]).outcome, SEND_OUTCOMES.domainUnverified);
	assert.equal(failure(["550 kyc_required"]).outcome, SEND_OUTCOMES.approvalPending);
	assert.deepEqual([failure(["550 operator_hold"]).outcome, failure(["550 operator_hold"]).hold], [SEND_OUTCOMES.tenantPaused, "operator_hold"]);
	assert.equal(failure(["550 sending disabled"]).outcome, SEND_OUTCOMES.tenantPaused);
	assert.equal(failure(["550 firewall: disposable"]).outcome, SEND_OUTCOMES.failed);
	assert.equal(failure([]).outcome, SEND_OUTCOMES.failed);
});
