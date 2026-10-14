import { isCloud } from "./config.js";

// A new account's campaigns go out over hours instead of minutes: its first over 24, the next two over 16 and 12,
// then each over 8 until 30 days after the first. If a list is bad, its bounces and complaints show in the first
// batches, and the automatic block (lib/account-blocks.js) stops the rest before most of it leaves. Mailbox
// providers and the email provider's hourly caps also see a new sender's volume grow gradually.
export const SEND_SPREAD = { firstHours: [24, 16, 12], hours: 8, days: 30 };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The account's first 30 days of sending, from its first campaign.
export function getSpreadEnd(from = new Date()) {
	return new Date(from.getTime() + SEND_SPREAD.days * DAY_MS);
}

// Whether the account's sends are spread, as the 8 hours of its later campaigns, or 0. Self-hosted servers send at
// full speed, and so does an account past its first 30 days or let go early by an admin (spreadUntil in the past).
export function getSpreadMs(account, now = new Date(), env = process.env) {
	if (!isCloud(env)) return 0;
	const until = account?.spreadUntil ? new Date(account.spreadUntil) : null;
	return until && until <= now ? 0 : SEND_SPREAD.hours * HOUR_MS;
}

// place: how many of the account's campaigns started before this one.
export function getSpreadHours(place) {
	return SEND_SPREAD.firstHours[place] ?? SEND_SPREAD.hours;
}

// For the dashboard and the API docs: "the first over 24 hours, the next two over 16 and 12, then each over 8".
export function describeSpreadHours() {
	const [first, second, third] = SEND_SPREAD.firstHours;
	return `the first over ${first} hours, the next two over ${second} and ${third}, then each over ${SEND_SPREAD.hours}`;
}

// Where the account is in its warm-up, for the dashboard; null once it sends at full speed. Before its first
// campaign it hasn't started: that campaign starts the 30 days. nextHours: what its next campaign goes out over.
export function getWarmup(account, { place = 0, now = new Date(), env = process.env } = {}) {
	if (!getSpreadMs(account, now, env)) return null;
	const total = { days: SEND_SPREAD.days, hours: SEND_SPREAD.hours, firstHours: SEND_SPREAD.firstHours, nextHours: getSpreadHours(place) };
	if (!account?.spreadUntil) return { ...total, hasStarted: false, day: 0, progress: 0, endsAt: null };
	const endsAt = new Date(account.spreadUntil);
	const elapsed = Math.max(0, now.getTime() - (endsAt.getTime() - SEND_SPREAD.days * DAY_MS));
	return {
		...total,
		hasStarted: true,
		day: Math.min(SEND_SPREAD.days, Math.floor(elapsed / DAY_MS) + 1),
		progress: Math.min(1, elapsed / (SEND_SPREAD.days * DAY_MS)),
		endsAt: endsAt.toISOString(),
	};
}

// When each batch may start, in Unix seconds: the first right away, the others evenly over the spread.
export function getBatchStarts(count, spreadMs, now = Date.now()) {
	return Array.from({ length: count }, (_, index) => (spreadMs && index > 0 ? Math.floor((now + (index * spreadMs) / count) / 1000) : null));
}
