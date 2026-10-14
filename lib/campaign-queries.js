import { getAll, getOne, newId } from "./db.js";

export function findCampaign(id) {
	return getOne("SELECT * FROM campaigns WHERE _id = lower(?)", [id]);
}

export function listSendTimes({ newsletterId, excludeId, limit = 20 }) {
	return getAll(`SELECT status, coalesce(scheduledAt, startedAt, sentAt) AS at FROM campaigns
		WHERE _id != ? AND status IN ('scheduled', 'sending', 'paused', 'sent')
		AND (? IS NULL OR newsletterId = ?) AND coalesce(scheduledAt, startedAt, sentAt) IS NOT NULL
		ORDER BY at DESC LIMIT ?`, [excludeId, newsletterId, newsletterId, limit]);
}

export function listRecentCampaigns(limit, newsletterId) {
	return getAll(`SELECT _id, newsletterId, subject, status, stats, thumbnailUrl, archiveSlug,
		scheduledAt, startedAt, sentAt, updatedAt,
		coalesce(sentAt, startedAt, scheduledAt, updatedAt) AS activityAt FROM campaigns
		WHERE status != 'canceled' AND (? IS NULL OR newsletterId = ?)
		ORDER BY activityAt DESC, _id DESC LIMIT ?`, [newsletterId, newsletterId, limit]);
}

export async function createCampaignRecord(values) {
	const id = newId();
	const now = Date.now();
	await getOne(`INSERT INTO campaigns (_id, newsletterId, subject, previewText, format, markdown, html,
		thumbnailUrl, archiveSlug, source, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING _id`,
	[id, values.newsletterId, values.subject?.trim() ?? "", values.previewText?.trim() ?? "", values.format ?? "rich",
		values.markdown ?? "", values.html ?? "", values.thumbnailUrl, values.archiveSlug, values.source ?? "dashboard", now, now]);
	return findCampaign(id);
}
