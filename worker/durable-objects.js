import { DurableObject } from "cloudflare:workers";

// Reservations are made one at a time inside the object, so concurrent consumers and requests share
// one send rate. It lives in memory: after the object is evicted, pacing simply starts again.
export class SesPacer extends DurableObject {
	nextSendAt = 0;

	reserve(intervalMs) {
		const now = Date.now();
		const sendAt = Math.max(now, this.nextSendAt);
		this.nextSendAt = sendAt + Math.max(1, Number(intervalMs) || 100);
		return sendAt - now;
	}
}

// One object per limiter name and key: a sliding window of at most `limit` stored hits, removed by an
// alarm once the window has passed since the last hit.
export class RateLimiter extends DurableObject {
	async hit(limit, windowMs) {
		const now = Date.now();
		const hits = ((await this.ctx.storage.get("hits")) ?? []).filter((time) => now - time < windowMs);
		const isLimited = hits.length >= limit;
		if (!isLimited) hits.push(now);
		await this.ctx.storage.put("hits", hits);
		await this.ctx.storage.setAlarm(now + windowMs);
		return isLimited;
	}

	async alarm() {
		await this.ctx.storage.deleteAll();
	}
}
