import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { env } from "./bindings.mjs";

const root = new URL("../../", import.meta.url);
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
		if (specifier === "cloudflare:workers") return { url: new URL("./bindings.mjs", import.meta.url).href, shortCircuit: true };
		if (specifier.startsWith("@/")) {
			const path = fileURLToPath(new URL(specifier.slice(2), root));
			return nextResolve(pathToFileURL(existsSync(path) ? path : path + ".js").href, context);
		}
		return nextResolve(specifier, context);
	},
});

export function database(t) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	const dir = new URL("migrations/", root);
	for (const file of readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
	const db = {
		sqlite,
		maxBoundParameters: 0,
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
			};
		},
		async batch(statements) {
			sqlite.exec("BEGIN");
			try {
				const results = [];
				for (const statement of statements) results.push(await statement.all());
				sqlite.exec("COMMIT");
				return results;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
	};
	env.DB = db;
	t.after(() => { sqlite.close(); if (env.DB === db) delete env.DB; });
	return db;
}

export const newsletterId = "74f1a2b3c4d5e6f7a8b9c0d2";
export function seedNewsletter(db, values = {}) {
	const now = Date.parse("2026-10-14T12:00:00Z");
	db.sqlite.prepare("INSERT INTO newsletters (_id, name, slug, fromEmail, requireConfirmation, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run(values._id ?? newsletterId, values.name ?? "Weekly", values.slug ?? "weekly", values.fromEmail ?? "hello@example.com",
			Number(values.requireConfirmation ?? false), now, now);
	return db.sqlite.prepare("SELECT * FROM newsletters WHERE _id = ?").get(values._id ?? newsletterId);
}
