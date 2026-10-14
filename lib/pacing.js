import { LIMITS } from "./config.js";
import { getBindings } from "./db.js";

// One coordinator per SES account and region paces every send: campaigns, signups, tests and alerts.
let nextSendAt = 0;

export function getSesRegion() {
	return process.env.SES_REGION || process.env.AWS_REGION || "us-east-1";
}

function reserveLocally(intervalMs, now = Date.now()) {
	const sendAt = Math.max(now, nextSendAt);
	nextSendAt = sendAt + intervalMs;
	return sendAt - now;
}

export async function waitForSendSlot() {
	const intervalMs = Math.ceil(1000 / LIMITS.sendRatePerSecond);
	const { SES_PACER } = await getBindings();
	const wait = SES_PACER
		? await SES_PACER.get(SES_PACER.idFromName(`ses:${getSesRegion()}`)).reserve(intervalMs)
		: reserveLocally(intervalMs);
	if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
