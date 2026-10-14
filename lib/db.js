import { randomBytes } from "node:crypto";

// Columns stored as JSON text. A name in both sets is JSON on one table and a 0/1 flag on another
// (campaigns.firstSend / messages.firstSend, contacts.consent / contact_imports.consent): the stored type decides.
const JSON_FIELDS = new Set([
	"stats", "lastChance", "imported", "author", "cleanup", "welcome", "confirmation", "socialLinks", "data",
	"usage", "ses", "postshiba", "health", "onboarding", "limitOverrides", "comp", "deletion",
	"sharedSender", "firstSend", "consent", "dropped", "records",
]);
const BOOLEAN_FIELDS = new Set([
	"archiveEnabled", "archiveListed", "archivePinned", "requireConfirmation",
	"firstSend", "consent", "verified", "archiveHostVerified", "emailVerified",
]);
// Date columns whose names don't end in At.
const DATE_FIELDS = new Set(["currentPeriodStart", "currentPeriodEnd", "spreadUntil", "sendingUntil"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const newId = () => randomBytes(12).toString("hex");

// Dates inside JSON columns are written as ISO strings (JSON.stringify) and come back as Dates.
function reviveDate(_key, value) {
	return typeof value === "string" && ISO_DATE.test(value) ? new Date(value) : value;
}

export function parseJson(value) {
	return value == null ? value : JSON.parse(value, reviveDate);
}

// A value for a JSON column: undefined fields drop out, Dates become ISO strings.
export function json(value) {
	return value == null ? null : JSON.stringify(value);
}

export async function getBindings() {
	return (await import("cloudflare:workers")).env;
}

export async function connectDb() {
	const { DB } = await getBindings();
	if (!DB) throw new Error("The Cloudflare D1 binding DB is missing");
	return DB;
}

function decodeValue(key, value) {
	if (value == null) return value;
	if (JSON_FIELDS.has(key) && typeof value === "string") return parseJson(value);
	if (BOOLEAN_FIELDS.has(key) && typeof value === "number") return Boolean(value);
	if (key.endsWith("At") || key === "at" || DATE_FIELDS.has(key)) return typeof value === "number" ? new Date(value) : value;
	return value;
}

export function decodeRow(row) {
	if (!row) return null;
	return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, decodeValue(key, value)]));
}

export function encodeParam(value) {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "boolean") return Number(value);
	return value ?? null;
}

export function statement(db, sql, params = []) {
	return db.prepare(sql).bind(...params.map(encodeParam));
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

export async function getValue(sql, params = [], db) {
	const row = await statement(db ?? await connectDb(), sql, params).first();
	return row ? Object.values(row)[0] : null;
}

export function isUniqueConstraint(error) {
	return /UNIQUE constraint failed/.test(String(error?.message));
}

// The account a row belongs to, as an id: an account row, its id, or a row that carries accountId.
export function accountIdOf(account) {
	const id = typeof account === "string" ? account : account?.accountId ?? account?._id;
	if (typeof id !== "string" || !/^[0-9a-f]{24}$/.test(id)) throw new Error("No account to scope the query to");
	return id;
}
