import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers/d1.mjs";
const { getClientIp, isLimitedInMemory, isRateLimited } = await import("../lib/rate-limit.js");

const LOGIN = { name: "test-login", limit: 3, window: "15 m" };

async function countAllowed(options, attempts, limiter) {
	let allowed = 0;
	for (let attempt = 0; attempt < attempts; attempt += 1) if (!(await isRateLimited(options, limiter))) allowed += 1;
	return allowed;
}

test("without the Durable Object binding, limits still apply, counted in memory per key", async () => {
	const results = [];
	for (let attempt = 0; attempt < 4; attempt += 1) results.push(await isRateLimited({ ...LOGIN, key: "203.0.113.7" }));
	assert.deepEqual(results, [false, false, false, true]);
	assert.equal(await isRateLimited({ ...LOGIN, key: "203.0.113.8" }), false, "other visitors keep their own count");
	assert.equal(await isRateLimited({ ...LOGIN, name: "test-other", key: "203.0.113.7" }), false, "and other limits");
});

test("a Durable Object error falls back to memory instead of letting everything through", async (t) => {
	t.mock.method(console, "error", () => {});
	const failing = { hit: async () => Promise.reject(new Error("Durable Object reset")) };
	assert.equal(await countAllowed({ ...LOGIN, key: "198.51.100.3" }, 5, failing), 3);
	assert.equal(await countAllowed({ ...LOGIN, key: "198.51.100.4" }, 5, failing), 3);

	const reports = console.error.mock.calls.filter(({ arguments: [message] }) => /unavailable, counting in memory/.test(message));
	assert.equal(reports.length, 1, "an outage is reported at most every 30 minutes, not on every request");
});

test("the Durable Object decides while it's up, with the window in milliseconds", async () => {
	const windows = [];
	const allowing = { hit: async (limit, windowMs) => (windows.push([limit, windowMs]), false) };
	const refusing = { hit: async () => true };
	assert.equal(await countAllowed({ ...LOGIN, key: "198.51.100.5" }, 5, allowing), 5);
	assert.equal(await countAllowed({ ...LOGIN, key: "198.51.100.5" }, 2, refusing), 0);
	assert.deepEqual(windows[0], [3, 15 * 60_000]);
});

test("the client IP comes from Cloudflare, never from forwarded-for headers", () => {
	assert.equal(getClientIp(new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" })), "203.0.113.9");
	assert.equal(getClientIp(new Headers({ "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" })), "unknown");
});

test("memory limits open again once the window has passed", () => {
	const limits = { name: "test-window", limit: 2, window: "10 m" };
	const start = Date.parse("2026-10-09T12:00:00Z");
	assert.equal(isLimitedInMemory({ ...limits, key: "a" }, start), false);
	assert.equal(isLimitedInMemory({ ...limits, key: "a" }, start + 1000), false);
	assert.equal(isLimitedInMemory({ ...limits, key: "a" }, start + 2000), true);
	assert.equal(isLimitedInMemory({ ...limits, key: "a" }, start + 10 * 60_000 + 1000), false);
});
