import assert from "node:assert/strict";
import { test } from "node:test";
import {
	mapColumns,
	normalizeImportRow,
	normalizeRate,
	normalizeStatus,
	sanitizeImportRow,
} from "../lib/csv-import.js";

test("maps common export headers", () => {
	const columns = mapColumns(["Email", "Status", "Created At", "Open Rate", "Click Through Rate"]);
	assert.deepEqual(columns, {
		email: "Email",
		status: "Status",
		subscribedAt: "Created At",
		emailsReceived: null,
		openRate: "Open Rate",
		clickRate: "Click Through Rate",
		unsubscribedAt: null,
		cleanedAt: null,
		subscribedToEmails: null,
		emailDisabled: null,
	});
});

test("maps statuses and never guesses active for unknown values", () => {
	assert.equal(normalizeStatus("active"), "active");
	assert.equal(normalizeStatus("inactive"), "unsubscribed");
	assert.equal(normalizeStatus("Invalid"), "bounced");
	assert.equal(normalizeStatus("pending"), "dormant");
	assert.equal(normalizeStatus("something-new"), "dormant");
	assert.equal(normalizeStatus(""), "active");
});

test("normalizes rates written as percents or fractions", () => {
	assert.equal(normalizeRate("45.5%"), 0.455);
	assert.equal(normalizeRate("45.5"), 0.455);
	assert.equal(normalizeRate("0.3"), 0.3);
	assert.equal(normalizeRate(""), undefined);
	assert.equal(normalizeRate("abc"), undefined);
	assert.equal(normalizeRate("250%"), 1);
});

test("normalizes a row and applies a stricter status override only", () => {
	const columns = mapColumns(["email", "status", "created_at"]);
	const active = normalizeImportRow(
		{ email: " Jane@Example.com ", status: "active", created_at: "2024-01-02" },
		columns,
		{ status: "dormant" }
	);
	assert.equal(active.email, "jane@example.com");
	assert.equal(active.status, "dormant");
	assert.equal(active.subscribedAt, new Date("2024-01-02").toISOString());

	const unsubscribed = normalizeImportRow({ email: "reader@example.com", status: "inactive" }, columns, {
		status: "dormant",
	});
	assert.equal(unsubscribed.status, "unsubscribed");
	assert.equal(normalizeImportRow({ email: "not-an-email" }, columns), null);
});

test("sanitizes rows coming from the browser", () => {
	assert.equal(sanitizeImportRow({ email: "reader@example.com", status: "admin" }), null);
	assert.equal(sanitizeImportRow({ email: "reader@example.com", status: "__proto__" }), null);
	assert.equal(sanitizeImportRow(null), null);

	const row = sanitizeImportRow({
		email: "Reader@Example.com",
		status: "active",
		subscribedAt: "nope",
		openRate: 7,
		clickRate: -1,
	});
	assert.deepEqual(row, {
		email: "reader@example.com",
		status: "active",
		subscribedAt: undefined,
		emailsReceived: undefined,
		openRate: 1,
		clickRate: undefined,
	});
});
