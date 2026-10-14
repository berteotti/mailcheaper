import { LIMITS } from "./config.js";
import { getBindings } from "./db.js";

// Each way of sending has one rate for every customer: a lane (SES's account rate, or PostShiba's bulk
// cluster and its REST send budget, lib/email-provider). One SesPacer Durable Object per lane hands out the
// slots, so every Worker and queue consumer shares one count. Without the binding (tests, scripts), or while
// the object can't be reached, each instance only spaces its own sends: concurrent instances could go over,
// and the provider throttles them (those sends are retried).
const MAX_WAIT_MS = 30_000;
const REPORT_EVERY_MS = 30 * 60_000;
const lanes = new Map();
let lastReportAt = 0;

function getLane(name) {
	if (!lanes.has(name)) lanes.set(name, { nextSendAt: 0 });
	return lanes.get(name);
}

// One object per lane, named as the shared limiter always was. SES keeps the prefix it always had.
export function getPacerName(name) {
	return name === "ses" ? "mailcheap/ses-rate" : `mailcheap/send-rate-${name}`;
}

// Slots are reserved synchronously, so concurrent sends in one instance share the rate.
function reserveLocally(lane, intervalMs) {
	const now = Date.now();
	const sendAt = Math.max(now, lane.nextSendAt);
	lane.nextSendAt = sendAt + intervalMs;
	return sendAt - now;
}

async function reserveShared(name, intervalMs) {
	const { SES_PACER } = await getBindings().catch(() => ({}));
	if (!SES_PACER) return null;
	try {
		return await SES_PACER.get(SES_PACER.idFromName(getPacerName(name))).reserve(intervalMs);
	} catch (error) {
		if (Date.now() - lastReportAt > REPORT_EVERY_MS) {
			lastReportAt = Date.now();
			console.error("[send-rate] Pacer unavailable, spacing sends per instance only:", error?.message);
		}
		return null;
	}
}

// Waits for the lane's next slot. A queue longer than MAX_WAIT_MS throws a Throttling error before anything is
// sent: the batch goes back to the outbox and tries again later (lib/sending-rules.js getSendErrorAction).
export async function waitForSendSlot({ name = "ses", rate = LIMITS.sendRatePerSecond } = {}) {
	const intervalMs = Math.ceil(1000 / rate);
	const wait = (await reserveShared(name, intervalMs)) ?? reserveLocally(getLane(name), intervalMs);
	if (wait > MAX_WAIT_MS) throw Object.assign(new Error("Every sending slot is taken, retrying later"), { name: "Throttling" });
	if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
