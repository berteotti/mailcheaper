import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { env } from "./helpers/bindings.mjs";
import { database, seedNewsletter } from "./helpers/d1.mjs";

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
	const contact = db.sqlite.prepare(`INSERT INTO contacts (_id, newsletterId, email, subscribedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`);
	for (let index = 0; index < 1205; index++) contact.run(index.toString(16).padStart(24, "0"), newsletterId, `r${index}@example.com`, at, at, at);
	db.sqlite.prepare(`INSERT INTO campaigns (_id, newsletterId, subject, status, createdAt, updatedAt) VALUES ('c0000000000000000000000a', ?, 'It''s here', 'sent', ?, ?)`).run(newsletterId, at, at);
	db.sqlite.prepare(`INSERT INTO messages (_id, kind, campaignId, newsletterId, contactId, email, status, createdAt, updatedAt)
		VALUES ('d0000000000000000000000a', 'campaign', 'c0000000000000000000000a', ?, '000000000000000000000001', 'r1@example.com', 'sending', ?, ?)`).run(newsletterId, at, at);
	db.sqlite.prepare("UPDATE messages SET status = 'sent', sentAt = ?").run(at);
	db.sqlite.prepare("INSERT INTO suppressions (_id, email, reason, createdAt, updatedAt) VALUES ('ffffffffffffffffffffffff', 'r2@example.com', 'complaint', ?, ?)").run(at, at);

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

	for (const table of ["newsletters", "contacts", "campaigns", "messages", "suppressions"]) {
		assert.deepEqual(restored.prepare(`SELECT * FROM ${table} ORDER BY _id`).all(), db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY _id`).all(), table);
	}
	assert.equal(JSON.parse(restored.prepare("SELECT stats FROM campaigns").get().stats).sent, 1, "counters are restored, not recounted");
});
