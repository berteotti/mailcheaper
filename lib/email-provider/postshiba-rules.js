import { CAMPAIGN_MESSAGE_KINDS } from "../sending-rules.js";
import { SEND_OUTCOMES, providerError } from "./outcomes.js";

// A send's issues and last-chance emails go out on the bulk cluster: last-chance emails reach the least engaged
// contacts, so they stay off the transactional IP that welcome, confirmation and test emails use.
export function isBulkKind(kind) {
	return CAMPAIGN_MESSAGE_KINDS.includes(kind);
}

const DOMAIN_STATUSES = { verified: "SUCCESS", pending: "PENDING", failed: "FAILED" };

// A PostShiba sending domain in the shape lib/domains.js stores: statuses in the SES words the Domains page
// already knows, and the two records to add.
export function toDomainStatus(domain) {
	const dkim = domain.dkim_manual
		? { purpose: "dkim", type: "TXT", name: domain.dkim_cname_host, value: domain.dkim_txt }
		: { purpose: "dkim", type: "CNAME", name: domain.dkim_cname_host, value: domain.dkim_cname_target };
	const returnPath = { purpose: "mail-from", type: "CNAME", name: domain.return_path_host, value: domain.return_path_target };
	return {
		verified: Boolean(domain.sending_allowed),
		dkimStatus: DOMAIN_STATUSES[domain.dkim_status] ?? "PENDING",
		mailFromStatus: DOMAIN_STATUSES[domain.return_path_status] ?? "PENDING",
		records: [dkim, returnPath].filter(({ name, value }) => name && value),
		lastError: domain.last_verification_error ?? null,
	};
}

// RFC 2047 for non-ASCII header text, in encoded words of at most 75 characters.
export function encodeHeader(value) {
	const text = String(value ?? "");
	if (/^[\x20-\x7e]*$/.test(text)) return text;
	const words = [];
	let chunk = "";
	for (const character of text) {
		if (Buffer.byteLength(chunk + character) > 45) {
			words.push(chunk);
			chunk = "";
		}
		chunk += character;
	}
	if (chunk) words.push(chunk);
	return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join(" ");
}

function getAddress(from) {
	return /<([^<>]+)>\s*$/.exec(from)?.[1] ?? from;
}

// HTTP inject. Bodies and headers would be Jinja templates otherwise: "Static" keeps a {{ in an issue as written.
// The To header comes from the recipient.
export function buildInjectMessage({ email, uniqueArgs }) {
	return {
		envelope_sender: getAddress(email.from),
		content: {
			text_body: email.text,
			html_body: email.html,
			headers: {
				From: email.from,
				Subject: encodeHeader(email.subject),
				...(email.replyTo && { "Reply-To": email.replyTo }),
				...email.headers,
				"X-Capsule-Unique-Args": JSON.stringify(uniqueArgs),
			},
		},
		recipients: [{ email: email.to }],
		template_dialect: "Static",
	};
}

// POST /sends on the transactional cluster.
export function buildSend({ tenantId, email, uniqueArgs }) {
	return {
		tenant: tenantId,
		from: email.from,
		to: [email.to],
		...(email.replyTo && { reply_to: email.replyTo }),
		subject: email.subject,
		html: email.html,
		text: email.text,
		headers: email.headers,
		unique_args: uniqueArgs,
	};
}

// Unique args come back on every webhook event: 32 scalar keys at most.
export function getUniqueArgs(message) {
	return {
		account_id: String(message.accountId),
		message_id: String(message._id),
		kind: message.kind,
		...(message.campaignId && { campaign_id: String(message.campaignId) }),
	};
}

// The hourly cap frees up at the next hour, the 24-hour cap as the oldest sends roll off.
export function getRetryAfter(text, now = new Date()) {
	if (/24-hour|daily/i.test(text)) return 3600;
	if (/hour/i.test(text)) return 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds()) + 60;
	return 300;
}

const REST_OUTCOMES = {
	throttled: SEND_OUTCOMES.throttled,
	rate_limited: SEND_OUTCOMES.throttled,
	idempotency_in_progress: SEND_OUTCOMES.throttled,
	suppressed: SEND_OUTCOMES.suppressed,
	domain_unverified: SEND_OUTCOMES.domainUnverified,
	domain_suspended: SEND_OUTCOMES.domainUnverified,
	dbl_listed: SEND_OUTCOMES.domainUnverified,
	kyc_required: SEND_OUTCOMES.approvalPending,
	operator_hold: SEND_OUTCOMES.tenantPaused,
	cluster_not_ready: SEND_OUTCOMES.misconfigured,
	credential_missing: SEND_OUTCOMES.misconfigured,
	team_suspended: SEND_OUTCOMES.misconfigured,
	forbidden: SEND_OUTCOMES.misconfigured,
	inject_unavailable: SEND_OUTCOMES.unavailable,
	idempotency_unavailable: SEND_OUTCOMES.unavailable,
};

