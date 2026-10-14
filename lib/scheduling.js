import "server-only";
import { sendAlert } from "@/lib/alerts";
import { requestRevalidation } from "@/lib/app-revalidation";
import { execute, getAll, getOne } from "@/lib/db";
import { commitJobs } from "@/lib/jobs";
import { queueCampaign } from "@/lib/sending";
import { isObjectIdString } from "@/lib/validation";

const DUE_PAGE = 50;

// Run every minute by the cron: due campaigns get one job per campaign and schedule. The job id repeats
// for the same schedule, so a missed or overlapping tick never starts a campaign twice; a later tick
// picks up whatever an earlier one missed.
export async function enqueueDueCampaigns(now = Date.now()) {
	const due = await getAll(`SELECT _id, scheduledAt FROM campaigns WHERE status = 'scheduled' AND scheduledAt <= ?
		ORDER BY scheduledAt LIMIT ?`, [now, DUE_PAGE]);
	if (due.length === 0) return 0;
	await commitJobs(due.map(({ _id, scheduledAt }) => ({
		id: `scheduled:${_id}:${scheduledAt.getTime()}`,
		kind: "scheduled",
		payload: { campaignId: _id, scheduledAt: scheduledAt.getTime() },
	})));
	return due.length;
}

// A job whose campaign was rescheduled, unscheduled, sent or discarded since does nothing, so changing a
// schedule never needs to cancel the old job.
export async function runScheduledSend({ campaignId, scheduledAt }) {
	if (!isObjectIdString(String(campaignId)) || !Number.isFinite(scheduledAt)) return { skipped: "invalid job" };

	const campaign = await getOne("SELECT status, scheduledAt, subject FROM campaigns WHERE _id = ?", [campaignId]);
	if (campaign?.status !== "scheduled" || campaign.scheduledAt?.getTime() !== scheduledAt) {
		return { skipped: "not scheduled for this time anymore" };
	}

	try {
		const result = await queueCampaign(String(campaignId));
		await requestRevalidation({ campaignId, archive: true });
		return { started: true, ...result };
	} catch (error) {
		// Only a campaign still waiting goes back to draft: one that started and then paused alerts on its own.
		const { meta } = await execute(`UPDATE campaigns SET status = 'draft', scheduledAt = NULL, updatedAt = ?
			WHERE _id = ? AND status = 'scheduled' AND scheduledAt = ?`, [Date.now(), campaignId, scheduledAt]);
		if (meta.changes) {
			await sendAlert({
				key: `scheduled-send-${campaignId}`,
				title: "Scheduled send didn't start",
				detail: `${error.message}. "${campaign.subject || "Untitled"}" is a draft again.`,
				path: `/campaigns/${campaignId}`,
				cooldownMinutes: 1,
			});
		}
		await requestRevalidation({ campaignId });
		return { failed: error.message };
	}
}
