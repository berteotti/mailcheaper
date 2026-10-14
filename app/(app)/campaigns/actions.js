"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { notifyActivity } from "@/lib/activity-notice";
import { PUBLISHED_STATUSES, revalidateArchive } from "@/lib/archive-data";
import { requireSession } from "@/lib/auth";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { createCampaignRecord, findCampaign as findCampaignRecord } from "@/lib/campaign-queries";
import { execute, getOne, isUniqueConstraint } from "@/lib/db";
import { getScheduleProblem } from "@/lib/schedule";
import { getCleanupPreview, queueCampaign, sendTestEmail, sendToMoreContacts } from "@/lib/sending";
import { getSendProblem } from "@/lib/sending-rules";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { firstImageUrl } from "@/lib/thumbnail";
import { MAX_BODY_BYTES, isObjectIdString as isValidObjectId } from "@/lib/validation";

const MAX_SUBJECT_LENGTH = 200;
const COPY_SUFFIX = " (copy)";
// A scheduled campaign stays editable until it goes out.
const EDITABLE_STATUSES = ["draft", "scheduled"];
const EDITABLE_SQL = "status IN ('draft', 'scheduled')";

function readAudienceLimit(value) {
	const limit = Number(value);
	return Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

function notifySend(campaign, action) {
	return notifyActivity([`${action}: ${campaign.subject || "(no subject)"}`, `${getAppUrl()}/campaigns/${campaign._id}`]);
}

function formatCount(count) {
	return count.toLocaleString("en-US");
}

async function findCampaign(id) {
	await requireSession();
	if (!isValidObjectId(id)) return null;
	return findCampaignRecord(id);
}

export async function createCampaign(newsletterId) {
	await requireSession();
	if (!isValidObjectId(newsletterId)) return { error: "Newsletter not found" };
	const newsletter = await getOne("SELECT _id FROM newsletters WHERE _id = lower(?)", [newsletterId]);
	if (!newsletter) return { error: "Newsletter not found" };

	const campaign = await createCampaignRecord({ newsletterId: newsletter._id });
	revalidatePath("/campaigns");
	redirect(`/campaigns/${campaign._id}`);
}

// The status check is part of the write, so a save can't land on a campaign that just started sending.
export async function saveCampaign(id, values) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!EDITABLE_STATUSES.includes(campaign.status)) return { error: "Only drafts can be edited" };

	const body = String(values?.body ?? "");
	const bytes = Buffer.byteLength(body, "utf8");
	if (bytes > MAX_BODY_BYTES) {
		return { error: `The content is ${Math.ceil(bytes / 1000)} KB. The limit is ${MAX_BODY_BYTES / 1000} KB.` };
	}

	// The editor opens Markdown drafts as rich text, so their first save moves them to it.
	const format = campaign.format === "markdown" ? "rich" : campaign.format;
	const thumbnailUrl = firstImageUrl({ format, html: body });
	const { meta } = await execute(`UPDATE campaigns SET subject = ?, previewText = ?, format = ?, html = ?, thumbnailUrl = ?, updatedAt = ?
		WHERE _id = ? AND ${EDITABLE_SQL}`, [
		String(values?.subject ?? "").slice(0, MAX_SUBJECT_LENGTH).trim(),
		String(values?.previewText ?? "").slice(0, 300).trim(),
		format,
		body,
		thumbnailUrl ?? null,
		Date.now(),
		campaign._id,
	]);
	if (!meta.changes) return { error: "This campaign is already sending" };

	revalidatePath("/campaigns");
	return { ok: true };
}

// Sending errors become toasts; a thrown error would replace the page with the error boundary.
async function runSend(send) {
	try {
		await send();
		return { ok: true };
	} catch (error) {
		console.error("[campaigns] Send failed:", error);
		return { error: error.message || "Sending failed" };
	}
}

export async function sendTestCampaign(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!isSendingEnabled()) return { error: "Sending is off" };

	const result = await runSend(() => sendTestEmail({ campaignId: campaign._id, to: process.env.ADMIN_EMAIL }));
	revalidatePath(`/campaigns/${id}`);
	return result;
}

