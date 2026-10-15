import "server-only";
import { connectDb, getOne, getValue, statement } from "@/lib/db";
import { getAccountLimits } from "@/lib/plans";
import { updateRows } from "@/lib/records";
import { CAMPAIGN_MESSAGE_KINDS } from "@/lib/sending-rules";
import { getNextUsagePeriod } from "@/lib/usage-period";

// Moves a yearly or free plan into the month that now falls in. The filter on the old end makes it happen once.
export async function rollUsagePeriod(account, now = new Date()) {
	const next = getNextUsagePeriod(account?.usage, now);
	if (!next) return account;
	const periodEnd = account.usage.periodEnd;
	await updateRows(
		"accounts",
		{
			where: "_id = ? AND json_extract(usage, '$.periodEnd') IS ?",
			params: [String(account._id), periodEnd instanceof Date ? periodEnd.toISOString() : (periodEnd ?? null)],
		},
		{ set: { "usage.periodStart": next.periodStart, "usage.periodEnd": next.periodEnd, "usage.emailsSent": 0 } }
	);
	return getOne("SELECT * FROM accounts WHERE _id = ?", [String(account._id)]);
}

// A batch of campaign emails takes what's left of the month and no more, in one atomic update. Welcome
// and confirmation emails never wait on it (addEmailsSent).
export async function claimCampaignEmails(account, wanted) {
	if (wanted <= 0) return 0;
	const limits = getAccountLimits(account);
	if (!limits) {
		await addEmailsSent(account._id, wanted);
		return wanted;
	}
	const limit = limits.emails;
	// The read and the capped increment run in one D1 batch (a transaction), so no other claim lands between them.
	const db = await connectDb();
	const sent = "coalesce(json_extract(usage, '$.emailsSent'), 0)";
	const [read] = await db.batch([
		statement(db, `SELECT ${sent} AS emailsSent FROM accounts WHERE _id = ?`, [String(account._id)]),
		statement(db, `UPDATE accounts SET usage = json_set(usage, '$.emailsSent', ${sent} + max(0, min(?, ? - ${sent}))), updatedAt = ? WHERE _id = ?`, [
			wanted,
			limit,
			Date.now(),
			String(account._id),
		]),
	]);
	const before = read.results[0]?.emailsSent;
	if (before == null) return 0;
	return Math.max(0, Math.min(wanted, limit - before));
}

export async function addEmailsSent(accountId, count) {
	if (count) await updateRows("accounts", { where: "_id = ?", params: [String(accountId)] }, { inc: { "usage.emailsSent": count } });
}

export async function countActiveContacts(accountId) {
	return (await getValue("SELECT count(*) FROM contacts WHERE accountId = ? AND status = 'active'", [String(accountId)])) ?? 0;
}

// Emails that sends already going out still have to send. Paused sends are checked again when they resume.
export async function countEmailsInFlight(accountId) {
	const count = await getValue(
		`SELECT count(*) FROM messages WHERE accountId = ? AND status IN ('queued', 'held')
		AND kind IN (SELECT value FROM json_each(?))
		AND campaignId IN (SELECT _id FROM campaigns WHERE accountId = ? AND status = 'sending')`,
		[String(accountId), JSON.stringify(CAMPAIGN_MESSAGE_KINDS), String(accountId)]
	);
	return count ?? 0;
}

export async function getUsage(account, now = new Date()) {
	const current = await rollUsagePeriod(account, now);
	const limits = getAccountLimits(current);
	const subscribers = await countActiveContacts(current._id);
	return {
		emailsSent: current.usage?.emailsSent ?? 0,
		emailsLimit: limits?.emails ?? null,
		subscribers,
		subscribersLimit: limits?.subscribers ?? null,
		periodStart: current.usage?.periodStart ?? null,
		periodEnd: current.usage?.periodEnd ?? null,
	};
}
