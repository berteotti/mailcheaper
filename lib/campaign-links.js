import "server-only";
import { accountIdOf, getAll, getOne } from "@/lib/db";
import { LINK_CLICK_EVENT, getLinkLabels } from "@/lib/link-stats";
import { renderEmail } from "@/lib/render-email";
import { getIssueWebUrl } from "@/lib/sending-rules";

export const MAX_CAMPAIGN_LINKS = 200;

// A sent campaign's clicked links, most clicked first, from its link_click events (lib/email-events.js): every click on
// each, and the contacts who clicked it at least once. clickers: the contacts who clicked any. isComplete: they hold
// every click of its send. One that started before clicks were counted per link (campaigns.linksCountedAt) has them
// since the first one counted, or since it was resumed.
export async function findCampaignLinks(campaign) {
	const params = [accountIdOf(campaign), String(campaign._id), LINK_CLICK_EVENT];
	const [links, totals] = await Promise.all([
		getAll(
			`SELECT json_extract(data, '$.key') AS key, json_extract(data, '$.url') AS url, count(*) AS clicks,
			count(DISTINCT messageId) AS clickers FROM events WHERE accountId = ? AND campaignId = ? AND type = ?
			GROUP BY 1 ORDER BY clickers DESC, clicks DESC, url LIMIT ${MAX_CAMPAIGN_LINKS}`,
			params
		),
		getOne(
			"SELECT count(DISTINCT messageId) AS clickers, min(occurredAt) AS firstAt FROM events WHERE accountId = ? AND campaignId = ? AND type = ?",
			params
		),
	]);
	const { linksCountedAt, startedAt } = campaign;
	const isComplete = Boolean(linksCountedAt && startedAt && new Date(linksCountedAt) <= new Date(startedAt));
	const firstCounted = [linksCountedAt, totals?.firstAt]
		.filter(Boolean)
		.reduce((earliest, date) => (!earliest || new Date(date) < new Date(earliest) ? date : earliest), null);
	return {
		clickers: totals?.clickers ?? 0,
		isComplete,
		countedSince: isComplete ? null : firstCounted,
		links: links.map(({ key, url, clicks, clickers }) => ({ key, url, clicks, clickers })),
	};
}

// What each of the issue's links shows (lib/link-stats.js), as its contacts got it: in its own email first, then in
// each edition's.
export function getCampaignLinkLabels({ campaign, newsletter, editions = [] }) {
	const emails = [campaign, ...editions].map(({ format, markdown, html, subject, previewText }) =>
		renderEmail({ format, markdown, html, subject, previewText, newsletter }).html
	);
	return getLinkLabels(emails, { webUrl: getIssueWebUrl({ campaign, newsletter }) });
}