// Sending a scheduled campaign now replaces its schedule; a scheduled job that still arrives then does nothing.
export async function sendCampaign(id, { audienceLimit } = {}) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!EDITABLE_STATUSES.includes(campaign.status)) return { error: "Already sent" };
	if (!isSendingEnabled()) return { error: "Sending is off" };

	campaign.audienceLimit = readAudienceLimit(audienceLimit) ?? null;
	const { meta } = await execute(`UPDATE campaigns SET audienceLimit = ?, scheduledAt = NULL,
		status = CASE status WHEN 'scheduled' THEN 'draft' ELSE status END, updatedAt = ? WHERE _id = ? AND ${EDITABLE_SQL}`,
	[campaign.audienceLimit, Date.now(), campaign._id]);
	if (!meta.changes) return { error: "Already sent" };

	const result = await runSend(() => queueCampaign(campaign._id));
	revalidatePath("/campaigns");
	revalidatePath(`/campaigns/${id}`);
	if (result.ok) {
		revalidateArchive();
		const limit = campaign.audienceLimit;
		await notifySend(campaign, limit ? `Send started (first ${formatCount(limit)})` : "Send started");
	}
	return result;
}

// Checked now and again when it goes out: content edited in between could still block the send.
export async function scheduleCampaign(id, { scheduledAt, audienceLimit } = {}) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!EDITABLE_STATUSES.includes(campaign.status)) return { error: "Already sent" };
	if (!isSendingEnabled()) return { error: "Sending is off" };

	const at = new Date(scheduledAt ?? NaN);
	const problem = getScheduleProblem(at);
	if (problem) return { error: problem };
	const newsletter = await getOne("SELECT * FROM newsletters WHERE _id = ?", [campaign.newsletterId]);
	const sendProblem = getSendProblem({ campaign, newsletter });
	if (sendProblem) return { error: sendProblem };

	// The minute cron starts it (lib/scheduling.js); a new time replaces the old one in the same row.
	const limit = readAudienceLimit(audienceLimit);
	const { meta } = await execute(`UPDATE campaigns SET status = 'scheduled', scheduledAt = ?, audienceLimit = ?, updatedAt = ?
		WHERE _id = ? AND ${EDITABLE_SQL}`, [at, limit ?? null, Date.now(), campaign._id]);
	if (!meta.changes) return { error: "The campaign changed, refresh and try again" };

	revalidatePath("/campaigns");
	revalidatePath(`/campaigns/${id}`);
	const when = `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
	await notifySend(campaign, `Send scheduled for ${when}${limit ? ` (first ${formatCount(limit)})` : ""}`);
	return { ok: true };
}

export async function unscheduleCampaign(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };

	const { meta } = await execute("UPDATE campaigns SET status = 'draft', scheduledAt = NULL, updatedAt = ? WHERE _id = ? AND status = 'scheduled'",
		[Date.now(), campaign._id]);
	if (!meta.changes) return { error: "It isn't scheduled anymore" };

	revalidatePath("/campaigns");
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

// The send dialogs ask when they open: it walks the whole list.
export async function previewCleanup(id) {
	await requireSession();
	if (!isValidObjectId(id)) return { error: "Campaign not found" };
	try {
		return await getCleanupPreview(id);
	} catch (error) {
		console.error("[campaigns] Cleanup preview failed:", error);
		return { error: error.message || "Couldn't count the list cleanup" };
	}
}

// Without a number, the campaign goes to everyone who hasn't received it yet.
export async function sendCampaignToMore(id, { additional } = {}) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!isSendingEnabled()) return { error: "Sending is off" };

	const more = readAudienceLimit(additional);
	const result = await runSend(() => sendToMoreContacts(campaign._id, more));
	revalidatePath("/campaigns");
	revalidatePath(`/campaigns/${id}`);
	if (result.ok) await notifySend(campaign, `Send to more started (${more ? `next ${formatCount(more)}` : "everyone left"})`);
	return result;
}

export async function resumeCampaign(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (campaign.status !== "paused") return { error: "Only paused campaigns can resume" };
	if (!isSendingEnabled()) return { error: "Sending is off" };

	const result = await runSend(() => queueCampaign(campaign._id));
	revalidatePath(`/campaigns/${id}`);
	if (result.ok) await notifySend(campaign, "Send resumed");
	return result;
}

export async function pauseCampaign(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	await execute("UPDATE campaigns SET status = 'paused', updatedAt = ? WHERE _id = ? AND status = 'sending'", [Date.now(), campaign._id]);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

export async function toggleArchivePin(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!campaign.archiveSlug || campaign.archiveListed === false) return { error: "Not listed on the archive" };

	await execute("UPDATE campaigns SET archivePinned = ?, updatedAt = ? WHERE _id = ?", [campaign.archivePinned ? 0 : 1, Date.now(), campaign._id]);
	revalidatePath(`/campaigns/${id}`);
	revalidateArchive();
	return { ok: true };
}

export async function duplicateCampaign(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };

	const copy = await createCampaignRecord({
		newsletterId: campaign.newsletterId,
		subject: campaign.subject ? `${campaign.subject.slice(0, MAX_SUBJECT_LENGTH - COPY_SUFFIX.length)}${COPY_SUFFIX}` : "",
		previewText: campaign.previewText,
		format: campaign.format,
		markdown: campaign.markdown,
		html: campaign.html,
		thumbnailUrl: campaign.thumbnailUrl,
		// A copy of an API draft is still content from the API key's holder, not from the dashboard.
		...(campaign.source === "api" && { source: "api" }),
	});
	revalidatePath("/campaigns");
	redirect(`/campaigns/${copy._id}`);
}

// Discarded campaigns keep everything: canceled hides them from the lists and stops a scheduled send.
export async function discardCampaign(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!EDITABLE_STATUSES.includes(campaign.status)) return { error: "Only drafts can be discarded" };

	const { meta } = await execute(`UPDATE campaigns SET status = 'canceled', scheduledAt = NULL, updatedAt = ? WHERE _id = ? AND ${EDITABLE_SQL}`,
		[Date.now(), campaign._id]);
	if (!meta.changes) return { error: "This campaign is already sending" };

	revalidatePath("/");
	revalidatePath("/campaigns");
	return { ok: true };
}

// The page lives at /p/<slug> once the issue goes out. A draft without one gets the subject's slug then.
// Slugs are unique across newsletters: /p/<slug> on the app's own domain finds an issue by slug alone.
export async function updateArchiveSlug(id, value) {
	const campaign = await findCampaign(id);
	if (!campaign || campaign.status === "canceled") return { error: "Campaign not found" };

	const slug = String(value ?? "").trim().toLowerCase().replace(/-+$/, "");
	const isPublished = PUBLISHED_STATUSES.includes(campaign.status);
	if (!slug && isPublished) return { error: "A sent issue needs a URL" };
	if (slug && !ARCHIVE_SLUG_PATTERN.test(slug)) return { error: "Use lowercase letters, digits and hyphens" };
	if (slug === (campaign.archiveSlug ?? "")) return { ok: true, archiveSlug: slug };
	if (slug && (await getOne("SELECT 1 AS found FROM campaigns WHERE _id != ? AND archiveSlug = ?", [campaign._id, slug]))) {
		return { error: "Another issue uses this URL" };
	}

	try {
		await execute("UPDATE campaigns SET archiveSlug = ?, updatedAt = ? WHERE _id = ?", [slug || null, Date.now(), campaign._id]);
	} catch (error) {
		if (isUniqueConstraint(error)) return { error: "Another issue uses this URL" };
		throw error;
	}

	revalidatePath(`/campaigns/${id}`);
	if (isPublished) {
		revalidatePath("/campaigns");
		revalidateArchive();
	}
	return { ok: true, archiveSlug: slug };
}
