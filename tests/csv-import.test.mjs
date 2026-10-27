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
		firstName: null,
		lastName: null,
		name: null,
		status: "Status",
		subscribedAt: "Created At",
		emailsReceived: null,
		openRate: "Open Rate",
		clickRate: "Click Through Rate",
		language: null,
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

test("reads a language column, with the regions MailCheap tells apart, and leaves one it can't read empty", () => {
	for (const header of ["Language", "lang", "Locale", "Preferred language"]) {
		assert.equal(mapColumns(["Email", header]).language, header);
	}
	const columns = mapColumns(["email", "locale"]);
	assert.equal(normalizeImportRow({ email: "ana@example.com", locale: "pt_BR" }, columns).language, "pt-BR");
	assert.equal(normalizeImportRow({ email: "rui@example.com", locale: "pt_AO" }, columns).language, "pt");
	assert.equal(normalizeImportRow({ email: "jean@example.com", locale: "Français" }, columns).language, "fr");
	const unknown = normalizeImportRow({ email: "sam@example.com", locale: "Klingon" }, columns);
	assert.equal(unknown.email, "sam@example.com", "the row still goes in");
	assert.equal(unknown.language, undefined);
	assert.equal(sanitizeImportRow({ email: "ana@example.com", status: "active", language: "pt-BR" }).language, "pt-BR");
	assert.equal(sanitizeImportRow({ email: "ana@example.com", status: "active", language: "<b>" }).language, undefined);
});

test("reads first and last names, or splits a full name when there's no last name column", () => {
	const read = (headers, row) => {
		const { firstName, lastName } = normalizeImportRow({ email: "jane@example.com", ...row }, mapColumns(["email", ...headers]));
		return [firstName, lastName];
	};
	assert.deepEqual(read(["First Name", "Last Name"], { "First Name": " Jane ", "Last Name": "Doe" }), ["Jane", "Doe"]);
	assert.deepEqual(read(["fname", "surname"], { fname: "Jane", surname: "" }), ["Jane", undefined]);
	assert.deepEqual(read(["name", "last_name"], { name: "Jane", last_name: "Doe" }), ["Jane", "Doe"], "MailerLite's name is the first name");
	assert.deepEqual(read(["Full name"], { "Full name": "Jane  van Doe" }), ["Jane", "van Doe"], "a full name splits after its first word");
	assert.deepEqual(read(["name"], { name: "Cher" }), ["Cher", undefined]);
	assert.deepEqual(read(["name"], { name: "  " }), [undefined, undefined]);
	assert.deepEqual(read([], {}), [undefined, undefined]);
	assert.deepEqual(read(["first_name", "name"], { first_name: "Jane", name: "Jane Doe" }), ["Jane", undefined], "a first name column wins");
});

test("names are trimmed, cut to 100 characters and lose control characters, from the browser too", () => {
	assert.equal(sanitizeImportRow({ email: "a@example.com", status: "active", firstName: "Ana\u0000\tMa\u200bria\u202e" }).firstName, "Ana Maria");
	assert.equal(sanitizeImportRow({ email: "a@example.com", status: "active", lastName: "مهدی\u200cزاده" }).lastName, "مهدی\u200cزاده", "a zero-width non-joiner stays");
	assert.equal(sanitizeImportRow({ email: "a@example.com", status: "active", lastName: "x".repeat(300) }).lastName.length, 100);
	assert.equal(sanitizeImportRow({ email: "a@example.com", status: "active", firstName: "   " }).firstName, undefined);
	assert.equal(sanitizeImportRow({ email: "a@example.com", status: "active", firstName: 42 }).firstName, undefined);
	assert.equal(sanitizeImportRow({ email: "a@example.com", status: "active", lastName: "Jos\u0065\u0301" }).lastName, "José", "composed, as NFC");
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
		firstName: undefined,
		lastName: undefined,
		subscribedAt: undefined,
		emailsReceived: undefined,
		openRate: 1,
		clickRate: undefined,
		language: undefined,
	});
});
