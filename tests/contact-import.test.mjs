import assert from "node:assert/strict";
import { test } from "node:test";
import { accountId, database, newsletterId, seedAccount, seedNewsletter } from "./helpers/d1.mjs";
const { importContactRows } = await import("../lib/contact-import.js");
const { getOne } = await import("../lib/db.js");
const { getLanguageTag } = await import("../lib/languages.js");

test("imports preserve existing opt-outs and confirmation state, and only strengthen status", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	const contacts = [
		{ email: "new@example.com", status: "active", subscribedAt: "2026-10-08T09:00:00Z", openRate: 0.5 },
		{ email: "left@example.com", status: "unsubscribed" },
		{ email: "cold@example.com", status: "dormant", emailsReceived: 9, openRate: 0, clickRate: 0 },
	];
	assert.deepEqual(await importContactRows({ accountId, newsletterId, rows: contacts, db }), { created: 3, existing: 0, invalid: 0 });
	const left = await getOne("SELECT * FROM contacts WHERE email = ?", ["left@example.com"], db);
	assert.equal(left.status, "unsubscribed");
	assert.ok(left.unsubscribedAt instanceof Date);
	const initial = await getOne("SELECT * FROM contacts WHERE email = ?", ["new@example.com"], db);
	assert.equal(initial.subscribedAt.toISOString(), "2026-10-08T09:00:00.000Z");
	const result = await importContactRows({ accountId, newsletterId, rows: [
		{ email: "left@example.com", status: "active" }, { email: "cold@example.com", status: "active" },
		{ email: "new@example.com", status: "unsubscribed", clickRate: 0.2 },
	], db });
	assert.deepEqual(result, { created: 0, existing: 3, invalid: 0 });
	assert.equal((await getOne("SELECT status FROM contacts WHERE email = ?", ["left@example.com"], db)).status, "unsubscribed");
	assert.equal((await getOne("SELECT status FROM contacts WHERE email = ?", ["cold@example.com"], db)).status, "dormant");
	assert.deepEqual((await getOne("SELECT imported FROM contacts WHERE email = ?", ["new@example.com"], db)).imported, { openRate: 0.5, clickRate: 0.2 });
	db.sqlite.prepare("UPDATE contacts SET status = 'pending' WHERE email = ?").run("cold@example.com");
	await importContactRows({ accountId, newsletterId, rows: [{ email: "cold@example.com", status: "active" }], db });
	assert.equal((await getOne("SELECT status FROM contacts WHERE email = ?", ["cold@example.com"], db)).status, "pending");
});

test("a file's language goes on new contacts and replaces an existing one's, and an empty cell clears nothing", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	const language = async (email) => getLanguageTag(await getOne("SELECT language, languageRegion FROM contacts WHERE email = ?", [email], db));
	await importContactRows({ accountId, newsletterId, rows: [
		{ email: "ana@example.com", status: "active", language: "pt-BR" },
		{ email: "sam@example.com", status: "active" },
	], db });
	assert.equal(await language("ana@example.com"), "pt-BR");
	assert.equal(await language("sam@example.com"), null);
	await importContactRows({ accountId, newsletterId, rows: [
		{ email: "ana@example.com", status: "active" },
		{ email: "sam@example.com", status: "unsubscribed", language: "fr" },
	], db });
	assert.equal(await language("ana@example.com"), "pt-BR", "an empty cell keeps it");
	assert.equal(await language("sam@example.com"), "fr");
	await importContactRows({ accountId, newsletterId, rows: [{ email: "ana@example.com", status: "active", language: "Español" }], db });
	assert.equal(await language("ana@example.com"), "es", "the region goes with the language it replaces");
});

test("bounce and complaint imports suppress all newsletters and never downgrade a complaint", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	const other = "74f1a2b3c4d5e6f7a8b9c0d3";
	seedNewsletter(db, { _id: other, slug: "other" });
	await importContactRows({ accountId, newsletterId, rows: [{ email: "reader@example.com", status: "active" }], db });
	await importContactRows({ accountId, newsletterId: other, rows: [{ email: "reader@example.com", status: "complained" }], db });
	await importContactRows({ accountId, newsletterId, rows: [{ email: "reader@example.com", status: "bounced" }], db });
	assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM contacts WHERE status = 'complained'").get().count, 2);
	assert.equal(db.sqlite.prepare("SELECT reason FROM suppressions").get().reason, "complaint");
});

