import { backupDatabase } from "../lib/backup.js";
import { isSendingEnabled } from "../lib/config.js";
import { commitJobs, completeJob, publishPendingJobs, pruneCompletedJobs, readJob } from "../lib/jobs.js";
import { enqueueDueCampaigns, runScheduledSend } from "../lib/scheduling.js";
import { recoverStalledSends, sendMessageBatch } from "../lib/sending.js";
import { handleSesEvent } from "../lib/ses-events.js";

// Must match the daily cron in alchemy.run.ts; every other trigger is the minute cron.
const BACKUP_CRON = "17 3 * * *";
// Queue retries for a thrown error back off up to this; dead-lettered jobs stay in D1's outbox.
const MAX_RETRY_DELAY_SECONDS = 15 * 60;

async function runJob(job) {
	if (job.kind === "ses-event") return handleSesEvent(job.payload);
	if (job.kind === "scheduled") return runScheduledSend(job.payload);
	if (job.kind === "send") {
		// Off: nothing is sent and the job ends. The cron republishes queued messages once it's back on.
		if (!isSendingEnabled()) return { skipped: "sending is off" };
		const result = await sendMessageBatch(job.payload.messageIds);
		// Deferred batches go back through the outbox, so waiting never uses up the queue's retries.
		if (result.retry && result.deferMs) {
			await commitJobs([{ kind: "send", payload: job.payload, availableAt: Date.now() + result.deferMs }]);
		}
		return result;
	}
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
