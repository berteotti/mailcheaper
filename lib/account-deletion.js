import "server-only";
import { isBlocked, isPaidStatus } from "@/lib/account-state";
import { revalidateArchive } from "@/lib/archive-data";
import { signOutEverywhere } from "@/lib/auth";
import { isCloud } from "@/lib/config";
import { accountIdOf, connectDb, getAll } from "@/lib/db";
import { forgetDeletion, recordDeletionStatement } from "@/lib/deletion-records";
import { commitJobs } from "@/lib/jobs";
import { disconnectAllApps } from "@/lib/oauth";
import { updateOne, updateStatement } from "@/lib/records";
import { resumeTenantQuietly, suspendTenantQuietly } from "@/lib/tenants";

// How long a deleted account can be restored by signing in. Then lib/account-purge.js deletes its data for good.
export const DELETION_GRACE_DAYS = 30;
const GRACE_MS = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;
const ACTIVE_CAMPAIGN_STATUSES = ["sending", "scheduled"];
const MAX_LISTED_CAMPAIGNS = 10;
// The outbox job that purges an account (runPurge in lib/account-purge.js).
export const PURGE_JOB = "purge-account";

// What keeps an account from being deleted, or null: a plan Stripe still bills, which only the billing portal
// cancels, and campaigns sending or scheduled, which their owner pauses or unschedules first.
export async function getDeletionBlockers(account) {
	const campaigns = await getAll(
		`SELECT _id, subject, status FROM campaigns WHERE accountId = ? AND status IN (SELECT value FROM json_each(?))
		ORDER BY createdAt DESC LIMIT ?`,
		[accountIdOf(account), JSON.stringify(ACTIVE_CAMPAIGN_STATUSES), MAX_LISTED_CAMPAIGNS]
	);
	const hasPlan = isCloud() && isPaidStatus(account.subscriptionStatus);
	return hasPlan || campaigns.length > 0 ? { hasPlan, campaigns } : null;
}

// at: when the outbox hands it to the queue, the purge's own time unless it's tried again later.
export function purgeJob({ accountId, purgeAt, at = purgeAt }) {
	return { kind: PURGE_JOB, payload: { accountId: String(accountId), purgeAt: purgeAt.toISOString() }, availableAt: at.getTime() };
}

export async function publishPurge(job) {
	await commitJobs([purgeJob(job)]);
}

// The account stops at once: its owner signed out everywhere, its API keys revoked, its connected apps disconnected,
// nothing sent (it counts as unpaid: lib/account-state.js) and its tenant suspended at the provider. The purge job
// commits with the deletion, its record, the revoked keys and the stopped campaigns in one batch, so the account
// never waits without one.
export async function requestDeletion({ account, user, now = new Date() }) {
	const purgeAt = new Date(now.getTime() + GRACE_MS);
	const accountId = accountIdOf(account);
	const db = await connectDb();
	await commitJobs(
		[purgeJob({ accountId, purgeAt })],
		[
			recordDeletionStatement(db, { account, email: user.email, requestedAt: now }),
			updateStatement(
				db,
				"accounts",
				{ where: "_id = ? AND json_extract(deletion, '$.requestedAt') IS NULL", params: [accountId] },
				{ set: { deletion: { requestedAt: now, purgeAt } } }
			),
			updateStatement(db, "api_keys", { where: "accountId = ? AND revokedAt IS NULL", params: [accountId] }, { set: { revokedAt: now } }),
			updateStatement(
				db,
				"campaigns",
				{ where: "accountId = ? AND status = 'scheduled'", params: [accountId] },
				{ set: { status: "draft" }, unset: ["scheduledAt"] }
			),
			updateStatement(
				db,
				"campaigns",
				{ where: "accountId = ? AND status = 'sending'", params: [accountId] },
				{ set: { status: "paused", pauseReason: "the account was deleted" } }
			),
		]
	);
	await disconnectAllApps(account);
	await suspendTenantQuietly(accountId);
	revalidateArchive();
	await signOutEverywhere(user.id);
	return { purgeAt };
}

// Signing in before the purge: the account works as it did, but its API keys and connected apps stay off.
export async function restoreAccount(account) {
	const restored = await updateOne(
		"accounts",
		{
			where: "_id = ? AND json_extract(deletion, '$.requestedAt') IS NOT NULL AND json_extract(deletion, '$.purgeStartedAt') IS NULL",
			params: [accountIdOf(account)],
		},
		{ set: { deletion: {} } }
	);
	if (!restored) return false;
	await forgetDeletion(account._id);
	if (!isBlocked(account)) await resumeTenantQuietly(account._id);
	revalidateArchive();
	return true;
}
