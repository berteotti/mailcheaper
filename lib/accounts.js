import "server-only";
import { isEmailAllowed } from "@/lib/config";
import { execute, getAll, getOne, newId } from "@/lib/db";
import { getCanonicalEmail } from "@/lib/email-aliases";
import { updateOne } from "@/lib/records";
import { getSpreadEnd } from "@/lib/send-spread";

// Better Auth's tables (migrations/0007_auth.sql). Its "account" model (sign-in methods) is renamed so it can't be
// mistaken for the accounts table (a customer: plan, billing, usage).
export const AUTH_MODELS = {
	user: "users",
	session: "sessions",
	account: "auth_accounts",
	verification: "verifications",
};

// Each user owns one account, created at their first sign-in (lib/auth.js). True when this call created it.
export async function createAccount(ownerId) {
	const now = Date.now();
	const { meta } = await execute("INSERT INTO accounts (_id, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(ownerId) DO NOTHING", [
		newId(),
		String(ownerId),
		now,
		now,
	]);
	return meta.changes > 0;
}

export function findAccountByOwner(ownerId) {
	return getOne("SELECT * FROM accounts WHERE ownerId = ?", [String(ownerId)]);
}

export function findAccountById(accountId) {
	return getOne("SELECT * FROM accounts WHERE _id = ?", [String(accountId)]);
}

// The user's account, created here if their first sign-in didn't.
export async function ensureAccount(ownerId) {
	await createAccount(ownerId);
	return findAccountByOwner(ownerId);
}

export function findUser(userId) {
	return getOne(`SELECT id AS _id, email, emailVerified FROM ${AUTH_MODELS.user} WHERE id = ?`, [String(userId)]);
}

// Another user whose address reaches the same inbox as this one (lib/email-aliases.js): users.inbox holds each
// user's canonical address, written when the user is created (lib/auth.js).
export async function findAliasUser(email) {
	const inbox = getCanonicalEmail(email);
	if (!inbox) return null;
	return getOne(`SELECT id AS _id, email FROM ${AUTH_MODELS.user} WHERE inbox = ? AND email != ?`, [inbox, String(email).toLowerCase()]);
}

export function findUserByEmail(email) {
	return getOne(`SELECT id AS _id FROM ${AUTH_MODELS.user} WHERE email = ?`, [email]);
}

// On a self-hosted server's allowlist (lib/config.js), with an email the user proved they own.
export function isUserAllowed(user) {
	return Boolean(user?.emailVerified) && isEmailAllowed(user.email);
}

// Signed in with Google before: the account page says they can sign in either way.
export async function hasGoogleSignIn(userId) {
	const google = await getOne(`SELECT id FROM ${AUTH_MODELS.account} WHERE userId = ? AND providerId = 'google'`, [String(userId)]);
	return Boolean(google);
}

export async function findOwnerEmail(accountId) {
	const owner = await getOne(`SELECT u.email FROM accounts a JOIN ${AUTH_MODELS.user} u ON u.id = a.ownerId WHERE a._id = ?`, [String(accountId)]);
	return owner?.email ?? null;
}

// Newest first, with the owner's email and active contacts, for the admin list.
export function listAccountsForAdmin({ limit = 200 } = {}) {
	return getAll(
		`SELECT a.*, u.email AS ownerEmail,
			(SELECT count(*) FROM contacts c WHERE c.accountId = a._id AND c.status = 'active') AS activeContacts
		FROM accounts a LEFT JOIN ${AUTH_MODELS.user} u ON u.id = a.ownerId
		ORDER BY a.createdAt DESC, a._id DESC LIMIT ?`,
		[limit]
	);
}

// On: campaigns go out over hours for the next 30 days. Off: at full speed from now (lib/send-spread.js).
export async function setSendSpread(accountId, isOn) {
	const account = await updateOne("accounts", { where: "_id = ?", params: [String(accountId)] }, { set: { spreadUntil: isOn ? getSpreadEnd() : new Date() } });
	return Boolean(account);
}

// Empty values go back to the plan's numbers.
export async function setLimitOverrides(accountId, { emailsPerMonth, subscribers }) {
	const set = {};
	const unset = [];
	for (const [key, value] of Object.entries({ emailsPerMonth, subscribers })) {
		if (value === undefined) unset.push(`limitOverrides.${key}`);
		else set[`limitOverrides.${key}`] = value;
	}
	const account = await updateOne("accounts", { where: "_id = ?", params: [String(accountId)] }, { set, unset });
	return Boolean(account);
}
