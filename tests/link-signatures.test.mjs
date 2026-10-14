import assert from "node:assert/strict";
import { test } from "node:test";

process.env.BETTER_AUTH_SECRET = "s".repeat(40);

const { createUnsubscribeToken } = await import("../lib/unsubscribe.js");
const { getClickUrl, getOpenUrl } = await import("../lib/tracking.js");
const { createConfirmToken } = await import("../lib/confirmation.js");
const { createKeepToken } = await import("../lib/last-chance.js");

// The same values the open source signs with SESSION_SECRET = "s" x 40: each kind of link derives its own
// key from the secret, so changing how they're signed would break the links in emails already sent.
test("email links keep their signatures", () => {
	const ids = { contactId: "65f000000000000000000001", newsletterId: "65f000000000000000000002" };
	const at = Date.UTC(2026, 9, 1);
	assert.equal(
		createUnsubscribeToken(ids),
		"eyJjIjoiNjVmMDAwMDAwMDAwMDAwMDAwMDAwMDAxIiwibiI6IjY1ZjAwMDAwMDAwMDAwMDAwMDAwMDAwMiJ9.qxugCW39rqGI0TSWiaWjEWH-bVd71-Lb69vN7idQJ0k"
	);
	assert.equal(
		getOpenUrl("https://app.example.com", "65f000000000000000000003"),
		"https://app.example.com/o/65f000000000000000000003.JtU4g2LPPxg4mmeolrDvOn"
	);
	assert.equal(
		getClickUrl("https://app.example.com", "65f000000000000000000003", "https://example.com/a"),
		"https://app.example.com/c/65f000000000000000000003.52hwWaNiG9b4Z8RNRfq3tq.aHR0cHM6Ly9leGFtcGxlLmNvbS9h"
	);
	assert.equal(
		createConfirmToken(ids, at),
		"eyJjIjoiNjVmMDAwMDAwMDAwMDAwMDAwMDAwMDAxIiwibiI6IjY1ZjAwMDAwMDAwMDAwMDAwMDAwMDAwMiIsInQiOjE3OTA4MTI4MDB9.64ux5hwD5hvAyrvxgKpO5LcGY4XGxOzwRU0JVqsrxo8"
	);
	assert.equal(
		createKeepToken(ids, at),
		"eyJjIjoiNjVmMDAwMDAwMDAwMDAwMDAwMDAwMDAxIiwibiI6IjY1ZjAwMDAwMDAwMDAwMDAwMDAwMDAwMiIsInQiOjE3OTA4MTI4MDB9.TcO_u6bsrlsl-cZZJ66RGMD_-_bR92nFDSJSe638hYE"
	);
});
