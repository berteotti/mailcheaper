import assert from "node:assert/strict";
import { test } from "node:test";
import { accountId, database, newsletterId, seedNewsletter } from "./helpers/d1.mjs";
const { execute, getOne, newId } = await import("../lib/db.js");
const { confirmContact, keepContact, upsertContact, unsubscribeContact } = await import("../lib/contacts.js");
const { getSubscriberHistory, getHourlySends, getEmailStats } = await import("../lib/overview-data.js");
const { importContactRows } = await import("../lib/contact-import.js");

test("contact signup and confirmation preserve IDs, idempotency and suppression precedence", async (t) => {
	const db = database(t);
	const newsletter = { ...seedNewsletter(db, { requireConfirmation: true }), requireConfirmation: true };
	const first = await upsertContact({ newsletter, email: "reader@example.com", source: "website", resubscribe: true });
	assert.match(first.contact._id, /^[a-f0-9]{24}$/);
	assert.equal(first.created, true);
	assert.equal(first.contact.status, "pending");
	const again = await upsertContact({ newsletter, email: "reader@example.com", source: "website", resubscribe: true });
	assert.equal(again.created, false);
	assert.equal(again.contact._id, first.contact._id);
	const reference = { accountId, contactId: first.contact._id, newsletterId };
	assert.equal((await confirmContact(reference)).confirmed, true);
	assert.equal((await confirmContact(reference)).confirmed, false);
	await execute("INSERT INTO suppressions (_id, accountId, email, reason, createdAt, updatedAt) VALUES (?, ?, ?, 'complaint', ?, ?)", [newId(), accountId, first.contact.email, Date.now(), Date.now()]);
	assert.equal(await keepContact(reference), null);
	assert.equal((await upsertContact({ newsletter, email: first.contact.email, resubscribe: true })).contact.status, "complained");
});

test("unsubscribing credits the latest reached campaign atomically and once", async (t) => {
	const db = database(t);
	const newsletter = seedNewsletter(db);
	const { contact } = await upsertContact({ newsletter, email: "reader@example.com" });
	const campaignId = newId();
	const now = Date.now();
	await execute("INSERT INTO campaigns (_id, accountId, newsletterId, startedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)", [campaignId, accountId, newsletterId, now, now, now]);
	await execute("INSERT INTO messages (_id, accountId, kind, campaignId, newsletterId, contactId, email, sentAt, createdAt, updatedAt) VALUES (?, ?, 'campaign', ?, ?, ?, ?, ?, ?, ?)", [newId(), accountId, campaignId, newsletterId, contact._id, contact.email, now, now, now]);
	const reference = { contactId: contact._id, newsletterId };
	assert.equal(await unsubscribeContact(reference), true);
	assert.equal(await unsubscribeContact(reference), false);
	assert.equal((await getOne("SELECT stats FROM campaigns WHERE _id = ?", [campaignId])).stats.unsubscribed, 1);
	assert.equal((await getOne("SELECT status FROM contacts WHERE _id = ?", [contact._id])).status, "unsubscribed");
});

test("subscriber history respects unknown import dates, confirmation dates, opt-outs and timezones", async (t) => {
	const db = database(t);
	const newsletter = seedNewsletter(db);
	const now = new Date("2026-10-26T12:00:00Z");
	await importContactRows({ accountId, newsletterId, rows: [
		{ email: "old@example.com", status: "active", subscribedAt: "2026-01-01" },
		{ email: "unknown@example.com", status: "active" },
		{ email: "left-before-import@example.com", status: "unsubscribed" },
	], db });
	const { contact } = await upsertContact({ newsletter, email: "confirmed@example.com" });
	await execute("UPDATE contacts SET subscribedAt = ?, confirmedAt = ?, createdAt = ? WHERE _id = ?", [new Date("2026-01-01"), new Date("2026-10-25T22:30:00Z"), new Date("2026-01-01"), contact._id]);
	const history = await getSubscriberHistory({ accountId, newsletterId, timeZone: "Europe/Paris", now });
	assert.equal(history.total, 3);
	assert.equal(history.current.find(({ key }) => key === "2026-10-25").joined, 1, "confirmation lands in the correct local day after DST");
	assert.equal(history.current.find(({ key }) => key === "2026-10-26").joined, 0);
});

