import { runPurge } from "../lib/account-purge.js";
import { backupDatabase } from "../lib/backup.js";
import { completeJob, publishPendingJobs, pruneCompletedJobs, readJob } from "../lib/jobs.js";
import { enqueueDueCampaigns, runScheduledSend } from "../lib/scheduling.js";
import { checkFirstSend, recoverStalledSends, runSendJob } from "../lib/sending.js";
import { handlePostshibaEvent } from "../lib/postshiba-webhook.js";
import { handleSesEvent } from "../lib/ses-events.js";
import { handleTenantEvent } from "../lib/tenant-events.js";

// Must match the daily cron in alchemy.run.ts; every other trigger is the minute cron.
const BACKUP_CRON = "17 3 * * *";
// Queue retries for a thrown error back off up to this; dead-lettered jobs stay in D1's outbox.
const MAX_RETRY_DELAY_SECONDS = 15 * 60;

async function runJob(job) {
	// Provider events are stored by their webhooks; each handler records an event once, so a replay is harmless.
	if (job.kind === "ses-event") return handleSesEvent(job.payload, { eventId: job._id });
	if (job.kind === "ses-tenant-event") return handleTenantEvent(job.payload);
	if (job.kind === "postshiba-event") return handlePostshibaEvent(job.payload);
	if (job.kind === "scheduled") return runScheduledSend(job.payload);
	// Handles sending being off, and writes the retry job back to the outbox for a deferred or throttled batch,
	// so waiting never uses up the queue's retries.
	if (job.kind === "send") return runSendJob(job.payload);
	if (job.kind === "check-first-send") return checkFirstSend(job.payload);
	if (job.kind === "purge-account") return runPurge(job.payload);
	return { skipped: `unknown job kind ${job.kind}` };
}

async function handleMessage(message) {
	const job = await readJob(message.body?.id);
	if (!job || job.completedAt) return message.ack();
	try {
		const result = await runJob(job);
		await completeJob(job._id);
		console.info(`[jobs] ${JSON.stringify({ id: job._id, kind: job.kind, ...result })}`);
		message.ack();
	} catch (error) {
		console.error(`[jobs] ${job.kind} ${job._id} failed (attempt ${message.attempts}):`, error?.message);
		message.retry({ delaySeconds: Math.min(MAX_RETRY_DELAY_SECONDS, 10 * 2 ** message.attempts) });
	}
}

async function tick(name, run) {
	try {
		const result = await run();
		if (result) console.info(`[cron] ${name}: ${JSON.stringify(result)}`);
	} catch (error) {
		console.error(`[cron] ${name} failed:`, error?.message);
	}
}

const jobs = {
	// Each message is handled on its own: one failing job never retries the rest of the batch.
	async queue(batch) {
		for (const message of batch.messages) await handleMessage(message);
	},

	// Every minute: start due scheduled campaigns, publish what the outbox still holds, recover stalled
	// sends, and prune finished jobs. Once a day: a private backup.
	async scheduled(controller) {
		if (controller?.cron === BACKUP_CRON) return tick("backup", () => backupDatabase());
		await tick("schedule", () => enqueueDueCampaigns());
		await tick("outbox", () => publishPendingJobs());
		await tick("recovery", () => recoverStalledSends());
		await tick("prune", () => pruneCompletedJobs());
	},
};

export default jobs;
