import "server-only";
import { sendAlert } from "@/lib/alerts";
import { requestRevalidation } from "@/lib/app-revalidation";
import { execute, getAll, getOne } from "@/lib/db";
import { commitJobs } from "@/lib/jobs";
import { queueCampaign } from "@/lib/sending";
import { isObjectIdString } from "@/lib/validation";

export const SCHEDULED_JOB = "scheduled";
// Closer than this to its time, a job runs instead of waiting again.
const START_EARLY_MS = 60 * 1000;
// The outbox has no limit on how far ahead a job waits; kept for callers that still ask for a wake-up time.
const MAX_WAIT_MS = 6 * 24 * 60 * 60 * 1000;
const DUE_PAGE = 50;

// A wake-up time in Unix seconds for a job due at that time, at most 6 days ahead.
export function getWakeAt(at, now = Date.now()) {
	return Math.floor(Math.min(at.getTime(), now + MAX_WAIT_MS) / 1000);
}

export function isTooEarly(at, now = Date.now()) {
	return at.getTime() - now > START_EARLY_MS;
}

// One job per campaign and schedule: the id repeats for the same time, so the cron's pass (enqueueDueCampaigns)
// and this one never start a campaign twice.
function scheduledJob({ accountId, campaignId, scheduledAt }) {
	const at = scheduledAt.getTime();
	return {
		id: `scheduled:${campaignId}:${at}`,
		kind: SCHEDULED_JOB,
		payload: { accountId: String(accountId), campaignId: String(campaignId), scheduledAt: scheduledAt.toISOString() },
		availableAt: at,
	};
}

// The job waits in the outbox until its time; the minute cron publishes it then.
export async function publishScheduledSend({ accountId, campaignId, scheduledAt }) {
	await commitJobs([scheduledJob({ accountId, campaignId, scheduledAt: new Date(scheduledAt) })]);
}

// Run every minute by the cron, across accounts (due campaigns are found by time): a schedule whose job never
// made it to the outbox gets it now. A job that already ran for this time isn't written again.
export async function enqueueDueCampaigns(now = Date.now()) {
	const due = await getAll(
		`SELECT _id, accountId, scheduledAt FROM campaigns WHERE status = 'scheduled' AND scheduledAt <= ?
		ORDER BY scheduledAt LIMIT ?`,
		[now, DUE_PAGE]
	);
	if (due.length === 0) return 0;
	await commitJobs(due.map(({ _id, accountId, scheduledAt }) => scheduledJob({ accountId, campaignId: _id, scheduledAt })));
	return due.length;
}

function readScheduledAt(value) {
	const at = typeof value === "string" || Number.isFinite(value) ? new Date(value) : null;
	return at && Number.isFinite(at.getTime()) ? at : null;
}

// Runs as a "scheduled" job. A job whose campaign was rescheduled, unscheduled, sent or discarded since does
// nothing, so changing a schedule never needs to cancel the old job.
export async function runScheduledSend({ accountId, campaignId, scheduledAt }) {
	const at = readScheduledAt(scheduledAt);
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(campaignId)) || !at) return { skipped: "invalid job" };

	const campaign = await getOne("SELECT status, scheduledAt, subject FROM campaigns WHERE accountId = ? AND _id = ?", [
		String(accountId),
		String(campaignId),
	]);
	if (campaign?.status !== "scheduled" || campaign.scheduledAt?.getTime() !== at.getTime()) {
		return { skipped: "not scheduled for this time anymore" };
	}
	if (isTooEarly(campaign.scheduledAt)) {
		// This job's id is used up: the next wait is a job of its own.
		await commitJobs([{ ...scheduledJob({ accountId, campaignId, scheduledAt: campaign.scheduledAt }), id: undefined }]);
		return { waiting: true };
	}

	try {
		const result = await queueCampaign({ accountId: String(accountId), campaignId: String(campaignId) });
		await requestRevalidation({ campaignId: String(campaignId), archive: true });
		return { started: true, ...result };
	} catch (error) {
		// Only a campaign still waiting goes back to draft: one that started and then paused alerts on its own.
		const { meta } = await execute(
			`UPDATE campaigns SET status = 'draft', scheduledAt = NULL, updatedAt = ?
			WHERE accountId = ? AND _id = ? AND status = 'scheduled'`,
			[Date.now(), String(accountId), String(campaignId)]
		);
		if (meta.changes) {
			await sendAlert({
				accountId: String(accountId),
				key: `scheduled-send-${campaignId}`,
				title: "Scheduled send didn't start",
				detail: `${error.message.replace(/\.$/, "")}. "${campaign.subject || "Untitled"}" is a draft again.`,
				path: `/campaigns/${campaignId}`,
				cooldownMinutes: 1,
			});
		}
		await requestRevalidation({ campaignId: String(campaignId) });
		return { failed: error.message, ...(error.code && { code: error.code }) };
	}
}
