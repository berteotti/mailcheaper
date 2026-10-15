import assert from "node:assert/strict";
import { test } from "node:test";
import { accountId, database, seedAccount, seedNewsletter } from "./helpers/d1.mjs";
const { buildAudiencePage, selectAudience } = await import("../lib/audience.js");

const newsletterId = "74f1a2b3c4d5e6f7a8b9c0d2";

function contact(id, fields = {}) {
	return {
		_id: id,
		email: `${id}@example.com`,
		status: "active",
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		...fields,
	};
}

const contacts = [
	contact("never-engaged"),
	contact("early-signup", { createdAt: new Date("2025-01-01T00:00:00.000Z") }),
	contact("imported-opener", { imported: { openRate: 0.6 } }),
	contact("imported-clicker", { imported: { clickRate: 0.1, openRate: 0.2 } }),
	contact("imported-top-clicker", { imported: { clickRate: 0.3, openRate: 0.1 } }),
	contact("opened-recently", { lastOpenAt: new Date("2026-09-30T00:00:00.000Z") }),
	contact("opened-in-march", { lastOpenAt: new Date("2026-03-01T00:00:00.000Z") }),
	contact("clicked-in-february", {
		lastClickAt: new Date("2026-02-01T00:00:00.000Z"),
		lastOpenAt: new Date("2026-02-01T00:00:00.000Z"),
	}),
	contact("clicked-recently", { lastClickAt: new Date("2026-09-01T00:00:00.000Z") }),
	contact("unsubscribed", { status: "unsubscribed", lastClickAt: new Date("2026-10-01") }),
	contact("bounced", { status: "bounced" }),
	contact("dormant", { status: "dormant" }),
	contact("suppressed", { lastClickAt: new Date("2026-10-02T00:00:00.000Z") }),
];
const suppressedEmails = ["suppressed@example.com"];

test("the audience is active, unsuppressed contacts, most engaged first", () => {
	const audience = selectAudience(contacts, { suppressedEmails });
	assert.deepEqual(
		audience.map(({ _id }) => _id),
		[
			"clicked-recently",
			"clicked-in-february",
			"opened-recently",
			"opened-in-march",
			"imported-top-clicker",
			"imported-clicker",
			"imported-opener",
			"early-signup",
			"never-engaged",
		]
	);
});

test("audienceLimit keeps the most engaged contacts", () => {
	const audience = selectAudience(contacts, { suppressedEmails, audienceLimit: 3 });
	assert.deepEqual(
		audience.map(({ _id }) => _id),
		["clicked-recently", "clicked-in-february", "opened-recently"]
	);
	for (const audienceLimit of [undefined, null, 0, -1, 2.5, "abc"]) {
		assert.equal(selectAudience(contacts, { suppressedEmails, audienceLimit }).length, 9);
	}
});

test("contacts with equal engagement keep a stable order", () => {
	const twins = [contact("b"), contact("a"), contact("c")];
	assert.deepEqual(
		selectAudience(twins).map(({ _id }) => _id),
		["a", "b", "c"]
	);
	assert.deepEqual(
		twins.map(({ _id }) => _id),
		["b", "a", "c"]
	);
});

function seedContacts(t) {
	const db = database(t);
	seedNewsletter(db, { _id: newsletterId });
	const insert = db.sqlite.prepare(`INSERT INTO contacts (_id, accountId, newsletterId, email, status, subscribedAt, lastOpenAt, lastClickAt,
		imported, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	// Same creation time for some, so the id has to break ties the way it does in selectAudience.
	contacts.forEach((row, index) => {
		const created = row.createdAt.getTime();
		insert.run(index.toString(16).padStart(24, "0"), accountId, newsletterId, row.email, row.status, created,
			row.lastOpenAt?.getTime() ?? null, row.lastClickAt?.getTime() ?? null, JSON.stringify(row.imported ?? {}), created, created);
	});
	db.sqlite.prepare("INSERT INTO suppressions (_id, accountId, email, reason, createdAt, updatedAt) VALUES (?, ?, ?, 'manual', 0, 0)")
		.run("f".repeat(24), accountId, suppressedEmails[0]);
	return db;
}

async function readPages(db, size) {
	const emails = [];
	let after = null;
	for (;;) {
		const { sql, params } = buildAudiencePage({ accountId, newsletterId, after, limit: size });
		const { results } = await db.prepare(sql).bind(...params).all();
		emails.push(...results.map(({ email }) => email));
		if (results.length < size) return emails;
		after = results.at(-1);
	}
}

test("the D1 query selects the same audience in the same order, page after page", async (t) => {
	const db = seedContacts(t);
	const expected = selectAudience(contacts, { suppressedEmails }).map(({ email }) => email);
	for (const size of [1, 2, 3, 100]) assert.deepEqual(await readPages(db, size), expected, `pages of ${size}`);
});

test("the D1 query takes the top of the audience up to a limit", async (t) => {
	const db = seedContacts(t);
	const { sql, params } = buildAudiencePage({ accountId, newsletterId, limit: 3 });
	const { results } = await db.prepare(sql).bind(...params).all();
	assert.deepEqual(results.map(({ email }) => email), selectAudience(contacts, { suppressedEmails, audienceLimit: 3 }).map(({ email }) => email));
});

test("only the account's own suppressions leave its contacts out", async (t) => {
	const db = seedContacts(t);
	const other = seedAccount(db, { _id: "74f1a2b3c4d5e6f7a8b9c0ff" })._id;
	db.sqlite.prepare("INSERT INTO suppressions (_id, accountId, email, reason, createdAt, updatedAt) VALUES (?, ?, ?, 'bounce', 0, 0)")
		.run("e".repeat(24), other, contacts[0].email);
	assert.deepEqual(await readPages(db, 100), selectAudience(contacts, { suppressedEmails }).map(({ email }) => email));
	const { sql, params } = buildAudiencePage({ accountId: other, newsletterId, limit: 100 });
	assert.deepEqual((await db.prepare(sql).bind(...params).all()).results, [], "another account reads none of them");
});