test("imports deduplicate valid rows and stay within D1 parameter bounds however many rows", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	const rows = Array.from({ length: 1200 }, (_, index) => ({ email: `reader${index}@example.com`, status: "bounced" }));
	rows.push({ email: "READER0@example.com", status: "complained" }, { email: "invalid" });
	assert.deepEqual(await importContactRows({ accountId, newsletterId, rows, db }), { created: 1200, existing: 0, invalid: 2 });
	assert.equal(db.sqlite.prepare("SELECT reason FROM suppressions WHERE email = 'reader0@example.com'").get().reason, "complaint");
	assert.ok(db.maxBoundParameters <= 9, "the rows go in as one JSON parameter");
});

test("a failed transactional import batch cannot leave a suppression without its contact writes", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	db.sqlite.exec("CREATE TRIGGER fail_import BEFORE INSERT ON contacts BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
	await assert.rejects(importContactRows({ accountId, newsletterId, rows: [{ email: "reader@example.com", status: "bounced" }], db }), /injected failure/);
	assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM suppressions").get().count, 0);
});

test("rows add the contacts a newsletter doesn't have and only make statuses stricter", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	const subscribedAt = new Date("2026-10-08T09:00:00.000Z");
	const existing = ["new", "left", "left-too", "bounced", "cold"].map((name) => ({ email: `${name}@example.com`, status: "active" }));
	existing.push({ email: "waiting@example.com", status: "active" });
	await importContactRows({ accountId, newsletterId, rows: existing, db });
	db.sqlite.prepare("UPDATE contacts SET status = 'pending' WHERE email = ?").run("waiting@example.com");
	// Rows as sanitizeImportRow hands them over, one per status a CSV file can map to.
	const rows = [
		{ email: "new@example.com", status: "active", subscribedAt, openRate: 0.5 },
		{ email: "left@example.com", status: "unsubscribed" },
		{ email: "left-too@example.com", status: "unsubscribed" },
		{ email: "bounced@example.com", status: "bounced" },
		{ email: "cold@example.com", status: "dormant", emailsReceived: 9, openRate: 0, clickRate: 0 },
		{ email: "waiting@example.com", status: "unsubscribed" },
		{ email: "fresh@example.com", status: "dormant", subscribedAt },
	];
	assert.deepEqual(await importContactRows({ accountId, newsletterId, rows, source: "import", db }), { created: 1, existing: 6, invalid: 0 });
	const statuses = Object.fromEntries(db.sqlite.prepare("SELECT email, status FROM contacts").all().map(({ email, status }) => [email.split("@")[0], status]));
	assert.deepEqual(statuses, {
		new: "active", left: "unsubscribed", "left-too": "unsubscribed", bounced: "bounced", cold: "dormant", waiting: "pending", fresh: "dormant",
	});
	const fresh = await getOne("SELECT * FROM contacts WHERE email = ?", ["fresh@example.com"], db);
	assert.equal(fresh.subscribedAt.toISOString(), subscribedAt.toISOString());
	assert.equal(fresh.accountId, accountId);
	assert.equal((await getOne("SELECT * FROM contacts WHERE email = ?", ["new@example.com"], db)).imported.openRate, 0.5);
	assert.equal((await getOne("SELECT reason FROM suppressions WHERE accountId = ? AND email = ?", [accountId, "bounced@example.com"], db)).reason, "bounce");
});

test("an account's suppressions and imports don't reach another account's contacts", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	const otherAccount = seedAccount(db, { _id: "74f1a2b3c4d5e6f7a8b9c0ee" })._id;
	const otherNewsletter = "74f1a2b3c4d5e6f7a8b9c0ef";
	seedNewsletter(db, { _id: otherNewsletter, accountId: otherAccount, slug: "elsewhere" });
	await importContactRows({ accountId: otherAccount, newsletterId: otherNewsletter, rows: [{ email: "reader@example.com", status: "active" }], db });
	await importContactRows({ accountId, newsletterId, rows: [{ email: "reader@example.com", status: "complained" }], db });
	assert.equal((await getOne("SELECT status FROM contacts WHERE newsletterId = ?", [otherNewsletter], db)).status, "active");
	assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM suppressions WHERE accountId = ?").get(otherAccount).count, 0);
});
