import assert from "node:assert/strict";
import { test } from "node:test";
import { database, newsletterId, seedNewsletter } from "./helpers/d1.mjs";
const { importContactRows } = await import("../lib/contact-import.js");
const { getOne } = await import("../lib/db.js");

test("imports preserve existing opt-outs and confirmation state, and only strengthen status", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	const contacts = [
		{ email: "new@example.com", status: "active", subscribedAt: "2026-10-08T09:00:00Z", openRate: 0.5 },
		{ email: "left@example.com", status: "unsubscribed" },
		{ email: "cold@example.com", status: "dormant", emailsReceived: 9, openRate: 0, clickRate: 0 },
	];
	assert.deepEqual(await importContactRows({ newsletterId, rows: contacts, db }), { created: 3, existing: 0, invalid: 0 });
	const left = await getOne("SELECT * FROM contacts WHERE email = ?", ["left@example.com"], db);
	assert.equal(left.status, "unsubscribed");
	assert.ok(left.unsubscribedAt instanceof Date);
	const initial = await getOne("SELECT * FROM contacts WHERE email = ?", ["new@example.com"], db);
	assert.equal(initial.subscribedAt.toISOString(), "2026-10-08T09:00:00.000Z");
	const result = await importContactRows({ newsletterId, rows: [
		{ email: "left@example.com", status: "active" }, { email: "cold@example.com", status: "active" },
		{ email: "new@example.com", status: "unsubscribed", clickRate: 0.2 },
	], db });
	assert.deepEqual(result, { created: 0, existing: 3, invalid: 0 });
	assert.equal((await getOne("SELECT status FROM contacts WHERE email = ?", ["left@example.com"], db)).status, "unsubscribed");
	assert.equal((await getOne("SELECT status FROM contacts WHERE email = ?", ["cold@example.com"], db)).status, "dormant");
	assert.deepEqual((await getOne("SELECT imported FROM contacts WHERE email = ?", ["new@example.com"], db)).imported, { openRate: 0.5, clickRate: 0.2 });
	db.sqlite.prepare("UPDATE contacts SET status = 'pending' WHERE email = ?").run("cold@example.com");
	await importContactRows({ newsletterId, rows: [{ email: "cold@example.com", status: "active" }], db });
	assert.equal((await getOne("SELECT status FROM contacts WHERE email = ?", ["cold@example.com"], db)).status, "pending");
});

test("bounce and complaint imports suppress all newsletters and never downgrade a complaint", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	const other = "74f1a2b3c4d5e6f7a8b9c0d3";
	seedNewsletter(db, { _id: other, slug: "other" });
	await importContactRows({ newsletterId, rows: [{ email: "reader@example.com", status: "active" }], db });
	await importContactRows({ newsletterId: other, rows: [{ email: "reader@example.com", status: "complained" }], db });
	await importContactRows({ newsletterId, rows: [{ email: "reader@example.com", status: "bounced" }], db });
	assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM contacts WHERE status = 'complained'").get().count, 2);
	assert.equal(db.sqlite.prepare("SELECT reason FROM suppressions").get().reason, "complaint");
});

test("imports deduplicate valid rows and stay within D1 parameter bounds across batches", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	const rows = Array.from({ length: 100 }, (_, index) => ({ email: `reader${index}@example.com`, status: "bounced" }));
	rows.push({ email: "READER0@example.com", status: "complained" }, { email: "invalid" });
	assert.deepEqual(await importContactRows({ newsletterId, rows, db }), { created: 100, existing: 0, invalid: 2 });
	assert.equal(db.sqlite.prepare("SELECT reason FROM suppressions WHERE email = 'reader0@example.com'").get().reason, "complaint");
	assert.equal(db.maxBoundParameters, 10);
});

test("a failed transactional import batch cannot leave a suppression without its contact writes", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	db.sqlite.exec("CREATE TRIGGER fail_import BEFORE INSERT ON contacts BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
	await assert.rejects(importContactRows({ newsletterId, rows: [{ email: "reader@example.com", status: "bounced" }], db }), /injected failure/);
	assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM suppressions").get().count, 0);
});
