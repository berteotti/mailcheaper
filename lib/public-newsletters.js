import "server-only";
import { ACCESS_FIELDS, hasActiveSubscription, isBlocked } from "@/lib/account-state";
import { getOne } from "@/lib/db";

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The account columns these checks read.
const ACCOUNT_COLUMNS = [...Object.keys(ACCESS_FIELDS), "status"];

// { slug } or { _id } (with { accountId } or { archiveEnabled: true } when the caller knows it): each field must equal
// its value.
function toWhere(filter) {
	const entries = Object.entries(filter ?? {}).filter(([, value]) => value !== undefined);
	if (entries.length === 0) throw new Error("findNewsletterAnywhere needs a filter");
	for (const [name] of entries) if (!COLUMN.test(name)) throw new Error(`Not a newsletter column: ${name}`);
	return { where: entries.map(([name]) => `n.${name} = ?`).join(" AND "), params: entries.map(([, value]) => (typeof value === "boolean" ? value : String(value))) };
}

// Signup forms and email links find a newsletter by its public slug or a signed id, whatever the account
// (both are unique, so no account scope).
export async function findNewsletterAnywhere(filter) {
	const { where, params } = toWhere(filter);
	return getOne(`SELECT n.* FROM newsletters n WHERE ${where}`, params);
}

async function findWithAccount(filter) {
	const newsletter = await findNewsletterAnywhere(filter);
	if (!newsletter) return {};
	const account = await getOne(`SELECT ${ACCOUNT_COLUMNS.join(", ")} FROM accounts WHERE _id = ?`, [newsletter.accountId]);
	return { newsletter, account };
}

// A canceled account's newsletters take no signups until it subscribes again.
export async function findOpenNewsletter(filter) {
	const { newsletter, account } = await findWithAccount(filter);
	return newsletter && hasActiveSubscription(account) ? newsletter : null;
}

// New signups also wait while the account is blocked; its archive stays online and pending readers can confirm.
export async function findSignupNewsletter(filter) {
	const { newsletter, account } = await findWithAccount(filter);
	return newsletter && hasActiveSubscription(account) && !isBlocked(account) ? newsletter : null;
}
