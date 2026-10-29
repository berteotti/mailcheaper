import "server-only";
import { RECIPIENT_COUNTS_SQL, toRecipientCounts } from "@/lib/campaign-recipient-rules";
import { accountIdOf, getAll } from "@/lib/db";
import { MESSAGE_STATS_FIELDS, MESSAGE_STATS_SQL } from "@/lib/message-stats";
import { COMPARED_ISSUES, TIMELINE_HOURS, buildTimeline, compareRates } from "@/lib/report-stats";

const HOUR_MS = 60 * 60 * 1000;

// A sent campaign's results by inbox provider, most sent first, how many recipients each of the recipients' filters
// picks (lib/campaign-recipient-rules.js), and its first opens and clicks hour by hour. timeline is null for a send
// with no start time.
export async function getCampaignActivity(campaign, { now = new Date() } = {}) {
	const params = [accountIdOf(campaign), String(campaign._id)];
	const [rows, hours] = await Promise.all([
		getAll(
			`SELECT coalesce(provider, 'other') AS provider, ${MESSAGE_STATS_SQL}, ${RECIPIENT_COUNTS_SQL} FROM messages
			WHERE accountId = ? AND campaignId = ? AND kind = 'campaign' GROUP BY 1 ORDER BY sent DESC`,
			params
		),
		getAll(
			`SELECT openedAt / ${HOUR_MS} AS openHour, clickedAt / ${HOUR_MS} AS clickHour, count(*) AS count FROM messages
			WHERE accountId = ? AND campaignId = ? AND kind = 'campaign' AND (openedAt IS NOT NULL OR clickedAt IS NOT NULL)
			GROUP BY 1, 2`,
			params
		),
	]);
	const startedAt = campaign.startedAt ?? campaign.sentAt;
	return {
		providers: rows
			.filter(({ sent }) => sent > 0)
			.map((row) => ({ provider: row.provider, ...Object.fromEntries(Object.keys(MESSAGE_STATS_FIELDS).map((key) => [key, row[key] ?? 0])) })),
		timeline: startedAt
			? buildTimeline({ startedAt, now, opens: sumByHour(hours, "openHour"), clicks: sumByHour(hours, "clickHour") })
			: null,
		recipients: toRecipientCounts(rows),
	};
}

// The newsletter's last issues before this one, for the report's "vs average". isSettled: the send is old enough for
// its own rates to stop climbing; before that it would always trail the average.
export async function getCampaignComparison(campaign, { now = new Date() } = {}) {
	if (!campaign.startedAt) return null;
	const previous = await getAll(
		`SELECT stats FROM campaigns WHERE accountId = ? AND newsletterId = ? AND _id != ? AND status = 'sent' AND startedAt < ?
		ORDER BY startedAt DESC LIMIT ?`,
		[accountIdOf(campaign), String(campaign.newsletterId), String(campaign._id), campaign.startedAt, COMPARED_ISSUES]
	);
	const comparison = compareRates(campaign.stats, previous.map(({ stats }) => stats));
	const isSettled = now.getTime() - new Date(campaign.startedAt).getTime() >= TIMELINE_HOURS * HOUR_MS;
	return comparison && { ...comparison, isSettled };
}

// [{ at: hour start, count }] for buildTimeline, from rows counted by open hour and click hour.
function sumByHour(rows, key) {
	const counts = new Map();
	for (const row of rows) {
		if (row[key] === null || row[key] === undefined) continue;
		counts.set(row[key], (counts.get(row[key]) ?? 0) + row.count);
	}
	return [...counts].map(([hour, count]) => ({ at: new Date(hour * HOUR_MS), count }));
}
