export const APP_NAME = "MailCheap";
export const MIN_SECRET_LENGTH = 32;
export const SUPPORT_EMAIL = "hello@mailcheap.ai";
// MailCheap Cloud's own emails go out from a subdomain, so their sending reputation stays apart from mailcheap.ai's.
const CLOUD_SENDER = "hello@r.mailcheap.ai";

// MailCheap Cloud (mailcheap.ai) is this same code with MAILCHEAP_CLOUD=true: billing, the public site and its
// branding. Anything else is a self-hosted server: no billing, and only the allowlist signs in.
export function isCloud(env = process.env) {
	return env.MAILCHEAP_CLOUD === "true";
}

// Without them the cloud couldn't bill, and its own emails (sign-in codes, alerts) would have no way out.
const CLOUD_REQUIRED = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY"];

// BETTER_AUTH_SECRET signs sessions and, through keys derived from it, every link in sent emails, so a
// short one keeps the server from starting.
export function getConfigProblems(env = process.env) {
	const problems = [];
	if ((env.BETTER_AUTH_SECRET ?? "").length < MIN_SECRET_LENGTH) {
		problems.push(
			`BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters (generate one with: openssl rand -base64 48).`
		);
	}
	const missing = isCloud(env) ? CLOUD_REQUIRED.filter((name) => !String(env[name] ?? "").trim()) : [];
	if (missing.length > 0) {
		problems.push(
			`MAILCHEAP_CLOUD is true, so ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} to be set: the cloud bills through Stripe and sends its own emails through Resend.`
		);
	}
	return problems;
}

// Rotating it signs everyone out and breaks the unsubscribe, confirmation and tracking links in sent emails.
// Better Auth's cookies are named <prefix>.session_token (__Secure-<prefix>... over https). A name of MailCheap's
// own, so another Better Auth app on a parent domain (a cookie for .example.com) can't shadow its session.
export const AUTH_COOKIE_PREFIX = "mailcheap";

export function getAppSecret() {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) throw new Error("BETTER_AUTH_SECRET is required to sign sessions and links");
	return secret;
}

// From address of MailCheap's own emails (sign-in codes, alerts). A self-hosted server has no default: its
// EMAIL_FROM has to be on a domain its Resend account or email provider verified.
export function getEmailFrom(env = process.env) {
	const from = String(env.EMAIL_FROM ?? "").trim();
	if (from) return from;
	return isCloud(env) ? `${APP_NAME} <${CLOUD_SENDER}>` : null;
}

// Replies to MailCheap Cloud's own emails reach support; a self-hosted server leaves them to EMAIL_FROM.
export function getEmailReplyTo(env = process.env) {
	return isCloud(env) ? SUPPORT_EMAIL : null;
}

function readList(value) {
	return String(value ?? "")
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
}

export function getAdminEmails(env = process.env) {
	return readList(env.ADMIN_EMAILS);
}

// RATE_LIMITS=add_domain=50,send_test_email=100: an action's calls in its window, instead of its default. Entries
// that aren't an action name and a whole number above 0 are ignored.
export function getRateLimitOverrides(env = process.env) {
	const overrides = new Map();
	for (const entry of readList(env.RATE_LIMITS)) {
		const [name, value] = entry.split("=").map((part) => part.trim());
		if (/^[a-z_]+$/.test(name ?? "") && /^[1-9]\d*$/.test(value ?? "")) overrides.set(name, Number(value));
	}
	return overrides;
}

// Who signs in to a self-hosted server: ALLOWED_EMAILS (addresses, and @example.com for a whole domain) and
// ADMIN_EMAILS. Nobody else, so with both empty nobody does. MailCheap Cloud takes anyone.
export function isEmailAllowed(email, env = process.env) {
	if (isCloud(env)) return true;
	const address = String(email ?? "").trim().toLowerCase();
	const at = address.lastIndexOf("@");
	if (at < 1 || at === address.length - 1) return false;
	const domain = address.slice(at);
	return [...readList(env.ALLOWED_EMAILS), ...getAdminEmails(env)].some((entry) => entry === address || entry === domain);
}

export function isSendingEnabled() {
	return process.env.SENDING_ENABLED === "true";
}

export const EMAIL_PROVIDER_IDS = ["postshiba", "ses"];

// Customer emails go through PostShiba once its key is set, else Amazon SES. EMAIL_PROVIDER picks one
// explicitly; anything else is null, and sending refuses to guess.
export function getEmailProviderId(env = process.env) {
	const id = String(env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
	if (!id) return env.POSTSHIBA_API_KEY ? "postshiba" : "ses";
	return EMAIL_PROVIDER_IDS.includes(id) ? id : null;
}

// Alchemy sets APP_URL to the Worker's domain on deploy; local dev falls back to localhost.
export function getAppUrl() {
	return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

export function getAppHost() {
	return new URL(getAppUrl()).host.toLowerCase();
}

// Customers without their own domain send from hello@<slug>.<shared domain>, a subdomain in their own tenant,
// and get <slug>.<shared domain> for their archive and links. Unset, newsletters send from a domain of their
// own, and links and archives stay on APP_URL until that domain's archive subdomain points here.
export function getSharedDomain() {
	return String(process.env.SHARED_DOMAIN ?? "").trim().toLowerCase() || null;
}

// What a customer's archive subdomain points at with a CNAME.
export function getArchiveCnameTarget() {
	return String(process.env.ARCHIVE_CNAME_TARGET ?? "").trim().toLowerCase() || null;
}

// The SES account's rate, shared by every customer and every kind of email through one Durable Object
// (lib/pacing.js): a new production account starts at 14 emails/s. Keep it below the account's actual rate.
function readSendRate() {
	const rate = Number.parseInt(process.env.SEND_RATE_PER_SECOND, 10);
	return Number.isInteger(rate) && rate >= 1 && rate <= 1000 ? rate : 14;
}

// Hard bounces and spam complaints out of emails sent (lib/rate-levels.js), each level with a minimum count so one
// complaint or a few bounces never stop anything. pause: a campaign pauses and its owner is warned. block: clear
// abuse, the whole account stops until an admin unblocks it; 0.3% is Gmail's spam rate line, 5% where SES reviews.
export const LIMITS = {
	pause: { bounceRate: 0.02, minBounces: 5, complaintRate: 0.0008, minComplaints: 2 },
	block: { bounceRate: 0.05, minBounces: 10, complaintRate: 0.003, minComplaints: 3 },
	maxEmailBytes: 100_000,
	get sendRatePerSecond() {
		return readSendRate();
	},
	welcomeEmailsPer10Minutes: 100,
};
