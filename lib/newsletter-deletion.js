import "server-only";
import { COUNTED_KINDS } from "@/lib/account-health";
import { revalidateArchive } from "@/lib/archive-data";
import { isCloud } from "@/lib/config";
import { accountIdOf, connectDb, execute, getAll, getValue, statement } from "@/lib/db";
import { syncArchiveHosts } from "@/lib/domains";
import { ACCOUNT_CHECK_DAYS } from "@/lib/sending-rules";
import { releaseSharedSender } from "@/lib/shared-sender";

// A new newsletter sets up a sending subdomain at the email provider and its DNS records, out of budgets every
// account shares: without a limit, deleting and adding again would be a loop.
export const NEWSLETTER_DELETIONS = { name: "account-newsletter-deletions", limit: 3, window: "1 d" };
const ACTIVE_CAMPAIGN_STATUSES = ["sending", "scheduled"];
const MAX_LISTED_CAMPAIGNS = 10;
const CHECK_MS = ACCOUNT_CHECK_DAYS * 24 * 60 * 60 * 1000;
// Rows deleted per statement, like an account's purge.
const DELETE_PAGE = 5000;
// The newsletter's rows, children before their parents (D1's foreign keys restrict deletes): ?1 is the account,
// ?2 the newsletter. Its contacts' imports go too; the account's suppressions stay.
const NEWSLETTER_ROWS = [
	["events", "campaignId IN (SELECT _id FROM campaigns WHERE accountId = ?1 AND newsletterId = ?2)"],
	["events", "messageId IN (SELECT _id FROM messages WHERE accountId = ?1 AND newsletterId = ?2)"],
	["messages", "accountId = ?1 AND newsletterId = ?2"],
	["contacts", "accountId = ?1 AND newsletterId = ?2"],
	["contact_imports", "accountId = ?1 AND newsletterId = ?2"],
	["campaign_editions", "campaignId IN (SELECT _id FROM campaigns WHERE accountId = ?1 AND newsletterId = ?2)"],
	["campaigns", "accountId = ?1 AND newsletterId = ?2"],
];

// What keeps a newsletter from being deleted, or null: campaigns sending or scheduled, which their owner pauses or
// unschedules first, and on MailCheap Cloud, emails it sent in the last days. Those count toward the account's
// bounce and complaint rates (lib/account-health.js), which a deletion mustn't wipe: availableAt is when it can go.
export async function getNewsletterDeletionBlockers(account, newsletter, now = new Date()) {
	const accountId = accountIdOf(account);
	const [campaigns, lastSentAt] = await Promise.all([
		getAll(
			`SELECT _id, subject, status FROM campaigns WHERE accountId = ? AND newsletterId = ? AND status IN (SELECT value FROM json_each(?))
			ORDER BY createdAt DESC LIMIT ?`,
			[accountId, String(newsletter._id), JSON.stringify(ACTIVE_CAMPAIGN_STATUSES), MAX_LISTED_CAMPAIGNS]
		),
		isCloud()
			? getValue(
					`SELECT max(sentAt) FROM messages WHERE accountId = ? AND newsletterId = ? AND sentAt >= ?
					AND kind IN (SELECT value FROM json_each(?))`,
					[accountId, String(newsletter._id), now.getTime() - CHECK_MS, JSON.stringify(COUNTED_KINDS)]
				)
			: null,
	]);
	const availableAt = lastSentAt ? new Date(lastSentAt + CHECK_MS) : null;
	return campaigns.length > 0 || availableAt ? { campaigns, availableAt } : null;
}

// For good, a page at a time. Every step can run again, so a deletion that stopped halfway finishes when it's tried
// again: the newsletter itself goes last.
export async function deleteNewsletter(account, newsletter) {
	const accountId = accountIdOf(account);
	const db = await connectDb();
	for (const [table, where] of NEWSLETTER_ROWS) {
		for (;;) {
			const { meta } = await statement(db, `DELETE FROM ${table} WHERE _id IN (SELECT _id FROM ${table} WHERE ${where} LIMIT ?3)`, [
				accountId,
				String(newsletter._id),
				DELETE_PAGE,
			]).run();
			if (!meta?.changes) break;
		}
	}
	await releaseSharedSender(account, newsletter);
	await execute("DELETE FROM newsletters WHERE accountId = ? AND _id = ?", [accountId, String(newsletter._id)]);
	await syncArchiveHosts(accountId);
	revalidateArchive();
}
