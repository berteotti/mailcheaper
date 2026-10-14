import assert from "node:assert/strict";
import test from "node:test";
import { getOne } from "../lib/db.js";
import { insertRow, updateOne } from "../lib/records.js";
import { accountId, database, seedAccount } from "./helpers/d1.mjs";

test("dotted $set, $unset and $inc paths change one field inside a JSON column", async (t) => {
	const db = database(t);
	seedAccount(db);
	const periodEnd = new Date("2026-11-14T12:00:00Z");
	const where = { where: "_id = ?", params: [accountId] };
	await updateOne("accounts", where, { set: { "usage.emailsSent": 5, "usage.periodEnd": periodEnd, "postshiba.bulkCredential.username": "u", plan: "growth" } });
	let account = await getOne("SELECT * FROM accounts WHERE _id = ?", [accountId]);
	assert.equal(account.plan, "growth");
	assert.equal(account.usage.emailsSent, 5);
	assert.deepEqual(account.usage.periodEnd, periodEnd);
	assert.equal(account.postshiba.bulkCredential.username, "u");

	account = await updateOne("accounts", where, { inc: { "usage.emailsSent": 2 }, unset: ["usage.periodEnd", "plan"], set: { spreadUntil: periodEnd, "onboarding.completedAt": periodEnd } });
	assert.equal(account.usage.emailsSent, 7);
	assert.equal(account.usage.periodEnd, undefined);
	assert.equal(account.plan, null);
	assert.deepEqual(account.spreadUntil, periodEnd);
	assert.deepEqual(account.onboarding.completedAt, periodEnd);
});

test("insertRow fills the id and timestamps and stores objects as JSON", async (t) => {
	const db = database(t);
	seedAccount(db);
	const row = await insertRow("domains", { accountId, domain: "example.com", mailFromDomain: "mail.example.com", archiveHost: "news.example.com", records: [{ type: "TXT" }], verified: true });
	assert.match(row._id, /^[0-9a-f]{24}$/);
	assert.equal(row.verified, true);
	assert.deepEqual(row.records, [{ type: "TXT" }]);
	assert.ok(row.createdAt instanceof Date);
});
