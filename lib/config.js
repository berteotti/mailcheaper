export const APP_NAME = "Mailcheap";
export const MIN_SESSION_SECRET_LENGTH = 32;
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

// The admin password guards the only login, and SESSION_SECRET signs sessions and every email link,
// so short ones keep the server from starting and the dashboard from logging in.
export function getConfigProblems(env = process.env) {
	const problems = [];
	if ((env.SESSION_SECRET ?? "").length < MIN_SESSION_SECRET_LENGTH) {
		problems.push(
			`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters (generate one with: openssl rand -base64 48).`
		);
	}
	if ((env.ADMIN_PASSWORD ?? "").length < MIN_ADMIN_PASSWORD_LENGTH) {
		problems.push(`ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`);
	}
	return problems;
}

export function isSendingEnabled() {
	return process.env.SENDING_ENABLED === "true";
}

// Alchemy sets APP_URL to the Worker's domain on deploy; local dev falls back to localhost.
export function getAppUrl() {
	return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

// New SES accounts in production start at 14 emails/s, shared by every send through one Durable Object
// (lib/pacing.js). Keep it below the account's actual SES rate.
function readSendRate() {
	const rate = Number.parseInt(process.env.SEND_RATE_PER_SECOND, 10);
	return Number.isInteger(rate) && rate >= 1 && rate <= 14 ? rate : 10;
}

// SES reviews an account at 5% bounces or 0.1% complaints; pause well before that.
export const LIMITS = {
	bounceRate: 0.02,
	complaintRate: 0.0008,
	maxEmailBytes: 100_000,
	sendRatePerSecond: readSendRate(),
	welcomeEmailsPer10Minutes: 100,
};
