import assert from "node:assert/strict";
import { test } from "node:test";
import { database, newsletterId, seedNewsletter } from "./helpers/d1.mjs";
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
	const reference = { contactId: first.contact._id, newsletterId };
	assert.equal((await confirmContact(reference)).confirmed, true);
	assert.equal((await confirmContact(reference)).confirmed, false);
	await execute("INSERT INTO suppressions (_id, email, reason, createdAt, updatedAt) VALUES (?, ?, 'complaint', ?, ?)", [newId(), first.contact.email, Date.now(), Date.now()]);
	assert.equal(await keepContact(reference), null);
	assert.equal((await upsertContact({ newsletter, email: first.contact.email, resubscribe: true })).contact.status, "complained");
});

test("unsubscribing credits the latest reached campaign atomically and once", async (t) => {
	const db = database(t);
	const newsletter = seedNewsletter(db);
	const { contact } = await upsertContact({ newsletter, email: "reader@example.com" });
	const campaignId = newId();
	const now = Date.now();
	await execute("INSERT INTO campaigns (_id, newsletterId, startedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)", [campaignId, newsletterId, now, now, now]);
	await execute("INSERT INTO messages (_id, kind, campaignId, newsletterId, contactId, email, sentAt, createdAt, updatedAt) VALUES (?, 'campaign', ?, ?, ?, ?, ?, ?, ?)", [newId(), campaignId, newsletterId, contact._id, contact.email, now, now, now]);
	const reference = { contactId: contact._id, newsletterId };
	await unsubscribeContact(reference);
	await unsubscribeContact(reference);
	assert.equal((await getOne("SELECT stats FROM campaigns WHERE _id = ?", [campaignId])).stats.unsubscribed, 1);
	assert.equal((await getOne("SELECT status FROM contacts WHERE _id = ?", [contact._id])).status, "unsubscribed");
});

test("subscriber history respects unknown import dates, confirmation dates, opt-outs and timezones", async (t) => {
	const db = database(t);
	const newsletter = seedNewsletter(db);
	const now = new Date("2026-10-26T12:00:00Z");
	await importContactRows({ newsletterId, rows: [
		{ email: "old@example.com", status: "active", subscribedAt: "2026-01-01" },
		{ email: "unknown@example.com", status: "active" },
		{ email: "left-before-import@example.com", status: "unsubscribed" },
	], db });
	const { contact } = await upsertContact({ newsletter, email: "confirmed@example.com" });
	await execute("UPDATE contacts SET subscribedAt = ?, confirmedAt = ?, createdAt = ? WHERE _id = ?", [new Date("2026-01-01"), new Date("2026-10-25T22:30:00Z"), new Date("2026-01-01"), contact._id]);
	const history = await getSubscriberHistory({ newsletterId, timeZone: "Europe/Paris", now });
	assert.equal(history.total, 3);
	assert.equal(history.current.find(({ key }) => key === "2026-10-25").joined, 1, "confirmation lands in the correct local day after DST");
	assert.equal(history.current.find(({ key }) => key === "2026-10-26").joined, 0);
});

test("hourly sends combine the repeated DST hour, and period statistics preserve message and campaign kinds", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	const now = new Date("2026-10-25T12:00:00Z");
	const campaignId = newId();
	await execute("INSERT INTO campaigns (_id, newsletterId, startedAt, stats, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
		[campaignId, newsletterId, now, JSON.stringify({ sent: 7, delivered: 6, opened: 4, clicked: 2, bounced: 1, complained: 0 }), now, now]);
	for (const [kind, sentAt] of [["welcome", "2026-10-25T00:30:00Z"], ["test", "2026-10-25T01:30:00Z"]]) {
		await execute("INSERT INTO messages (_id, kind, newsletterId, email, sentAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[newId(), kind, newsletterId, "reader@example.com", new Date(sentAt), now, now]);
	}
	const hours = await getHourlySends({ newsletterId, timeZone: "Europe/Paris", now });
	assert.equal(hours[2].today, 2);
	const stats = await getEmailStats({ newsletterId, now });
	assert.equal(stats.current.sent, 8, "the test email is excluded from campaign/welcome stats");
	assert.equal(stats.current.delivered, 6);
	assert.equal(stats.previous.sent, 0);
});
