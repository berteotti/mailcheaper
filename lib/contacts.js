import { connectDb, execute, getAll, getOne, newId, statement } from "./db.js";

export function listNewslettersWithActiveCounts() {
	return getAll(`SELECT n.*, (SELECT count(*) FROM contacts c WHERE c.newsletterId = n._id AND c.status = 'active') AS activeCount
		FROM newsletters n ORDER BY n.createdAt, n._id`);
}

export async function upsertContact({ newsletter, email, source, resubscribe }) {
	const now = Date.now();
	const id = newId();
	const joinStatus = newsletter.requireConfirmation ? "pending" : "active";
	const inserted = await execute(`INSERT INTO contacts (_id, newsletterId, email, status, source, subscribedAt, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(newsletterId, email) DO NOTHING`,
	[id, newsletter._id, email, joinStatus, source?.trim(), now, now, now]);
	const created = inserted.meta.changes > 0;
	if (!created && resubscribe) {
		await execute(`UPDATE contacts SET status = CASE WHEN status = 'active' THEN status ELSE ? END,
			subscribedAt = CASE WHEN status = 'active' THEN subscribedAt ELSE ? END,
			unsubscribedAt = NULL, ignoredIssues = 0, lastEngagedAt = max(coalesce(lastEngagedAt, 0), ?), updatedAt = ?
			WHERE newsletterId = ? AND email = ? AND status IN ('active', 'unsubscribed', 'dormant')
			AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = contacts.email)`,
		[joinStatus, now, now, now, newsletter._id, email]);
	}
	return { contact: await getOne("SELECT * FROM contacts WHERE newsletterId = ? AND email = ?", [newsletter._id, email]), created };
}

export async function confirmContact({ contactId, newsletterId }) {
	const now = Date.now();
	const contact = await getOne(`UPDATE contacts SET status = 'active', confirmedAt = ?, ignoredIssues = 0,
		lastEngagedAt = max(coalesce(lastEngagedAt, 0), ?), updatedAt = ?
		WHERE _id = ? AND newsletterId = ? AND status = 'pending'
		AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = contacts.email) RETURNING *`,
	[now, now, now, contactId, newsletterId]);
	return contact ? { contact, confirmed: true }
		: { contact: await getOne("SELECT * FROM contacts WHERE _id = ? AND newsletterId = ?", [contactId, newsletterId]), confirmed: false };
}

export async function keepContact({ contactId, newsletterId }) {
	const now = Date.now();
	return getOne(`UPDATE contacts SET status = 'active', ignoredIssues = 0,
		lastEngagedAt = max(coalesce(lastEngagedAt, 0), ?), updatedAt = ?
		WHERE _id = ? AND newsletterId = ? AND status IN ('active', 'dormant')
		AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = contacts.email) RETURNING *`,
	[now, now, contactId, newsletterId]);
}

// The counter and opt-out commit together; retrying an opted-out contact credits nothing.
export async function unsubscribeContact({ contactId, newsletterId }) {
	const db = await connectDb();
	const now = Date.now();
	await db.batch([
		statement(db, `UPDATE campaigns SET stats = json_set(stats, '$.unsubscribed', json_extract(stats, '$.unsubscribed') + 1), updatedAt = ?
			WHERE _id = (SELECT c._id FROM (SELECT _id, startedAt FROM campaigns WHERE newsletterId = ? AND startedAt IS NOT NULL
				ORDER BY startedAt DESC LIMIT 5) c JOIN messages m ON m.campaignId = c._id
				WHERE m.contactId = ? AND m.kind = 'campaign' AND m.sentAt IS NOT NULL ORDER BY c.startedAt DESC LIMIT 1)
			AND EXISTS (SELECT 1 FROM contacts WHERE _id = ? AND newsletterId = ? AND status IN ('active', 'dormant'))`,
		[now, newsletterId, contactId, contactId, newsletterId]),
		statement(db, `UPDATE contacts SET status = 'unsubscribed', unsubscribedAt = ?, updatedAt = ?
			WHERE _id = ? AND newsletterId = ? AND status IN ('active', 'dormant')`, [now, now, contactId, newsletterId]),
	]);
}
