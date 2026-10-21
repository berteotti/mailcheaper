import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const migrations = new URL("../migrations/", import.meta.url);
const schema = readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()
	.map((file) => readFileSync(new URL(file, migrations), "utf8")).join("\n");
const at = Date.parse("2026-10-14T12:00:00Z");
const newsletterId = "000000000000000000000001";
const contactId = "000000000000000000000002";
const campaignId = "000000000000000000000003";
const accountId = "00000000000000000000000a";
const otherAccountId = "00000000000000000000000b";

function database(t) {
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(schema);
	const account = db.prepare("INSERT INTO accounts (_id, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?)");
	account.run(accountId, "user-a", at, at);
	account.run(otherAccountId, "user-b", at, at);
	db.prepare("INSERT INTO newsletters (_id, accountId, name, slug, fromEmail, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run(newsletterId, accountId, "Weekly", "weekly", "hello@example.com", at, at);
	db.prepare("INSERT INTO contacts (_id, accountId, newsletterId, email, subscribedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run(contactId, accountId, newsletterId, "reader@example.com", at, at, at);
	db.prepare("INSERT INTO campaigns (_id, accountId, newsletterId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)")
		.run(campaignId, accountId, newsletterId, at, at);
	return db;
}

test("an empty D1 schema has all application tables and preserves model defaults", (t) => {
	const db = database(t);
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => name);
	assert.equal(
		["accounts", "account_secrets", "alerts", "api_keys", "campaign_editions", "campaigns", "contact_imports", "contacts", "deletion_records", "domains", "events", "job_outbox", "messages", "newsletters", "suppressions", "uploads"].every((name) => tables.includes(name)), true);
	const newsletter = db.prepare("SELECT * FROM newsletters").get();
	assert.equal(newsletter.archiveEnabled, 0);
	assert.equal(newsletter.requireConfirmation, 0);
	assert.deepEqual(JSON.parse(newsletter.cleanup), { enabled: false });
	assert.deepEqual(JSON.parse(newsletter.socialLinks), []);
	assert.equal(newsletter.language, "en");
	const campaign = db.prepare("SELECT * FROM campaigns").get();
	assert.equal(campaign.status, "draft");
	assert.equal(campaign.format, "rich");
	assert.equal(campaign.html, "");
	assert.equal(campaign.archiveListed, 1);
	assert.equal(campaign.archivePinned, 0);
	assert.equal(campaign.scheduledAt, null);
	assert.equal(JSON.parse(campaign.stats).unsubscribed, 0);
	assert.equal(JSON.parse(campaign.lastChance).dormant, 0);
	assert.equal(campaign.language, null, "the newsletter's applies");
	const contact = db.prepare("SELECT * FROM contacts").get();
	assert.equal(contact.status, "active");
	assert.equal(contact.subscribedAt, at);
	assert.deepEqual(JSON.parse(contact.stats), { sent: 0, opens: 0, clicks: 0 });
	assert.equal(contact.language, null, "the newsletter's applies");
});

test("contact uniqueness is per newsletter, suppressions are per account and archive slugs are global", (t) => {
	const db = database(t);
	assert.throws(() => db.prepare("INSERT INTO contacts (_id, accountId, newsletterId, email, subscribedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run("000000000000000000000004", accountId, newsletterId, "reader@example.com", at, at, at), /UNIQUE/);
	db.prepare("INSERT INTO newsletters (_id, accountId, name, slug, fromEmail, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run("000000000000000000000005", accountId, "Other", "other", "other@example.com", at, at);
	db.prepare("INSERT INTO contacts (_id, accountId, newsletterId, email, subscribedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run("000000000000000000000004", accountId, "000000000000000000000005", "reader@example.com", at, at, at);
	const suppression = db.prepare("INSERT INTO suppressions (_id, accountId, email, reason, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)");
	suppression.run("000000000000000000000006", accountId, "reader@example.com", "complaint", at, at);
	assert.throws(() => suppression.run("000000000000000000000007", accountId, "reader@example.com", "bounce", at, at), /UNIQUE/);
	assert.doesNotThrow(() => suppression.run("000000000000000000000007", otherAccountId, "reader@example.com", "bounce", at, at), "another account's list");
	db.prepare("UPDATE campaigns SET archiveSlug = 'first-issue'").run();
	assert.throws(() => db.prepare("INSERT INTO campaigns (_id, accountId, newsletterId, archiveSlug, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
		.run("000000000000000000000008", accountId, newsletterId, "first-issue", at, at), /UNIQUE/);
	assert.doesNotThrow(() => db.prepare("INSERT INTO campaigns (_id, accountId, newsletterId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)")
		.run("000000000000000000000008", accountId, newsletterId, at, at), "many drafts may have a null slug");
});

test("partial message indexes prevent duplicate issues and last chances without blocking confirmations", (t) => {
	const db = database(t);
	const insert = db.prepare("INSERT INTO messages (_id, accountId, kind, campaignId, newsletterId, contactId, email, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
	let sequence = 10;
	const message = (kind) => insert.run((sequence++).toString(16).padStart(24, "0"), accountId, kind, campaignId, newsletterId, contactId, "reader@example.com", at, at);
	message("campaign");
	assert.throws(() => message("campaign"), /UNIQUE/);
	message("last-chance");
	assert.throws(() => message("last-chance"), /UNIQUE/);
	message("confirmation");
	message("confirmation");
	assert.equal(db.prepare("SELECT count(*) AS count FROM messages").get().count, 4);
	assert.equal(db.prepare("SELECT status FROM messages LIMIT 1").get().status, "queued");
});

test("IDs, normalization, enums, settings and relationships reject invalid writes", (t) => {
	const db = database(t);
	for (const statement of [
		"UPDATE contacts SET _id = 'invalid'",
		"UPDATE contacts SET _id = 'FFFFFFFFFFFFFFFFFFFFFFFF'",
		"UPDATE contacts SET email = ' READER@example.com '",
		"UPDATE contacts SET status = 'unknown'",
		"UPDATE contacts SET ignoredIssues = -1",
		"UPDATE contacts SET language = 'pt-BR'",
		"UPDATE contacts SET language = 'EN'",
		"UPDATE contacts SET language = ''",
		"UPDATE contacts SET language = NULL, languageRegion = 'BR'",
		"UPDATE contacts SET language = 'pt', languageRegion = 'br'",
		"UPDATE contacts SET language = 'pt', languageRegion = 'BRA'",
		"UPDATE contacts SET newsletterId = '000000000000000000000099'",
		"UPDATE newsletters SET slug = 'Weekly'",
		"UPDATE newsletters SET name = ' '",
		"UPDATE newsletters SET archiveEnabled = 2",
		"UPDATE newsletters SET language = NULL",
		"UPDATE newsletters SET language = 'french'",
		"UPDATE newsletters SET languageRegion = 'Brazil'",
		"UPDATE newsletters SET cleanup = '{\"issues\":0}'",
		"UPDATE newsletters SET author = '[]'",
		"UPDATE campaigns SET stats = 'invalid json'",
		"UPDATE campaigns SET status = 'unknown'",
		"UPDATE campaigns SET format = 'unknown'",
		"UPDATE campaigns SET audienceLimit = 0",
		"DELETE FROM newsletters",
	]) assert.throws(() => db.exec(statement), undefined, statement);
	assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
	assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

test("API-key hashes and alert cooldown keys remain unique", (t) => {
	const db = database(t);
	const key = db.prepare("INSERT INTO api_keys (_id, accountId, name, prefix, hash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)");
	key.run("000000000000000000000010", accountId, "Form", "mc_test", "hashed-key", at, at);
	assert.throws(() => key.run("000000000000000000000011", accountId, "Other", "mc_test", "hashed-key", at, at), /UNIQUE/);
	const alert = db.prepare("INSERT INTO alerts (_id, accountId, key, lastSentAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)");
	alert.run("000000000000000000000012", accountId, "complaints", at, at, at);
	assert.throws(() => alert.run("000000000000000000000013", accountId, "complaints", at, at, at), /UNIQUE/);
});

test("job intent and the state change roll back together, and recovery selects only due unpublished jobs", (t) => {
	const db = database(t);
	const insert = db.prepare("INSERT INTO job_outbox (_id, kind, payload, availableAt, createdAt) VALUES (?, 'scheduled', ?, ?, ?)");
	insert.run(`schedule:${campaignId}:${at}`, JSON.stringify({ campaignId, scheduledAt: at }), at, at);
	assert.throws(() => insert.run(`schedule:${campaignId}:${at}`, "{}", at, at), /UNIQUE/);
	insert.run("future", "{}", at + 60_000, at);
	insert.run("published", "{}", at, at);
	db.prepare("UPDATE job_outbox SET publishedAt = ? WHERE _id = 'published'").run(at);
	assert.deepEqual(db.prepare("SELECT _id FROM job_outbox WHERE publishedAt IS NULL AND availableAt <= ? ORDER BY availableAt, _id").all(at).map(({ _id }) => _id), [`schedule:${campaignId}:${at}`]);
	db.exec("BEGIN");
	try {
		db.prepare("UPDATE campaigns SET status = 'sending' WHERE _id = ?").run(campaignId);
		assert.throws(() => insert.run("invalid", "not json", at, at));
	} finally {
		db.exec("ROLLBACK");
	}
	assert.equal(db.prepare("SELECT status FROM campaigns WHERE _id = ?").get(campaignId).status, "draft");
	assert.equal(db.prepare("SELECT count(*) AS count FROM job_outbox WHERE _id = 'invalid'").get().count, 0);
});

test("first-event counters are atomic, retry-safe and isolated from last-chance and test sends", (t) => {
	const db = database(t);
	const insert = db.prepare("INSERT INTO messages (_id, accountId, kind, campaignId, newsletterId, contactId, email, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
	const messageId = "000000000000000000000020";
	insert.run(messageId, accountId, "campaign", campaignId, newsletterId, contactId, "reader@example.com", at, at);
	const sent = db.prepare("UPDATE messages SET status = 'sent', sentAt = ?, updatedAt = ? WHERE _id = ? AND sentAt IS NULL");
	assert.equal(sent.run(at, at, messageId).changes, 1);
	assert.equal(sent.run(at, at, messageId).changes, 0);
	assert.equal(db.prepare("SELECT ignoredIssues FROM contacts").get().ignoredIssues, 1);
	const engagement = db.prepare("UPDATE messages SET deliveredAt = coalesce(deliveredAt, ?), openedAt = coalesce(openedAt, ?), clickedAt = coalesce(clickedAt, ?), updatedAt = ? WHERE _id = ?");
	engagement.run(at + 1, at + 2, at + 3, at + 3, messageId);
	engagement.run(at + 1, at + 2, at + 3, at + 3, messageId);
	const contact = db.prepare("SELECT * FROM contacts").get();
	assert.deepEqual(JSON.parse(contact.stats), { sent: 1, opens: 1, clicks: 1 });
	assert.equal(contact.ignoredIssues, 0);
	assert.equal(contact.lastClickAt, at + 3);
	const stats = JSON.parse(db.prepare("SELECT stats FROM campaigns").get().stats);
	for (const field of ["sent", "delivered", "opened", "clicked"]) assert.equal(stats[field], 1, field);
	insert.run("000000000000000000000021", accountId, "last-chance", campaignId, newsletterId, contactId, "reader@example.com", at, at);
	sent.run(at + 4, at + 4, "000000000000000000000021");
	insert.run("000000000000000000000022", accountId, "test", campaignId, newsletterId, null, "admin@example.com", at, at);
	sent.run(at + 5, at + 5, "000000000000000000000022");
	const campaign = db.prepare("SELECT stats, lastChance FROM campaigns").get();
	assert.deepEqual(JSON.parse(campaign.stats), stats);
	assert.equal(JSON.parse(campaign.lastChance).sent, 1);
	assert.equal(db.prepare("SELECT lastChanceAt FROM contacts").get().lastChanceAt, at + 4);
	assert.equal(JSON.parse(db.prepare("SELECT stats FROM contacts").get().stats).sent, 2);
});

test("counter failure rolls back the first-event marker so retry can recover it", (t) => {
	const db = database(t);
	db.prepare("INSERT INTO messages (_id, accountId, kind, campaignId, newsletterId, contactId, email, createdAt, updatedAt) VALUES (?, ?, 'campaign', ?, ?, ?, ?, ?, ?)")
		.run("000000000000000000000023", accountId, campaignId, newsletterId, contactId, "reader@example.com", at, at);
	db.exec("CREATE TRIGGER simulate_counter_failure BEFORE UPDATE ON campaigns BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
	const delivered = db.prepare("UPDATE messages SET deliveredAt = ? WHERE _id = ? AND deliveredAt IS NULL");
	assert.throws(() => delivered.run(at, "000000000000000000000023"), /injected failure/);
	assert.equal(db.prepare("SELECT deliveredAt FROM messages").get().deliveredAt, null);
	db.exec("DROP TRIGGER simulate_counter_failure");
	delivered.run(at, "000000000000000000000023");
	assert.equal(JSON.parse(db.prepare("SELECT stats FROM campaigns").get().stats).delivered, 1);
});

test("feedback arriving before send acknowledgment keeps engagement and counts every first once", (t) => {
	const db = database(t);
	db.prepare("INSERT INTO messages (_id, accountId, kind, campaignId, newsletterId, contactId, email, createdAt, updatedAt) VALUES (?, ?, 'campaign', ?, ?, ?, ?, ?, ?)")
		.run("000000000000000000000024", accountId, campaignId, newsletterId, contactId, "reader@example.com", at, at);
	db.prepare("UPDATE messages SET openedAt = ?, bouncedAt = ?, complainedAt = ?, status = 'complained' WHERE _id = ?")
		.run(at + 5, at + 6, at + 7, "000000000000000000000024");
	db.prepare("UPDATE messages SET sentAt = ?, updatedAt = ? WHERE _id = ?").run(at, at + 8, "000000000000000000000024");
	const stats = JSON.parse(db.prepare("SELECT stats FROM campaigns").get().stats);
	assert.equal(stats.sent, 1);
	assert.equal(stats.opened, 1);
	assert.equal(stats.bounced, 1);
	assert.equal(stats.complained, 1);
	assert.equal(db.prepare("SELECT ignoredIssues FROM contacts").get().ignoredIssues, 0);
	assert.equal(db.prepare("SELECT status FROM messages").get().status, "complained");
});

test("suppression wins across newsletters and concurrent imports, with complaints taking precedence", (t) => {
	const db = database(t);
	const suppressionId = "000000000000000000000025";
	db.prepare("INSERT INTO suppressions (_id, accountId, email, reason, createdAt, updatedAt) VALUES (?, ?, ?, 'bounce', ?, ?)")
		.run(suppressionId, accountId, "reader@example.com", at, at);
	assert.equal(db.prepare("SELECT status FROM contacts").get().status, "bounced");
	assert.throws(() => db.exec("UPDATE contacts SET status = 'active'"), /cannot be reactivated/);
	db.prepare("UPDATE suppressions SET reason = 'complaint' WHERE _id = ?").run(suppressionId);
	assert.equal(db.prepare("SELECT status FROM contacts").get().status, "complained");
	assert.throws(() => db.exec("UPDATE suppressions SET reason = 'bounce'"), /cannot be weakened/);
	assert.throws(() => db.exec("UPDATE contacts SET status = 'bounced'"), /cannot be reactivated/);
	db.prepare("INSERT INTO newsletters (_id, accountId, name, slug, fromEmail, createdAt, updatedAt) VALUES (?, ?, 'Other', 'other', 'other@example.com', ?, ?)")
		.run("000000000000000000000026", accountId, at, at);
	db.prepare("INSERT INTO contacts (_id, accountId, newsletterId, email, status, subscribedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)")
		.run("000000000000000000000027", accountId, "000000000000000000000026", "reader@example.com", at, at, at);
	assert.equal(db.prepare("SELECT count(*) AS count FROM contacts WHERE status = 'complained'").get().count, 2);
});

test("representative list and monthly send fixtures fit indexed audience reads", (t) => {
	const db = database(t);
	const id = (number) => number.toString(16).padStart(24, "0");
	const insertContact = db.prepare("INSERT INTO contacts (_id, accountId, newsletterId, email, status, subscribedAt, imported, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
	const insertMessage = db.prepare("INSERT INTO messages (_id, accountId, kind, campaignId, newsletterId, contactId, email, createdAt, updatedAt) VALUES (?, ?, 'campaign', ?, ?, ?, ?, ?, ?)");
	const secondCampaignId = "000000000000000000000030";
	db.prepare("INSERT INTO campaigns (_id, accountId, newsletterId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)").run(secondCampaignId, accountId, newsletterId, at, at);
	db.exec("BEGIN");
	try {
		for (let index = 1; index < 5000; index++) {
			insertContact.run(id(1_000_000 + index), accountId, newsletterId, `reader${index}@example.com`,
				["active", "pending", "unsubscribed", "bounced", "complained", "dormant"][index % 6],
				at - index * 60_000, JSON.stringify({ emailsReceived: 20, openRate: (index % 10) / 10, clickRate: (index % 5) / 10 }), at, at);
		}
		for (let index = 0; index < 8000; index++) {
			const recipient = index % 5000;
			insertMessage.run(id(2_000_000 + index), accountId, index < 5000 ? campaignId : secondCampaignId, newsletterId,
				recipient === 0 ? contactId : id(1_000_000 + recipient), recipient === 0 ? "reader@example.com" : `reader${recipient}@example.com`,
				at - index * 60_000, at);
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	assert.equal(db.prepare("SELECT count(*) AS count FROM contacts").get().count, 5000);
	assert.equal(db.prepare("SELECT count(*) AS count FROM messages").get().count, 8000);
	const audience = `SELECT c._id, c.email FROM contacts c
		WHERE c.newsletterId = ? AND c.status = 'active'
		AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.accountId = c.accountId AND s.email = c.email)
		ORDER BY c.lastClickAt DESC, c.lastOpenAt DESC,
		json_extract(c.imported, '$.clickRate') DESC, json_extract(c.imported, '$.openRate') DESC,
		c.createdAt, c._id LIMIT 100`;
	assert.equal(db.prepare(audience).all(newsletterId).length, 100);
	const plan = db.prepare(`EXPLAIN QUERY PLAN ${audience}`).all(newsletterId).map(({ detail }) => detail).join("\n");
	assert.match(plan, /USING INDEX contacts_audience/);
	assert.doesNotMatch(plan, /TEMP B-TREE/, "the audience index supplies engagement order");
	const bytes = db.prepare("PRAGMA page_count").get().page_count * db.prepare("PRAGMA page_size").get().page_size;
	t.diagnostic(`Synthetic SQLite footprint: 5,000 contacts + 8,000 queued messages = ${bytes} bytes. This is not a remote D1 throughput test.`);
});
