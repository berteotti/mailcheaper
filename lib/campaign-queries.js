import { accountIdOf, getAll, getValue } from "./db.js";

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
export const LIST_COLUMNS = "_id, accountId, newsletterId, subject, status, stats, thumbnailUrl, archiveSlug, scheduledAt, startedAt, sentAt, updatedAt";
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
