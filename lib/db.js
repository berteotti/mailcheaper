import { randomBytes } from "node:crypto";

const JSON_FIELDS = new Set(["stats", "lastChance", "imported", "author", "cleanup", "welcome", "confirmation", "socialLinks", "data"]);
const BOOLEAN_FIELDS = new Set(["archiveEnabled", "archiveListed", "archivePinned", "requireConfirmation"]);

export const newId = () => randomBytes(12).toString("hex");

export async function getBindings() {
	return (await import("cloudflare:workers")).env;
}

export async function connectDb() {
	const { DB } = await getBindings();
	if (!DB) throw new Error("The Cloudflare D1 binding DB is missing");
	return DB;
}

export function decodeRow(row) {
	if (!row) return null;
	return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
		value == null ? value
			: JSON_FIELDS.has(key) ? JSON.parse(value)
				: BOOLEAN_FIELDS.has(key) ? Boolean(value)
					: key.endsWith("At") || key === "at" ? new Date(value) : value,
	]));
}

export function statement(db, sql, params = []) {
	return db.prepare(sql).bind(...params.map((value) => value instanceof Date ? value.getTime() : value ?? null));
}

export async function getAll(sql, params = [], db) {
	const { results } = await statement(db ?? await connectDb(), sql, params).all();
	return results.map(decodeRow);
}

export async function getOne(sql, params = [], db) {
	return decodeRow(await statement(db ?? await connectDb(), sql, params).first());
}

export async function execute(sql, params = [], db) {
	return statement(db ?? await connectDb(), sql, params).run();
}

export function isUniqueConstraint(error) {
	return /UNIQUE constraint failed/.test(String(error?.message));
}
