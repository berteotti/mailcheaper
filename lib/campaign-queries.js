import { accountIdOf, getAll, getValue } from "./db.js";
import { describeAudience, getCampaignLanguage, getEditionMatcher } from "./editions.js";
import { DEFAULT_LANGUAGE, getLanguageTag } from "./languages.js";
import { MESSAGE_STATS_SQL } from "./message-stats.js";

const SENT_OR_SCHEDULED_SQL = "'scheduled', 'sending', 'paused', 'sent'";

// When the account's other issues went out, newest first. A schedule counts as the time picked, before
// and after it sends.
export function listSendTimes({ accountId, newsletterId, excludeId, limit = 20 }) {
	return getAll(
		`SELECT status, coalesce(scheduledAt, startedAt, sentAt) AS at FROM campaigns
		WHERE accountId = ? AND _id != ? AND status IN (${SENT_OR_SCHEDULED_SQL})
		AND (? IS NULL OR newsletterId = ?) AND coalesce(scheduledAt, startedAt, sentAt) IS NOT NULL
		ORDER BY at DESC LIMIT ?`,
		[accountIdOf(accountId), String(excludeId ?? ""), newsletterId ?? null, newsletterId ?? null, limit]
	);
}

// The fields campaign lists show: issues also carry their HTML (up to 500 KB each), which lists never read.
export const LIST_COLUMNS =
	"_id, accountId, newsletterId, subject, status, stats, thumbnailUrl, archiveSlug, scheduledAt, startedAt, sentAt, updatedAt, language, languageRegion";
// Every column but the content, for the API's lists.
export const SUMMARY_COLUMNS = `${LIST_COLUMNS}, previewText, format, archiveListed, archivePinned, audienceLimit, sendingUntil,
	spreadHours, testSentAt, pauseReason, pauseCode, source, createdAt, lastChance, firstSend`;

// Sent issues sort by send date, scheduled ones by the time they go out (so upcoming sends lead) and
// drafts by their last edit: imported issues all share the import time as updatedAt and createdAt.
export function listRecentCampaigns({ accountId, limit, newsletterId, status, columns = LIST_COLUMNS }) {
	return getAll(
		`SELECT ${columns}, coalesce(sentAt, startedAt, scheduledAt, updatedAt) AS activityAt FROM campaigns
		WHERE accountId = ? AND (CASE WHEN ? IS NULL THEN status != 'canceled' ELSE status = ? END)
		AND (? IS NULL OR newsletterId = ?)
		ORDER BY activityAt DESC, _id DESC LIMIT ?`,
		[accountIdOf(accountId), status ?? null, status ?? null, newsletterId ?? null, newsletterId ?? null, limit]
	);
}

// Campaigns that started sending: the next one's place in the account's warm-up (lib/send-spread.js).
export function countStartedCampaigns(account) {
	return getValue("SELECT count(*) FROM campaigns WHERE accountId = ? AND startedAt IS NOT NULL", [accountIdOf(account)]);
}

// Active contacts this account never emailed: a send to more than the first slice goes in steps (lib/first-send.js).
export function countNewContacts(account, newsletterId) {
	return getValue("SELECT count(*) FROM contacts WHERE accountId = ? AND newsletterId = ? AND status = 'active' AND lastSentAt IS NULL", [
		accountIdOf(account),
		String(newsletterId),
	]);
}

// The dashboard's lists: one newsletter's campaigns, in the account's own data.
export function listNewsletterCampaigns(account, newsletterId, limit) {
	return listRecentCampaigns({ accountId: accountIdOf(account), newsletterId: String(newsletterId), limit });
}

// The languages of each campaign's editions (lib/editions.js), oldest first, by campaign.
export async function listEditionLanguages(account, campaignIds) {
	const rows = await getAll(
		`SELECT campaignId, language, languageRegion FROM campaign_editions WHERE accountId = ? AND campaignId IN (SELECT value FROM json_each(?))
		ORDER BY createdAt, rowid`,
		[accountIdOf(account), JSON.stringify(campaignIds.map(String))]
	);
	const byCampaign = new Map(campaignIds.map((id) => [String(id), []]));
	for (const row of rows) byCampaign.get(String(row.campaignId))?.push(getLanguageTag(row));
	return byCampaign;
}

// A newsletter's active contacts by language, as tags (pt-BR), most first: those without one count as its own.
export function countActiveByLanguage(account, newsletter) {
	return getAll(
		`SELECT coalesce(language || coalesce('-' || languageRegion, ''), ?) AS language, count(*) AS contacts FROM contacts
		WHERE accountId = ? AND newsletterId = ? AND status = 'active' GROUP BY 1 ORDER BY contacts DESC, language`,
		[getLanguageTag(newsletter) ?? DEFAULT_LANGUAGE, accountIdOf(account), String(newsletter._id)]
	);
}

// A campaign's editions in other languages (lib/editions.js), oldest first: those added together in the order given.
export function findEditions(campaign) {
	return getAll("SELECT * FROM campaign_editions WHERE accountId = ? AND campaignId = ? ORDER BY createdAt, rowid", [
		accountIdOf(campaign),
		String(campaign._id),
	]);
}

const sumContacts = (rows) => rows.reduce((sum, { contacts }) => sum + contacts, 0);

// Who a campaign goes to: its newsletter's active contacts by language with what each gets (describeAudience), all
// of them (active) and those in its languages (reached), before suppressions and the list cleanup.
export async function getCampaignAudience(campaign, newsletter, editions) {
	const counts = newsletter ? await countActiveByLanguage(campaign, newsletter) : [];
	const audience = describeAudience(getEditionMatcher({ campaign, newsletter, editions }), counts);
	return { audience, active: sumContacts(counts), reached: sumContacts(audience.filter(({ edition }) => edition)) };
}

// A sent issue's results by the language each contact got, most sent first.
export async function listResultsByLanguage(campaign, newsletter, editions) {
	const rows = await getAll(
		`SELECT editionId, ${MESSAGE_STATS_SQL} FROM messages WHERE accountId = ? AND campaignId = ? AND kind = 'campaign'
		GROUP BY editionId HAVING sum(sentAt IS NOT NULL) > 0 ORDER BY sent DESC`,
		[accountIdOf(campaign), String(campaign._id)]
	);
	const languages = new Map(editions.map((edition) => [String(edition._id), getLanguageTag(edition)]));
	return rows.map(({ editionId, ...stats }) => ({
		language: editionId ? languages.get(String(editionId)) : getCampaignLanguage(campaign, newsletter),
		...stats,
	}));
}