test("hourly sends combine the repeated DST hour, and period statistics preserve message and campaign kinds", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	const now = new Date("2026-10-25T12:00:00Z");
	const campaignId = newId();
	await execute("INSERT INTO campaigns (_id, accountId, newsletterId, startedAt, stats, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[campaignId, accountId, newsletterId, now, JSON.stringify({ sent: 7, delivered: 6, opened: 4, clicked: 2, bounced: 1, complained: 0 }), now, now]);
	for (const [kind, sentAt] of [["welcome", "2026-10-25T00:30:00Z"], ["test", "2026-10-25T01:30:00Z"]]) {
		await execute("INSERT INTO messages (_id, accountId, kind, newsletterId, email, sentAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[newId(), accountId, kind, newsletterId, "reader@example.com", new Date(sentAt), now, now]);
	}
	const hours = await getHourlySends({ accountId, newsletterId, timeZone: "Europe/Paris", now });
	assert.equal(hours[2].today, 2);
	const stats = await getEmailStats({ accountId, newsletterId, now });
	assert.equal(stats.current.sent, 8, "the test email is excluded from campaign/welcome stats");
	assert.equal(stats.current.delivered, 6);
	assert.equal(stats.previous.sent, 0);
});

test("added by hand with consent skips confirmation; resubscribing brings back an opt-out; suppressions stay per account", async (t) => {
	const db = database(t);
	const newsletter = { ...seedNewsletter(db, { requireConfirmation: true }), requireConfirmation: true };
	const at = new Date("2026-10-14T12:00:00Z");
	const { contact } = await upsertContact({ newsletter, email: "jane@example.com", source: "dashboard", consent: { userId: "user-1", at } });
	assert.equal(contact.status, "active");
	assert.deepEqual(contact.consent, { userId: "user-1", at });
	await unsubscribeContact({ contactId: contact._id, newsletterId });
	assert.equal((await upsertContact({ newsletter, email: "jane@example.com" })).contact.status, "unsubscribed", "only an explicit resubscribe");
	const back = await upsertContact({ newsletter, email: "jane@example.com", resubscribe: true });
	assert.equal(back.contact.status, "pending", "back through the confirmation email");
	assert.equal(back.contact.unsubscribedAt, null);

	const other = "74f1a2b3c4d5e6f7a8b9c0aa";
	db.sqlite.prepare("INSERT INTO accounts (_id, ownerId, createdAt, updatedAt) VALUES (?, 'other', 0, 0)").run(other);
	await execute("INSERT INTO suppressions (_id, accountId, email, reason, createdAt, updatedAt) VALUES (?, ?, ?, 'bounce', 0, 0)", [newId(), other, "sam@example.com"]);
	assert.equal((await upsertContact({ newsletter, email: "sam@example.com" })).contact.status, "pending");
	await execute("INSERT INTO suppressions (_id, accountId, email, reason, createdAt, updatedAt) VALUES (?, ?, ?, 'bounce', 0, 0)", [newId(), accountId, "kim@example.com"]);
	assert.equal((await upsertContact({ newsletter, email: "kim@example.com", resubscribe: true })).contact.status, "bounced");
});

test("batches started together each run whole, like D1's", async (t) => {
	const db = database(t);
	const tables = (name) => [db.prepare("SELECT name FROM sqlite_master WHERE name = ?").bind(name), db.prepare("PRAGMA index_list('contacts')")];
	const [first, second] = await Promise.all([db.batch(tables("contacts")), db.batch(tables("campaigns"))]);
	assert.deepEqual([first[0].results[0].name, second[0].results[0].name], ["contacts", "campaigns"]);
});
