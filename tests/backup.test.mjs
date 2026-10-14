import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { env } from "./helpers/bindings.mjs";
import { accountId, database, seedNewsletter } from "./helpers/d1.mjs";

const { backupDatabase } = await import("../lib/backup.js");
const { backupToSql } = await import("../scripts/backup-to-sql.mjs");

// Enough of R2's binding for multipart snapshots.
function memoryBucket() {
	const objects = new Map();
	return {
		objects,
		async put(key, value) { objects.set(key, String(value)); },
		async createMultipartUpload(key) {
			const parts = [];
			return {
				async uploadPart(number, value) { parts[number - 1] = String(value); return { partNumber: number }; },
				async complete() { objects.set(key, parts.join("")); },
				async abort() {},
			};
		},
	};
}

test("a synthetic backup restores into an empty database with the same rows, counters and statuses", async (t) => {
	const db = database(t);
	seedNewsletter(db);
	const at = Date.parse("2026-10-14T12:00:00Z");
	const newsletterId = db.sqlite.prepare("SELECT _id FROM newsletters").get()._id;
	db.sqlite.prepare(`INSERT INTO users (id, name, email, emailVerified, createdAt, updatedAt, inbox) VALUES (?, '', 'owner@example.com', 1, ?, ?, 'owner@example.com')`)
		.run(`user-${accountId}`, new Date(at).toISOString(), new Date(at).toISOString());
	db.sqlite.prepare("INSERT INTO account_secrets (accountId, postshibaPassword, updatedAt) VALUES (?, 'encrypted', ?)").run(accountId, at);
	const contact = db.sqlite.prepare(`INSERT INTO contacts (_id, accountId, newsletterId, email, subscribedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`);
	for (let index = 0; index < 1205; index++) contact.run(index.toString(16).padStart(24, "0"), accountId, newsletterId, `r${index}@example.com`, at, at, at);
	db.sqlite.prepare(`INSERT INTO campaigns (_id, accountId, newsletterId, subject, status, createdAt, updatedAt) VALUES ('c0000000000000000000000a', ?, ?, 'It''s here', 'sent', ?, ?)`).run(accountId, newsletterId, at, at);
	db.sqlite.prepare(`INSERT INTO messages (_id, accountId, kind, campaignId, newsletterId, contactId, email, status, createdAt, updatedAt)
		VALUES ('d0000000000000000000000a', ?, 'campaign', 'c0000000000000000000000a', ?, '000000000000000000000001', 'r1@example.com', 'sending', ?, ?)`).run(accountId, newsletterId, at, at);
	db.sqlite.prepare("UPDATE messages SET status = 'sent', sentAt = ?").run(at);
	db.sqlite.prepare("INSERT INTO suppressions (_id, accountId, email, reason, createdAt, updatedAt) VALUES ('ffffffffffffffffffffffff', ?, 'r2@example.com', 'complaint', ?, ?)").run(accountId, at, at);

	const bucket = memoryBucket();
	env.BACKUPS_BUCKET = bucket;
	t.after(() => delete env.BACKUPS_BUCKET);
	const { prefix, counts } = await backupDatabase(new Date(at));
	assert.equal(prefix, "backups/2026-10-14");
	assert.equal(counts.contacts, 1205, "paged past the first 1,000 rows");

	const directory = mkdtempSync(join(tmpdir(), "mailcheap-backup-"));
	for (const [key, value] of bucket.objects) writeFileSync(join(directory, key.split("/").pop()), value);
	const restored = new DatabaseSync(":memory:");
	t.after(() => restored.close());
	restored.exec("PRAGMA foreign_keys = ON");
	const migrations = new URL("../migrations/", import.meta.url);
	for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) restored.exec(readFileSync(new URL(file, migrations), "utf8"));
	restored.exec(backupToSql(directory));

	for (const table of ["accounts", "newsletters", "contacts", "campaigns", "messages", "suppressions"]) {
		assert.deepEqual(restored.prepare(`SELECT * FROM ${table} ORDER BY _id`).all(), db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY _id`).all(), table);
	}
	for (const [table, key] of [["users", "id"], ["account_secrets", "accountId"]]) {
		assert.deepEqual(restored.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all(), db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all(), table);
	}
	assert.equal(JSON.parse(restored.prepare("SELECT stats FROM campaigns").get().stats).sent, 1, "counters are restored, not recounted");
});
