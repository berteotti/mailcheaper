import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { env } from "./bindings.mjs";

const root = new URL("../../", import.meta.url);
const executeNow = Symbol("executeNow");

// An in-memory D1 with every migration applied, bound as env.DB until it's closed.
export function createDatabase() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	const dir = new URL("migrations/", root);
	for (const file of readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
	const db = {
		sqlite,
		maxBoundParameters: 0,
		async exec(sql) {
			sqlite.exec(sql);
			return { count: 1, duration: 0 };
		},
		prepare(sql) {
			const prepared = sqlite.prepare(sql);
			let params = [];
			const execute = () => {
				const results = prepared.all(...params);
				return { results, success: true, meta: { changes: sqlite.prepare("SELECT changes() AS changes").get().changes } };
			};
			return {
				bind(...values) {
					assert.ok(values.length <= 100, "D1 statements allow at most 100 bound parameters");
					db.maxBoundParameters = Math.max(db.maxBoundParameters, values.length);
					params = values;
					return this;
				},
				async first() { return prepared.get(...params) ?? null; },
				async all() { return execute(); },
				async run() { return execute(); },
				[executeNow]: execute,
			};
		},
		// Like D1, a batch runs at once: awaiting between statements would let another batch BEGIN inside this one.
		async batch(statements) {
			sqlite.exec("BEGIN");
			try {
				const results = statements.map((statement) => statement[executeNow]());
				sqlite.exec("COMMIT");
				return results;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
	};
	env.DB = db;
	db.close = () => { sqlite.close(); if (env.DB === db) delete env.DB; };
	return db;
}

export function database(t) {
	const db = createDatabase();
	t.after(() => db.close());
	return db;
}

export const accountId = "74f1a2b3c4d5e6f7a8b9c0d1";
export const newsletterId = "74f1a2b3c4d5e6f7a8b9c0d2";

export function seedAccount(db, values = {}) {
	const now = Date.parse("2026-10-14T12:00:00Z");
	const id = values._id ?? accountId;
	db.sqlite.prepare("INSERT OR IGNORE INTO accounts (_id, ownerId, plan, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)")
		.run(id, values.ownerId ?? `user-${id}`, values.plan ?? "starter", now, now);
	return db.sqlite.prepare("SELECT * FROM accounts WHERE _id = ?").get(id);
}

export function seedNewsletter(db, values = {}) {
	const now = Date.parse("2026-10-14T12:00:00Z");
	const account = values.accountId ?? seedAccount(db)._id;
	db.sqlite.prepare("INSERT INTO newsletters (_id, accountId, name, slug, fromEmail, requireConfirmation, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.run(values._id ?? newsletterId, account, values.name ?? "Weekly", values.slug ?? "weekly", values.fromEmail ?? "hello@example.com",
			Number(values.requireConfirmation ?? false), now, now);
	return db.sqlite.prepare("SELECT * FROM newsletters WHERE _id = ?").get(values._id ?? newsletterId);
}
