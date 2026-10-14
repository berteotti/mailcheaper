import { connectDb, newId, statement } from "./db.js";
import { sanitizeImportRow } from "./csv-import.js";

// Each row carries at most ten parameters. Small transactional batches bound Worker/D1 work.
const ROWS_PER_BATCH = 25;

export async function importContactRows({ newsletterId, rows, source = "import", db }) {
	db ??= await connectDb();
	const contacts = [...new Map(rows.map(sanitizeImportRow).filter(Boolean).map((row) => [row.email, row])).values()];
	let created = 0;
	for (let offset = 0; offset < contacts.length; offset += ROWS_PER_BATCH) {
		const group = contacts.slice(offset, offset + ROWS_PER_BATCH);
		const ids = group.map(() => newId());
		const now = Date.now();
		const statements = group.flatMap((row, index) => {
			const writes = [];
			if (row.status === "bounced" || row.status === "complained") {
				writes.push(statement(db, `INSERT INTO suppressions (_id, email, reason, detail, createdAt, updatedAt)
					VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET
					reason = CASE WHEN excluded.reason = 'complaint' THEN excluded.reason ELSE suppressions.reason END,
					detail = CASE WHEN excluded.reason = 'complaint' THEN excluded.detail ELSE suppressions.detail END,
					updatedAt = excluded.updatedAt`,
				[newId(), row.email, row.status === "complained" ? "complaint" : "bounce", source, now, now]));
			}
			const imported = Object.fromEntries(Object.entries({
				emailsReceived: row.emailsReceived, openRate: row.openRate, clickRate: row.clickRate,
			}).filter(([, value]) => value !== undefined));
			writes.push(statement(db, `INSERT INTO contacts
				(_id, newsletterId, email, status, source, subscribedAt, unsubscribedAt, imported, createdAt, updatedAt)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(newsletterId, email) DO UPDATE SET
				status = CASE
					WHEN contacts.status = 'pending' OR contacts.status = 'complained' THEN contacts.status
					WHEN excluded.status = 'complained' THEN 'complained'
					WHEN contacts.status = 'bounced' THEN contacts.status
					WHEN excluded.status = 'bounced' THEN 'bounced'
					WHEN contacts.status = 'unsubscribed' THEN contacts.status
					WHEN excluded.status = 'unsubscribed' THEN 'unsubscribed'
					WHEN contacts.status = 'dormant' THEN contacts.status
					ELSE excluded.status END,
				unsubscribedAt = CASE WHEN excluded.status = 'unsubscribed' AND contacts.status IN ('active', 'dormant')
					THEN excluded.unsubscribedAt ELSE contacts.unsubscribedAt END,
				imported = json_patch(contacts.imported, excluded.imported), updatedAt = excluded.updatedAt
				RETURNING _id`,
			[ids[index], newsletterId, row.email, row.status, source.trim(), row.subscribedAt ?? now,
				row.status === "unsubscribed" ? now : null, JSON.stringify(imported), now, now]));
			return writes;
		});
		const results = await db.batch(statements);
		const insertedIds = new Set(ids);
		for (const result of results) if (insertedIds.has(result.results?.[0]?._id)) created++;
	}
	return { created, existing: contacts.length - created, invalid: rows.length - contacts.length };
}
