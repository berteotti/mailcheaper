import "server-only";
import * as z from "zod";
import { findOwnerEmail } from "@/lib/accounts";
import { actionError } from "@/lib/actions/errors";
import { isSendingEnabled } from "@/lib/config";
import { getOne } from "@/lib/db";
import { getUsage } from "@/lib/usage";
import { isObjectIdString } from "@/lib/validation";

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const idInput = (thing) => z.string().trim().min(1).max(100).describe(`The ${thing}'s ID`);
const newsletterReference = z.string().trim().min(1).max(100).optional();
export const newsletterInput = newsletterReference.describe(
	"The newsletter's ID or slug. Default: the account's first newsletter, the one it has had longest."
);
export const newsletterFilterInput = newsletterReference.describe("Only this newsletter's: its ID or slug. Default: every newsletter.");

export const dateOutput = z.string().nullable();
const NO_LIMIT = "null on a self-hosted server without billing: no limit";
export const UsageSchema = z.object({
	emailsSent: z.number().int().describe("Emails sent this month, every kind counted"),
	emailsLimit: z.number().int().nullable().describe(NO_LIMIT),
	emailsLeft: z.number().int().nullable().describe(NO_LIMIT),
	subscribers: z.number().int().describe("Active contacts"),
	subscribersLimit: z.number().int().nullable().describe(NO_LIMIT),
	periodStart: dateOutput,
	periodEnd: dateOutput.describe("When the email count starts over"),
});

export function toIso(value) {
	return value ? new Date(value).toISOString() : null;
}

export function toId(value) {
	return value ? String(value) : null;
}

// The position of a page's last item, in lists sorted newest first with ties broken by ID.
export function encodeCursor(date, id) {
	return Buffer.from(JSON.stringify([date.toISOString(), String(id)])).toString("base64url");
}

// The items after a cursor's position, on the date column the list is sorted by (ORDER BY <field> DESC, _id DESC):
// a SQL condition and its parameters, to AND into the query's WHERE. `table` prefixes the columns in a join.
export function afterCursor(cursor, field, { table } = {}) {
	if (!COLUMN.test(field) || (table && !COLUMN.test(table))) throw new Error(`Not a column: ${field}`);
	const { date, id } = decodeCursor(cursor);
	const [column, idColumn] = table ? [`${table}.${field}`, `${table}._id`] : [field, "_id"];
	return { sql: `(${column} < ? OR (${column} = ? AND ${idColumn} < ?))`, params: [date, date, id] };
}

function decodeCursor(cursor) {
	try {
		const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		const date = new Date(at);
		if (Number.isFinite(date.getTime()) && isObjectIdString(id)) return { date, id: id.toLowerCase() };
	} catch {
		// Falls through to the error below.
	}
	throw actionError("validation_failed", "cursor: use the nextCursor of the previous page");
}

export async function getUsageOutput(account) {
	const usage = await getUsage(account);
	return {
		...usage,
		emailsLeft: usage.emailsLimit === null ? null : Math.max(0, usage.emailsLimit - usage.emailsSent),
		periodStart: toIso(usage.periodStart),
		periodEnd: toIso(usage.periodEnd),
	};
}

// `select` names the fields to read, as { field: 1 } or "field other": every column without it. _id and accountId
// always come back.
function toColumns(select) {
	if (!select) return "*";
	const names = typeof select === "string" ? select.split(/[\s,]+/).filter(Boolean) : Object.keys(select).filter((name) => select[name]);
	for (const name of names) if (!COLUMN.test(name)) throw new Error(`Not a newsletter column: ${name}`);
	return [...new Set(["_id", "accountId", ...names])].join(", ");
}

export function findFirstNewsletter(account, select) {
	return getOne(`SELECT ${toColumns(select)} FROM newsletters WHERE accountId = ? ORDER BY createdAt, _id LIMIT 1`, [account._id]);
}

// By ID or slug. Without one, the account's first newsletter: a site's signup form or an agent set up while the
// account had one keeps reaching that one once there are more.
export async function findNewsletter(account, reference, select) {
	const value = reference?.trim().toLowerCase();
	if (!value) {
		const first = await findFirstNewsletter(account, select);
		if (!first) throw actionError("not_found", "Create a newsletter first");
		return first;
	}
	const found = await getOne(`SELECT ${toColumns(select)} FROM newsletters WHERE accountId = ? AND (_id = ? OR slug = ?)`, [
		account._id,
		isObjectIdString(value) ? value : null,
		value,
	]);
	if (!found) throw actionError("not_found", "Newsletter not found");
	return found;
}

// Test emails go to the signed-in user, or to the account's owner when an API key asks.
export async function findTestRecipient({ account, user }) {
	return user?.email ?? (await findOwnerEmail(account._id));
}

export function assertSendingEnabled() {
	if (!isSendingEnabled()) throw actionError("sending_disabled", "Sending is off");
}

export function readPositiveInteger(value) {
	return Number.isInteger(value) && value > 0 ? value : undefined;
}