const MESSAGES = {
	[SEND_OUTCOMES.approvalPending]: "PostShiba hasn't approved production sending yet (kyc_required)",
	[SEND_OUTCOMES.suppressed]: "PostShiba suppresses this address for the account",
};

function retryAfterFor(error, text) {
	if (error.retryAfter) return error.retryAfter;
	if (error.providerCode === "rate_limited") return 60;
	if (error.providerCode === "idempotency_in_progress") return 15;
	return getRetryAfter(text);
}

function toProviderError(outcome, error, text) {
	const message = MESSAGES[outcome] ?? error.message;
	return providerError(outcome, message, {
		...(outcome === SEND_OUTCOMES.throttled && { retryAfter: retryAfterFor(error, text) }),
		...(/operator_hold/i.test(text) && { hold: "operator_hold" }),
		providerCode: error.providerCode ?? null,
	});
}

// POST /sends carries an Idempotency-Key, so whatever didn't certainly fail can go again: a retry replays
// the first answer. A cluster that may have queued it (inject_timeout_unknown) is never asked twice.
function getRestStatusOutcome(status) {
	if (status === 401 || status === 404) return SEND_OUTCOMES.misconfigured;
	if (status === 429) return SEND_OUTCOMES.throttled;
	if (!status || status >= 500) return SEND_OUTCOMES.unavailable;
	return SEND_OUTCOMES.failed;
}

const UNKNOWN_REST_OUTCOMES = ["inject_timeout_unknown", "idempotency_outcome_unknown", "idempotency_conflict"];

export function getRestSendError(error) {
	const text = `${error.providerCode ?? ""} ${error.detail ?? ""} ${error.message ?? ""}`;
	const code = error.providerCode ?? "";
	let outcome = Object.hasOwn(REST_OUTCOMES, code) ? REST_OUTCOMES[code] : null;
	if (!outcome && code === "inject_failed") outcome = error.retryable ? SEND_OUTCOMES.unavailable : SEND_OUTCOMES.failed;
	// Never asked twice, and ambiguous: the cluster may have queued it, and its events settle the message.
	if (!outcome && UNKNOWN_REST_OUTCOMES.includes(code)) return Object.assign(toProviderError(SEND_OUTCOMES.failed, error, text), { ambiguous: true });
	if (!outcome && /suspend/i.test(code)) outcome = SEND_OUTCOMES.tenantPaused;
	return toProviderError(outcome ?? getRestStatusOutcome(error.status), error, text);
}

const INJECT_TEXT_OUTCOMES = [
	[/suppress/i, SEND_OUTCOMES.suppressed],
	[/kyc_required/i, SEND_OUTCOMES.approvalPending],
	[/operator_hold|sending disabled/i, SEND_OUTCOMES.tenantPaused],
	[/unverified domain|not aligned|domain_suspended|domain_unverified|dbl/i, SEND_OUTCOMES.domainUnverified],
	[/send limit|throttl/i, SEND_OUTCOMES.throttled],
	[/authentication|credential/i, SEND_OUTCOMES.misconfigured],
];

function getInjectTextOutcome(text) {
	for (const [pattern, outcome] of INJECT_TEXT_OUTCOMES) if (pattern.test(text)) return outcome;
	return null;
}

// HTTP inject has no idempotency: an answer that never came may still have queued the email, so only a
// clear "nothing was sent" goes again.
export function getInjectError(error) {
	const text = `${error.providerCode ?? ""} ${error.detail ?? ""}`;
	if (!error.status) {
		const outcome = error.isTimeout ? SEND_OUTCOMES.failed : SEND_OUTCOMES.unavailable;
		const message = error.isTimeout ? "PostShiba didn't answer in time; the email may have gone out" : error.message;
		// A timeout is ambiguous: never sent again, and settled by the message's events if it went out.
		return providerError(outcome, message, { providerCode: null, ...(error.isTimeout && { ambiguous: true }) });
	}
	if (error.status === 401) {
		return providerError(SEND_OUTCOMES.misconfigured, "PostShiba refused the account's SMTP credential (401)", { providerCode: null });
	}
	if (error.status === 429) return toProviderError(SEND_OUTCOMES.throttled, error, text);
	if (error.status === 503) return toProviderError(SEND_OUTCOMES.unavailable, error, text);
	return toProviderError(getInjectTextOutcome(text) ?? SEND_OUTCOMES.failed, error, text);
}

// An inject that answered 200 but didn't take the recipient.
export function getInjectFailure(result) {
	if (result?.success_count > 0 && !result.fail_count) return null;
	const text = (Array.isArray(result?.errors) ? result.errors.join("; ") : "") || "PostShiba didn't take the recipient";
	const error = { message: `PostShiba inject: ${text.slice(0, 200)}`, detail: text, providerCode: null };
	return toProviderError(getInjectTextOutcome(text) ?? SEND_OUTCOMES.failed, error, text);
}
