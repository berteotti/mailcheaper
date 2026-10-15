import { getBindings } from "./db.js";

// Limits are shared through one Durable Object per limiter name and key (worker/durable-objects.js).
// Without the binding, or while it fails, the same limits are counted in this Worker isolate's memory.
// Isolates don't share it, so it's weaker, but a script hammering one form still gets stopped.
const memory = new Map();
const MAX_MEMORY_KEYS = 10_000;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const REPORT_EVERY_MINUTES = 30;
let lastReportAt = 0;

async function getLimiter({ name, key }) {
	const { RATE_LIMITER } = await getBindings();
	return RATE_LIMITER ? RATE_LIMITER.get(RATE_LIMITER.idFromName(`${name}:${key}`)) : null;
}

// Windows read like "10 m" or "1 h".
function windowMs(window) {
	const [amount, unit] = String(window).trim().split(/\s+/);
	return Number(amount) * (UNIT_MS[unit] ?? Number.NaN);
}

export function isLimitedInMemory({ name, limit, window, key }, now = Date.now()) {
	const id = `${name}:${key}`;
	const hits = (memory.get(id) ?? []).filter((time) => now - time < windowMs(window));
	const isLimited = hits.length >= limit;
	if (!isLimited) hits.push(now);
	// Re-inserting keeps the Map in order of last use, so the oldest key goes first when it's full.
	memory.delete(id);
	memory.set(id, hits);
	if (memory.size > MAX_MEMORY_KEYS) memory.delete(memory.keys().next().value);
	return isLimited;
}

// Logged, and emailed when alerts are set up, at most every 30 minutes per server instance, so an
// outage doesn't write a line for every request. The email goes out after the response.
async function reportUnavailable(name, error) {
	if (Date.now() - lastReportAt < REPORT_EVERY_MINUTES * 60_000) return;
	lastReportAt = Date.now();
	console.error(`[rate-limit] ${name} unavailable, counting in memory:`, error.message);
	try {
		// Loaded on demand: alerts need Next.js and the database, which counting doesn't.
		const [{ after }, { sendAlert }] = await Promise.all([import("next/server"), import("./alerts.js")]);
		after(() =>
			sendAlert({
				key: "rate-limit-unavailable",
				title: "Rate limiter unavailable",
				detail: `The rate-limit Durable Object failed (${error.message}). Limits are counted in each Worker isolate's memory until it's back.`,
				cooldownMinutes: REPORT_EVERY_MINUTES,
			})
		);
	} catch (alertError) {
		console.error("[rate-limit] Alert failed:", alertError.message);
	}
}

// Cloudflare sets CF-Connecting-IP at its edge and overwrites any value a client sends. Forwarded-for
// headers are client-controlled before that, so they're never trusted.
export function getClientIp(headers) {
	return headers.get("cf-connecting-ip") || "unknown";
}

export async function isRateLimited({ name, limit, window, key }, limiter) {
	try {
		limiter ??= await getLimiter({ name, key });
		if (!limiter) return isLimitedInMemory({ name, limit, window, key });
		return Boolean(await limiter.hit(limit, windowMs(window)));
	} catch (error) {
		await reportUnavailable(name, error);
		return isLimitedInMemory({ name, limit, window, key });
	}
}
