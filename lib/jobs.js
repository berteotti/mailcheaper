import { connectDb, getAll, getBindings, newId, statement } from "./db.js";

// Queue messages carry only the outbox id: SES events can exceed a Queue message's 128 KB, a D1 row can't.
const PUBLISH_BATCH = 100;
const PUBLISH_PAGE = 500;
const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// `onlyIf` makes the job part of a conditional transition: it's written only when that SQL finds a row.
export function jobStatement(db, { id = newId(), kind, payload, availableAt = Date.now(), onlyIf }) {
	return statement(db, `INSERT INTO job_outbox (_id, kind, payload, availableAt, createdAt) SELECT ?, ?, ?, ?, ?
		WHERE ${onlyIf ? `EXISTS (${onlyIf.sql})` : "true"} ON CONFLICT(_id) DO NOTHING`,
	[id, kind, JSON.stringify(payload), availableAt, Date.now(), ...(onlyIf?.params ?? [])]);
}

// Commits the jobs with any state change in one D1 transaction, then publishes them. A failed publish
// stays in the outbox and the cron publishes it on its next tick.
export async function commitJobs(jobs, statements = []) {
	const db = await connectDb();
	const withIds = jobs.map((job) => ({ ...job, id: job.id ?? newId() }));
	const results = await db.batch([...statements, ...withIds.map((job) => jobStatement(db, job))]);
	try {
		await publishJobs(withIds.map(({ id }) => id));
	} catch (error) {
		console.error("[jobs] Publish deferred to the outbox:", error?.message);
	}
	return results;
}

async function getQueue() {
	const { JOBS_QUEUE } = await getBindings();
	if (!JOBS_QUEUE) throw new Error("The Cloudflare Queue binding JOBS_QUEUE is missing");
	return JOBS_QUEUE;
}

async function publishRows(rows) {
	if (rows.length === 0) return 0;
	const queue = await getQueue();
	const db = await connectDb();
	for (let index = 0; index < rows.length; index += PUBLISH_BATCH) {
		const group = rows.slice(index, index + PUBLISH_BATCH);
		try {
			await queue.sendBatch(group.map(({ _id, kind }) => ({ body: { id: _id, kind }, contentType: "json" })));
		} catch (error) {
			await db.batch(group.map(({ _id }) => statement(db,
				"UPDATE job_outbox SET attempts = attempts + 1, lastError = ? WHERE _id = ?", [String(error?.message).slice(0, 500), _id])));
			throw error;
		}
		// Publishing twice is harmless: every consumer claims its work atomically.
		await db.batch(group.map(({ _id }) => statement(db,
			"UPDATE job_outbox SET publishedAt = ?, attempts = attempts + 1, lastError = NULL WHERE _id = ? AND publishedAt IS NULL", [Date.now(), _id])));
	}
	return rows.length;
}

export async function publishJobs(ids) {
	if (ids.length === 0) return 0;
	const rows = await getAll(`SELECT _id, kind FROM job_outbox WHERE publishedAt IS NULL AND availableAt <= ?
		AND _id IN (SELECT value FROM json_each(?)) ORDER BY availableAt, rowid`, [Date.now(), JSON.stringify(ids)]);
	return publishRows(rows);
}

// The cron's recovery pass: anything committed but not yet published, oldest first.
export async function publishPendingJobs({ limit = PUBLISH_PAGE } = {}) {
	const rows = await getAll(`SELECT _id, kind FROM job_outbox WHERE publishedAt IS NULL AND availableAt <= ?
		ORDER BY availableAt, rowid LIMIT ?`, [Date.now(), limit]);
	return publishRows(rows);
}

export async function readJob(id) {
	const rows = await getAll("SELECT _id, kind, payload, completedAt FROM job_outbox WHERE _id = ?", [String(id)]);
	return rows[0] ? { ...rows[0], payload: JSON.parse(rows[0].payload) } : null;
}

export async function completeJob(id) {
	const db = await connectDb();
	await statement(db, "UPDATE job_outbox SET completedAt = coalesce(completedAt, ?) WHERE _id = ?", [Date.now(), id]).run();
}

export async function pruneCompletedJobs(now = Date.now()) {
	const db = await connectDb();
	const { meta } = await statement(db, `DELETE FROM job_outbox WHERE _id IN (SELECT _id FROM job_outbox
		WHERE completedAt IS NOT NULL AND completedAt < ? LIMIT 1000)`, [now - COMPLETED_RETENTION_MS]).run();
	return meta.changes;
}
