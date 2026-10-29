import "server-only";
import { publishPurge } from "@/lib/account-deletion";
import { isPaidStatus } from "@/lib/account-state";
import { findAccountById } from "@/lib/accounts";
import { sendAlert } from "@/lib/alerts";
import { requestRevalidation } from "@/lib/app-revalidation";
import { deleteUser } from "@/lib/auth";
import { isCloud } from "@/lib/config";
import { accountIdOf, connectDb, execute, getAll, statement } from "@/lib/db";
import { markPurged, recordDeletion } from "@/lib/deletion-records";
import { releaseDomains } from "@/lib/domains";
import { deleteImages, invalidateAccountImages } from "@/lib/image-storage";
import { disconnectAllApps } from "@/lib/oauth";
import { updateRows } from "@/lib/records";
import { releaseSharedSenders } from "@/lib/shared-sender";
import { removeTenants } from "@/lib/tenants";
import { isObjectIdString } from "@/lib/validation";

const RETRY_MS = 24 * 60 * 60 * 1000;
// Rows deleted per statement, so a large account never runs one statement past D1's limits.
const DELETE_PAGE = 5000;
// Everything else the account holds, by its accountId, children before their parents (D1's foreign keys restrict
// deletes). Newsletters, domains and uploads go after what they have at the email provider, in DNS and in storage.
const CONTENT_TABLES = ["events", "messages", "contacts", "contact_imports", "campaign_editions", "campaigns", "suppressions", "api_keys", "alerts", "account_secrets"];

// Runs when the outbox delivers the "purge-account" job, at the end of the grace period. A job for an account
// restored since, or deleted again later, does nothing. A purge that can't finish tells the admins and tries again
// the next day.
export async function runPurge({ accountId, purgeAt }) {
	if (!isObjectIdString(String(accountId)) || typeof purgeAt !== "string") return { skipped: "invalid job" };
	const account = await findAccountById(accountId);
	if (account?.deletion?.purgeAt?.toISOString() !== purgeAt) return { skipped: "not set to be purged at this time" };
	if (account.deletion.purgeAt.getTime() > Date.now()) {
		await publishPurge({ accountId, purgeAt: account.deletion.purgeAt });
		return { waiting: true };
	}
	if (isCloud() && isPaidStatus(account.subscriptionStatus)) return postpone(account, "its plan is active again. Cancel it in Stripe");
	try {
		await purgeAccount(account);
	} catch (error) {
		return postpone(account, `the purge stopped: ${error.message}`);
	}
	return { purged: true };
}

async function postpone(account, reason) {
	await sendAlert({
		accountId: null,
		key: `purge-postponed:${account._id}`,
		title: "Account purge postponed",
		detail: `Account ${account._id} was deleted by its owner, but ${reason}. The purge tries again tomorrow.`,
		path: "/admin",
	});
	await publishPurge({ accountId: account._id, purgeAt: account.deletion.purgeAt, at: new Date(Date.now() + RETRY_MS) });
	return { postponed: reason };
}

// Every step can run again, so a purge that stopped halfway picks up where it was. Once it starts, the account can't
// be restored, and signing in with its members' emails opens new ones. Its organization goes last: the account
// references it.
async function purgeAccount(account) {
	const accountId = accountIdOf(account);
	await updateRows(
		"accounts",
		{ where: "_id = ? AND json_extract(deletion, '$.purgeStartedAt') IS NULL", params: [accountId] },
		{ set: { "deletion.purgeStartedAt": new Date() } }
	);
	await deleteMembers(account);
	for (const table of CONTENT_TABLES) await deleteAccountRows(table, accountId);
	await releaseSharedSenders(account);
	await releaseDomains(account);
	await removeTenants(account);
	await deleteUploads(account);
	await deleteAccountRows("newsletters", accountId);
	await markPurged(accountId);
	await execute("DELETE FROM accounts WHERE _id = ?", [accountId]);
	if (account.organizationId) await execute("DELETE FROM organizations WHERE _id = ?", [String(account.organizationId)]);
	// The purge runs in the jobs Worker: the app Worker holds the archive's cache, so it's asked to refresh it.
	await requestRevalidation({ archive: true });
}

// A page at a time, until none is left.
async function deleteAccountRows(table, accountId) {
	const db = await connectDb();
	const key = table === "account_secrets" ? "rowid" : "_id";
	for (;;) {
		const { meta } = await statement(db, `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE accountId = ? LIMIT ?)`, [
			accountId,
			DELETE_PAGE,
		]).run();
		if (!meta?.changes) return;
	}
}

// Everyone still in the organization belongs to no other, so their users go with it. Better Auth's adapter deletes
// each user, and the database their sessions, sign-in methods, OAuth rows and membership with it.
async function deleteMembers(account) {
	await disconnectAllApps(account);
	const users = await getAll(
		`SELECT u.id AS _id, u.email FROM members m JOIN accounts a ON a.organizationId = m.organizationId JOIN users u ON u.id = m.userId
		WHERE a._id = ? ORDER BY m.role = 'owner' DESC, m.createdAt, m._id`,
		[accountIdOf(account)]
	);
	if (users[0]) await recordDeletion({ account, email: users[0].email, requestedAt: account.deletion.requestedAt });
	for (const user of users) await deleteUser({ id: user._id, email: user.email });
}

async function deleteUploads(account) {
	const accountId = accountIdOf(account);
	for (;;) {
		const uploads = await getAll("SELECT _id, url, pathname FROM uploads WHERE accountId = ? ORDER BY _id LIMIT ?", [accountId, DELETE_PAGE]);
		if (uploads.length === 0) break;
		await deleteImages(uploads);
		await execute("DELETE FROM uploads WHERE accountId = ? AND _id IN (SELECT value FROM json_each(?))", [
			accountId,
			JSON.stringify(uploads.map(({ _id }) => _id)),
		]);
	}
	await invalidateAccountImages(accountId);
}
