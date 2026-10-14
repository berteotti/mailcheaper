import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { LIMITS } from "../lib/config.js";
import { waitForSendSlot } from "../lib/send-rate.js";
import { env } from "./helpers/bindings.mjs";

afterEach(() => {
	delete env.SES_PACER;
});

test("the SES rate comes from SEND_RATE_PER_SECOND, 14 by default", () => {
	process.env.SEND_RATE_PER_SECOND = "";
	assert.equal(LIMITS.sendRatePerSecond, 14);
	process.env.SEND_RATE_PER_SECOND = "40";
	assert.equal(LIMITS.sendRatePerSecond, 40);
	process.env.SEND_RATE_PER_SECOND = "0";
	assert.equal(LIMITS.sendRatePerSecond, 14);
});

test("concurrent sends in one instance are spaced at the rate", async () => {
	process.env.SEND_RATE_PER_SECOND = "20";
	await new Promise((resolve) => setTimeout(resolve, 100));
	const start = Date.now();
	await Promise.all(Array.from({ length: 5 }, () => waitForSendSlot()));
	assert.ok(Date.now() - start >= 190, "4 gaps of 50 ms");
});

test("every instance takes its slots from one pacer per lane, named as the shared limiter was", async () => {
	const names = [];
	const intervals = [];
	env.SES_PACER = {
		idFromName: (name) => (names.push(name), name),
		get: () => ({ reserve: async (intervalMs) => (intervals.push(intervalMs), 0) }),
	};
	await waitForSendSlot();
	await waitForSendSlot({ name: "postshiba-rest", rate: 4 });
	assert.deepEqual(names, ["mailcheap/ses-rate", "mailcheap/send-rate-postshiba-rest"]);
	assert.deepEqual(intervals, [Math.ceil(1000 / LIMITS.sendRatePerSecond), 250]);
});

test("a queue longer than 30 seconds throws a Throttling error before anything is sent", async () => {
	env.SES_PACER = { idFromName: (name) => name, get: () => ({ reserve: async () => 31_000 }) };
	await assert.rejects(waitForSendSlot(), { name: "Throttling" });
});

test("sends go on, spaced per instance, while the pacer is unreachable", async () => {
	process.env.SEND_RATE_PER_SECOND = "1000";
	let calls = 0;
	env.SES_PACER = { idFromName: (name) => name, get: () => ({ reserve: async () => { calls++; throw new Error("Durable Object reset"); } }) };
	const originalError = console.error;
	console.error = () => {};
	try {
		await waitForSendSlot();
		await waitForSendSlot();
	} finally {
		console.error = originalError;
	}
	assert.equal(calls, 2, "asked the pacer each time, and fell back to local spacing");
});
