import "server-only";
import { blockAccount } from "@/lib/account-blocks";
import { sendAlert } from "@/lib/alerts";
import { getOne } from "@/lib/db";
import { updateOne, updateRows } from "@/lib/records";
import { ACCOUNT_CHECK_DAYS, getAccountRateProblem } from "@/lib/sending-rules";

// A burst of bounces runs the check once a minute at most, not once per event.
const CHECK_INTERVAL_MS = 60_000;
const WARNING_COOLDOWN_MINUTES = 24 * 60;
export const COUNTED_KINDS = ["campaign", "last-chance", "welcome", "confirmation"];

async function claimCheck(accountId, now) {
	const cutoff = new Date(now.getTime() - CHECK_INTERVAL_MS);
	// health.checkedAt is an ISO string inside the JSON column.
	const claimed = await updateOne(
		"accounts",
		{ where: "_id = ? AND (json_extract(health, '$.checkedAt') IS NULL OR json_extract(health, '$.checkedAt') < ?)", params: [String(accountId), cutoff.toISOString()] },
		{ set: { "health.checkedAt": now } }
	);
	return Boolean(claimed);
}

export async function countRecentSends(accountId, now = new Date()) {
	const since = new Date(now.getTime() - ACCOUNT_CHECK_DAYS * 24 * 60 * 60 * 1000);
	const counts = await getOne(
		`SELECT count(*) AS sent, count(deliveredAt) AS delivered, count(bouncedAt) AS bounced, count(complainedAt) AS complained
		FROM messages WHERE accountId = ? AND sentAt >= ? AND kind IN (SELECT value FROM json_each(?))`,
		[String(accountId), since, JSON.stringify(COUNTED_KINDS)]
	);
	return { sent: counts?.sent ?? 0, delivered: counts?.delivered ?? 0, bounced: counts?.bounced ?? 0, complained: counts?.complained ?? 0 };
}

// After each bounce or complaint: per-campaign limits catch one bad send, this catches an account whose sends
// are each just under them. Over the block level, the whole account is blocked until an admin unblocks it; over the
// pause level, its owner is warned at most once a day. isUrgent: runs even within a minute of the last check.
export async function checkAccountHealth(accountId, { now = new Date(), isUrgent = false } = {}) {
	if (!(await claimCheck(accountId, now)) && !isUrgent) return null;
	const counts = await countRecentSends(accountId, now);
	const ratio = (value) => (counts.sent ? value / counts.sent : 0);
	await updateRows(
		"accounts",
		{ where: "_id = ?", params: [String(accountId)] },
		{
			set: {
				"health.sent": counts.sent,
				"health.delivered": counts.delivered,
				"health.bounceRate": ratio(counts.bounced),
				"health.complaintRate": ratio(counts.complained),
			},
		}
	);
	const problem = getAccountRateProblem(counts);
	if (problem?.level === "block") await blockAccount(accountId, { reason: problem.reason, by: "rates" });
	if (problem?.level === "pause") {
		await sendAlert({
			accountId,
			key: "rates-warning",
			title: "Bounces or complaints are high",
			detail: problem.reason,
			path: "/",
			cooldownMinutes: WARNING_COOLDOWN_MINUTES,
		});
	}
	return { ...counts, level: problem?.level ?? null, reason: problem?.reason ?? null };
}
