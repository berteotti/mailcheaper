import "server-only";
import { sendAlert } from "@/lib/alerts";
import { assignArchiveSlug } from "@/lib/archive-slugs";
import { AUDIENCE_ORDER, buildAudiencePage, normalizeAudienceLimit } from "@/lib/audience";
import { addToPreview, emptyPreview, getCleanupSettings, splitAudience } from "@/lib/cleanup";
import { LIMITS, isSendingEnabled } from "@/lib/config";
import { getConfirmUrl } from "@/lib/confirmation";
import { getConfirmationContent } from "@/lib/confirmation-content";
import { connectDb, execute, getAll, getOne, newId, statement } from "@/lib/db";
import { commitJobs } from "@/lib/jobs";
import { getKeepUrl } from "@/lib/last-chance";
import { getLastChanceContent } from "@/lib/last-chance-content";
import { waitForSendSlot } from "@/lib/pacing";
import { mailboxProvider } from "@/lib/providers";
import { sendSesEmail } from "@/lib/ses";
import {
	CAMPAIGN_MESSAGE_KINDS,
	MAX_BATCH_MESSAGES,
	MAX_CONSECUTIVE_FAILURES,
	SEND_BATCH_SIZE,
	TEST_CONTACT_ID,
	buildRecipientEmail,
	chunk,
	getCampaignPauseReason,
	getFeedbackId,
	getNextStepLimit,
	getSendErrorAction,
	getSendProblem,
	getWelcomeContent,
} from "@/lib/sending-rules";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";

export { buildRecipientEmail } from "@/lib/sending-rules";

const QUEUEABLE_STATUSES = ["draft", "scheduled", "paused"];
// Contacts read per audience page: bounded work per D1 query, whatever the list size.
const AUDIENCE_PAGE_SIZE = 500;
const WELCOME_WINDOW_MS = 10 * 60 * 1000;
const SIGNUP_KINDS = ["welcome", "confirmation"];
// Their links have to work, so they go out clean: no tracking pixel or redirect.
const UNTRACKED_KINDS = new Set(["confirmation", "last-chance"]);
// Signing up again resends the confirmation, but a script can't make us mail an address over and over.
const MAX_CONFIRMATIONS_PER_CONTACT = 3;
// A claim this old never finished: the worker stopped somewhere around the SES call.
const STALE_CLAIM_MS = 15 * 60 * 1000;
// A sending campaign whose send jobs all finished or died this long ago gets its queued messages again.
const STALLED_CAMPAIGN_MS = 30 * 60 * 1000;
const RETRY_DELAY_MS = 60 * 1000;
const CLEANUP_COLUMNS =
	"c._id, c.email, c.ignoredIssues, c.lastEngagedAt, c.lastOpenAt, c.lastClickAt, c.confirmedAt, c.subscribedAt, c.createdAt, c.lastChanceAt";
const kindList = (kinds) => kinds.map((kind) => `'${kind}'`).join(", ");
const CAMPAIGN_KINDS_SQL = kindList(CAMPAIGN_MESSAGE_KINDS);

function assertSendingEnabled() {
	if (!isSendingEnabled()) throw new Error("Sending is off");
}

function formatError(error) {
	return String(error?.message || error).slice(0, 500);
}

function getMessageTags(message) {
	const tags = [
		{ name: "message_id", value: String(message._id) },
		{ name: "kind", value: message.kind },
	];
	if (message.campaignId) tags.push({ name: "campaign_id", value: String(message.campaignId) });
	return tags;
}

function renderMessage({ message, content, newsletter, contact }) {
	const reference = { contactId: contact._id, newsletterId: newsletter._id };
	const email = buildRecipientEmail({
		campaign: content,
		newsletter,
		contact,
		messageId: UNTRACKED_KINDS.has(message.kind) ? null : message._id,
		confirmUrl: message.kind === "confirmation" ? getConfirmUrl(reference) : "",
		keepUrl: message.kind === "last-chance" ? getKeepUrl(reference) : "",
	});
	const feedbackId = getFeedbackId({ campaignId: message.campaignId, kind: message.kind, newsletterSlug: newsletter.slug });
	return { ...email, headers: { ...email.headers, "Feedback-ID": feedbackId }, tags: getMessageTags(message) };
}

function getMessageContent({ kind, newsletter, campaign }) {
	if (kind === "welcome") return getWelcomeContent(newsletter);
	if (kind === "confirmation") return newsletter ? getConfirmationContent(newsletter) : null;
	if (kind === "last-chance") return newsletter ? getLastChanceContent(newsletter) : null;
	return campaign;
}

// Welcome and confirmation emails share one cap per newsletter, so a signup flood can't burn its sending
// domain's reputation, and a flood on one newsletter doesn't hold up the others' signup emails.
async function countRecentSignupEmails(newsletter) {
	const row = await getOne(`SELECT count(*) AS count FROM messages WHERE kind IN (${kindList(SIGNUP_KINDS)})
		AND newsletterId = ? AND createdAt >= ?`, [newsletter._id, Date.now() - WELCOME_WINDOW_MS]);
	return row.count;
}

async function alertSignupCap(newsletter) {
	await sendAlert({
		key: `welcome-cap:${newsletter.slug}`,
		title: "Signup emails capped",
		detail: `Over ${LIMITS.welcomeEmailsPer10Minutes} welcome and confirmation emails for ${newsletter.name} in 10 minutes. New signups get none until it slows down.`,
		path: "/contacts",
	});
}

async function findByIds(table, ids) {
	const uniqueIds = [...new Set(ids.filter(Boolean).map(String))];
	if (uniqueIds.length === 0) return new Map();
	const rows = await getAll(`SELECT * FROM ${table} WHERE _id IN (SELECT value FROM json_each(?))`, [JSON.stringify(uniqueIds)]);
	return new Map(rows.map((row) => [String(row._id), row]));
}

const findCampaign = (id) => getOne("SELECT * FROM campaigns WHERE _id = ?", [String(id)]);
const findNewsletter = (id) => getOne("SELECT * FROM newsletters WHERE _id = ?", [String(id)]);

async function pauseCampaign(campaignId, reason) {
	const { meta } = await execute("UPDATE campaigns SET status = 'paused', updatedAt = ? WHERE _id = ? AND status = 'sending'",
		[Date.now(), campaignId]);
	if (!meta.changes) return;
	await sendAlert({
		key: `campaign-paused-${campaignId}`,
		title: "Campaign paused",
		detail: reason,
		path: `/campaigns/${campaignId}`,
		cooldownMinutes: 1,
	});
}

async function pauseIfUnhealthy(campaignId) {
	const campaign = await getOne("SELECT stats, lastChance FROM campaigns WHERE _id = ? AND status = 'sending'", [campaignId]);
	const reason = campaign ? getCampaignPauseReason(campaign.stats, campaign.lastChance) : null;
	if (reason) await pauseCampaign(campaignId, `${reason} is over the limit`);
	return Boolean(reason);
}

// Done once nothing is queued or mid-send. Ambiguous attempts don't hold it open: they're reviewed.
async function settleCampaign(campaignId) {
	if (await pauseIfUnhealthy(campaignId)) return;
	// A campaign sent in steps keeps the date of its first step.
	const now = Date.now();
	await execute(`UPDATE campaigns SET status = 'sent', sentAt = coalesce(sentAt, ?), updatedAt = ?
		WHERE _id = ? AND status = 'sending' AND NOT EXISTS (SELECT 1 FROM messages
			WHERE campaignId = campaigns._id AND kind IN (${CAMPAIGN_KINDS_SQL}) AND status IN ('queued', 'sending'))`,
	[now, now, campaignId]);
}

// One statement per kind: the ids travel as a single JSON parameter, so pages of any size fit D1's limit.
// Rows go in in the page's order, which sendJobsFor keeps.
function insertMessagesStatement(db, campaign, kind, contacts) {
	return statement(db, `INSERT INTO messages (_id, kind, campaignId, newsletterId, contactId, email, createdAt, updatedAt)
		SELECT lower(hex(randomblob(12))), ?, ?, ?, c._id, c.email, ?, ? FROM json_each(?) j JOIN contacts c ON c._id = j.value
		WHERE c.newsletterId = ? ORDER BY j.key ON CONFLICT DO NOTHING`,
	[kind, campaign._id, campaign.newsletterId, Date.now(), Date.now(), JSON.stringify(contacts.map(({ _id }) => _id)), campaign.newsletterId]);
}

// A sign of life since the walk read them sets ignoredIssues back to 0: those contacts stay.
function makeDormantStatements(db, campaignId, contacts) {
	const ids = JSON.stringify(contacts.map(({ _id }) => _id));
	const now = Date.now();
	return [
		statement(db, `UPDATE campaigns SET lastChance = json_set(lastChance, '$.dormant', coalesce(json_extract(lastChance, '$.dormant'), 0)
			+ (SELECT count(*) FROM contacts WHERE _id IN (SELECT value FROM json_each(?)) AND status = 'active' AND ignoredIssues > 0)),
			updatedAt = ? WHERE _id = ?`, [ids, now, campaignId]),
		statement(db, `UPDATE contacts SET status = 'dormant', updatedAt = ?
			WHERE _id IN (SELECT value FROM json_each(?)) AND status = 'active' AND ignoredIssues > 0`, [now, ids]),
	];
}

// Contacts this campaign already reached on this page: an earlier step, or an attempt that stopped halfway.
async function findPreviousMessages(campaignId, contacts) {
	if (contacts.length === 0) return new Map();
	const rows = await getAll(`SELECT contactId, kind FROM messages WHERE campaignId = ? AND kind IN (${CAMPAIGN_KINDS_SQL})
		AND contactId IN (SELECT value FROM json_each(?))`, [campaignId, JSON.stringify(contacts.map(({ _id }) => _id))]);
	return new Map(rows.map(({ contactId, kind }) => [String(contactId), kind]));
}

// Active, unsuppressed contacts, most engaged first, in bounded pages.
async function* walkAudience(newsletterId, columns) {
	let after = null;
	for (;;) {
		const { sql, params } = buildAudiencePage({ newsletterId, columns, after, limit: AUDIENCE_PAGE_SIZE });
		const page = await getAll(sql, params);
		if (page.length > 0) yield page;
		if (page.length < AUDIENCE_PAGE_SIZE) return;
		after = page.at(-1);
	}
}

// Without the list cleanup, the top of the audience goes straight into D1. With it, each page is split
// in JS (lib/cleanup.js splitAudience) and the limit counts issue recipients only.
async function insertCampaignMessages(campaign, newsletter) {
	const db = await connectDb();
	const settings = getCleanupSettings(newsletter);
	const limit = normalizeAudienceLimit(campaign.audienceLimit);
	if (!settings.enabled) {
		const { sql, params } = buildAudiencePage({ newsletterId: campaign.newsletterId, limit: limit ?? -1 });
		await statement(db, `INSERT INTO messages (_id, kind, campaignId, newsletterId, contactId, email, createdAt, updatedAt)
			SELECT lower(hex(randomblob(12))), 'campaign', ?, ?, _id, email, ?, ? FROM (${sql}) ORDER BY ${AUDIENCE_ORDER} ON CONFLICT DO NOTHING`,
		[campaign._id, campaign.newsletterId, Date.now(), Date.now(), ...params]).run();
		return;
	}

	const now = Date.now();
	let remaining = limit ?? Infinity;
	for await (const page of walkAudience(campaign.newsletterId, CLEANUP_COLUMNS)) {
		const previous = await findPreviousMessages(campaign._id, page);
		const split = splitAudience(page, { settings, limit: remaining, previous, now });
		const statements = [];
		if (split.issue.length) statements.push(insertMessagesStatement(db, campaign, "campaign", split.issue));
		if (split.lastChance.length) statements.push(insertMessagesStatement(db, campaign, "last-chance", split.lastChance));
		if (split.dormant.length) statements.push(...makeDormantStatements(db, campaign._id, split.dormant));
		if (statements.length) await db.batch(statements);
		remaining -= split.issue.length + split.received;
		if (remaining <= 0) break;
	}
}

// What the list cleanup would do at this send, for the send dialogs: one walk over the whole list.
export async function getCleanupPreview(campaignId) {
	if (!isObjectIdString(String(campaignId))) throw new Error("Campaign not found");
	const campaign = await findCampaign(campaignId);
	if (!campaign) throw new Error("Campaign not found");
	const newsletter = await findNewsletter(campaign.newsletterId);
	const settings = getCleanupSettings(newsletter);
	if (!settings.enabled) return { enabled: false };

	const preview = emptyPreview();
	const now = Date.now();
	for await (const page of walkAudience(campaign.newsletterId, CLEANUP_COLUMNS)) {
		addToPreview(preview, page, { settings, previous: await findPreviousMessages(campaign._id, page), now });
	}
	return { enabled: true, ...preview };
}

async function countCampaignMessages(campaignId) {
	const row = await getOne(`SELECT coalesce(sum(kind = 'campaign'), 0) AS recipients, coalesce(sum(kind = 'last-chance'), 0) AS lastChances
		FROM messages WHERE campaignId = ? AND kind IN (${CAMPAIGN_KINDS_SQL})`, [campaignId]);
	return [row.recipients, row.lastChances];
}

// Issues first, in audience order (rowid follows the order messages were inserted; ids are random);
// last-chance emails go to the least engaged addresses, after everyone else. Queues don't
// keep that order, so the consumer also defers last-chance batches while issues are still queued.
async function sendJobsFor(campaignId) {
	const queued = await getAll(`SELECT _id, kind FROM messages WHERE campaignId = ? AND kind IN (${CAMPAIGN_KINDS_SQL})
		AND status = 'queued' ORDER BY kind, rowid`, [campaignId]);
	// A batch holds one kind, so a deferred last-chance batch never holds back issues.
	return CAMPAIGN_MESSAGE_KINDS.flatMap((kind) =>
		chunk(queued.filter((message) => message.kind === kind).map(({ _id }) => String(_id)), SEND_BATCH_SIZE)
			.map((messageIds) => ({ kind: "send", payload: { campaignId: String(campaignId), messageIds } })));
}

// The status change and its send jobs commit together, so a crash can't leave a sending campaign
// with nothing on the way.
async function startSending(campaign, update) {
	const db = await connectDb();
	const onlyIf = { sql: "SELECT 1 FROM campaigns WHERE _id = ? AND status = 'sending'", params: [campaign._id] };
	const jobs = (await sendJobsFor(campaign._id)).map((job) => ({ ...job, onlyIf }));
	const [result] = await commitJobs(jobs, [statement(db, update.sql, update.params)]);
	if (!result.meta.changes) throw new Error("The campaign changed, refresh and try again");
	if (jobs.length === 0) await settleCampaign(campaign._id);
	return jobs.length;
}

// Draft or scheduled: selects the audience. Paused: resumes with the audience it already has.
export async function queueCampaign(campaignId) {
	assertSendingEnabled();
	if (!isObjectIdString(String(campaignId))) throw new Error("Campaign not found");

	const campaign = await findCampaign(campaignId);
	if (!campaign) throw new Error("Campaign not found");
	if (!QUEUEABLE_STATUSES.includes(campaign.status)) throw new Error(`Campaign is already ${campaign.status}`);
	const newsletter = await findNewsletter(campaign.newsletterId);
	const problem = getSendProblem({ campaign, newsletter });
	if (problem) throw new Error(problem);

	if (campaign.status !== "paused") await insertCampaignMessages(campaign, newsletter);
	const [recipients, lastChances] = await countCampaignMessages(campaign._id);
	if (recipients + lastChances === 0) throw new Error("No active contacts to send to");

	try {
		await assignArchiveSlug({ campaign, newsletter });
	} catch (error) {
		throw new Error(`Could not prepare the archive page: ${formatError(error)}`);
	}
	const now = Date.now();
	const batches = await startSending(campaign, {
		sql: `UPDATE campaigns SET status = 'sending', startedAt = coalesce(startedAt, ?),
			stats = json_set(stats, '$.recipients', CAST(? AS INTEGER)), lastChance = json_set(lastChance, '$.recipients', CAST(? AS INTEGER)), updatedAt = ?
			WHERE _id = ? AND status = ?`,
		params: [now, recipients, lastChances, now, campaign._id, campaign.status],
	});
	return { recipients, batches };
}

// Sending in steps: a sent campaign goes to the next most engaged contacts. It takes the top of the
// audience again and the one-email-per-contact index skips everyone who already received it.
export async function sendToMoreContacts(campaignId, additional) {
	assertSendingEnabled();
	if (!isObjectIdString(String(campaignId))) throw new Error("Campaign not found");

	const campaign = await findCampaign(campaignId);
	if (!campaign) throw new Error("Campaign not found");
	if (campaign.status !== "sent") throw new Error("Wait until the current step has gone out");
	const newsletter = await findNewsletter(campaign.newsletterId);
	const problem = getSendProblem({ campaign, newsletter });
	if (problem) throw new Error(problem);

	const [sentSoFar, lastChancesSoFar] = await countCampaignMessages(campaign._id);
	const audienceLimit = getNextStepLimit({ sentSoFar, additional }) ?? null;
	await insertCampaignMessages({ ...campaign, audienceLimit }, newsletter);
	const [recipients, lastChances] = await countCampaignMessages(campaign._id);
	if (recipients === sentSoFar && lastChances === lastChancesSoFar) throw new Error("Everyone has received it already");

	const batches = await startSending(campaign, {
		sql: `UPDATE campaigns SET status = 'sending', audienceLimit = ?, stats = json_set(stats, '$.recipients', CAST(? AS INTEGER)),
			lastChance = json_set(lastChance, '$.recipients', CAST(? AS INTEGER)), updatedAt = ? WHERE _id = ? AND status = 'sent'`,
		params: [audienceLimit, recipients, lastChances, Date.now(), campaign._id],
	});
	return { added: recipients - sentSoFar, recipients, batches };
}

async function markQueued(messageId) {
	await execute("UPDATE messages SET status = 'queued', claimedAt = NULL, updatedAt = ? WHERE _id = ? AND status = 'sending'",
		[Date.now(), messageId]);
}

// The trigger in migrations/0002 counts the send on the campaign and the contact.
async function recordSent(message, { sesMessageId }) {
	const now = Date.now();
	await execute(`UPDATE messages SET status = 'sent', sesMessageId = ?, sentAt = ?, error = NULL, updatedAt = ?
		WHERE _id = ? AND status IN ('sending', 'ambiguous')`, [sesMessageId, now, now, message._id]);
	return new Date(now);
}

async function recordFailed(message, error) {
	await execute("UPDATE messages SET status = 'failed', error = ?, updatedAt = ? WHERE _id = ? AND status IN ('queued', 'sending')",
		[formatError(error), Date.now(), message._id]);
}

// SES may have accepted it: never resend blindly. A later SES event for its message_id tag settles it.
async function recordAmbiguous(message, error) {
	await execute("UPDATE messages SET status = 'ambiguous', error = ?, updatedAt = ? WHERE _id = ? AND status = 'sending'",
		[`Unconfirmed send: ${formatError(error)}`, Date.now(), message._id]);
}

async function claimMessage(message) {
	const now = Date.now();
	const requiredStatus = message.kind === "confirmation" ? "pending" : "active";
	const claimed = await getOne(`UPDATE messages SET status = 'sending', claimedAt = ?, provider = ?, updatedAt = ?
		WHERE _id = ? AND status = 'queued'
		AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = messages.email)
		AND EXISTS (SELECT 1 FROM contacts c WHERE c._id = messages.contactId AND c.status = ?)
		AND (kind NOT IN (${CAMPAIGN_KINDS_SQL}) OR EXISTS (SELECT 1 FROM campaigns WHERE _id = messages.campaignId AND status = 'sending'))
		RETURNING _id`, [now, mailboxProvider(message.email), now, message._id, requiredStatus]);
	return Boolean(claimed);
}

async function hasQueuedIssues(campaignId) {
	const row = await getOne(`SELECT count(*) AS count FROM messages WHERE campaignId = ? AND kind = 'campaign'
		AND status IN ('queued', 'sending')`, [campaignId]);
	return row.count;
}

// At most once per message: the queued -> sending claim happens before SES is called. `deferMs` asks the
// caller to try the batch again later; nothing in it was sent.
export async function sendMessageBatch(messageIds) {
	assertSendingEnabled();
	const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).map((id) => String(id).toLowerCase()))]
		.filter(isObjectIdString)
		.slice(0, MAX_BATCH_MESSAGES);
	const result = { sent: 0, failed: 0, suppressed: 0, skipped: 0, ambiguous: 0, retry: false, deferMs: 0 };
	if (ids.length === 0) return result;

	const order = new Map(ids.map((id, index) => [id, index]));
	const messages = (await getAll(`SELECT * FROM messages WHERE _id IN (SELECT value FROM json_each(?)) AND status = 'queued'
		AND kind IN (${kindList([...CAMPAIGN_MESSAGE_KINDS, ...SIGNUP_KINDS])})`, [JSON.stringify(ids)]))
		.sort((a, b) => order.get(a._id) - order.get(b._id));
	result.skipped = ids.length - messages.length;
	if (messages.length === 0) return result;

	const [campaigns, newsletters, contacts] = await Promise.all([
		findByIds("campaigns", messages.map(({ campaignId }) => campaignId)),
		findByIds("newsletters", messages.map(({ newsletterId }) => newsletterId)),
		findByIds("contacts", messages.map(({ contactId }) => contactId)),
	]);
	for (const campaignId of campaigns.keys()) await pauseIfUnhealthy(campaignId);

	// Last-chance emails wait for the issue to reach everyone else. Batches hold one kind (sendJobsFor).
	if (messages.every(({ kind }) => kind === "last-chance")) {
		const waiting = await hasQueuedIssues(messages[0].campaignId);
		if (waiting > 0) {
			result.retry = true;
			result.deferMs = Math.max(RETRY_DELAY_MS, Math.ceil((waiting / LIMITS.sendRatePerSecond) * 1000));
			return result;
		}
	}

	let consecutiveFailures = 0;
	for (const message of messages) {
		if (!isSendingEnabled()) {
			result.retry = true;
			break;
		}
		const campaign = campaigns.get(String(message.campaignId)) ?? null;
		await waitForSendSlot();
		if (!(await claimMessage(message))) {
			// Not claimed: another consumer has it, the campaign stopped, or the contact can't get it anymore.
			const { meta } = await execute(`UPDATE messages SET status = 'suppressed', updatedAt = ? WHERE _id = ? AND status = 'queued'
				AND (EXISTS (SELECT 1 FROM suppressions s WHERE s.email = messages.email)
					OR NOT EXISTS (SELECT 1 FROM contacts c WHERE c._id = messages.contactId AND c.status = ?))
				AND (kind NOT IN (${CAMPAIGN_KINDS_SQL}) OR EXISTS (SELECT 1 FROM campaigns WHERE _id = messages.campaignId AND status = 'sending'))`,
			[Date.now(), message._id, message.kind === "confirmation" ? "pending" : "active"]);
			if (meta.changes) result.suppressed++;
			else result.skipped++;
			continue;
		}

		const newsletter = newsletters.get(String(message.newsletterId));
		const contact = contacts.get(String(message.contactId));
		const content = getMessageContent({ kind: message.kind, newsletter, campaign });
		try {
			if (!newsletter || !content) throw new Error("Newsletter or email content not found");
			const email = renderMessage({ message, content, newsletter, contact });
			// Only an error from the SES call itself can be ambiguous (lib/ses.js).
			const { sesMessageId } = await sendSesEmail(email);
			await recordSent(message, { sesMessageId });
			result.sent++;
			consecutiveFailures = 0;
		} catch (error) {
			if (error?.ambiguous) {
				console.error("[sending] Unconfirmed send:", error?.stack ?? error);
				await recordAmbiguous(message, error);
				result.ambiguous++;
				await sendAlert({
					key: "ambiguous-send",
					title: "Unconfirmed send",
					detail: `SES didn't confirm a send (${formatError(error)}). It won't be resent automatically.`,
					path: campaign ? `/campaigns/${campaign._id}` : "",
				});
				continue;
			}
			const action = campaign ? getSendErrorAction(error) : "fail";
			if (action === "fail") {
				await recordFailed(message, error);
				result.failed++;
				consecutiveFailures++;
				if (!campaign || consecutiveFailures < MAX_CONSECUTIVE_FAILURES) continue;
				await pauseCampaign(campaign._id, `${consecutiveFailures} sends failed in a row`);
				break;
			}
			await markQueued(message._id);
			if (action === "pause") await pauseCampaign(campaign._id, formatError(error));
			else {
				result.retry = true;
				result.deferMs = RETRY_DELAY_MS;
			}
			break;
		}
	}

	for (const campaignId of campaigns.keys()) await settleCampaign(campaignId);
	return result;
}

// Run by the cron: claims that never finished become ambiguous, and sending campaigns whose jobs all
// finished or died get their queued messages published again. Duplicates are harmless.
export async function recoverStalledSends(now = Date.now()) {
	const { meta } = await execute(`UPDATE messages SET status = 'ambiguous', error = 'Unconfirmed send: the worker stopped mid-send',
		updatedAt = ? WHERE status = 'sending' AND claimedAt < ?`, [now, now - STALE_CLAIM_MS]);
	if (meta.changes) {
		await sendAlert({
			key: "ambiguous-send",
			title: "Unconfirmed sends",
			detail: `${meta.changes} sends stopped before SES answered. They won't be resent automatically.`,
		});
	}
	if (!isSendingEnabled()) return { ambiguous: meta.changes, republished: 0 };

	const stalled = await getAll(`SELECT c._id FROM campaigns c WHERE c.status = 'sending' AND c.updatedAt < ?
		AND EXISTS (SELECT 1 FROM messages m WHERE m.campaignId = c._id AND m.status = 'queued')
		AND NOT EXISTS (SELECT 1 FROM job_outbox j WHERE j.kind = 'send' AND j.completedAt IS NULL AND j.createdAt >= ?
			AND json_extract(j.payload, '$.campaignId') = c._id) LIMIT 20`, [now - STALLED_CAMPAIGN_MS, now - STALLED_CAMPAIGN_MS]);
	let republished = 0;
	for (const { _id } of stalled) {
		const jobs = await sendJobsFor(_id);
		await commitJobs(jobs);
		republished += jobs.length;
	}
	return { ambiguous: meta.changes, republished };
}

async function sendTest({ content, newsletter, campaignId, to }) {
	const email = normalizeEmail(to);
	if (!email) throw new Error("The test email address is invalid");
	const problem = getSendProblem({ campaign: content, newsletter });
	if (problem) throw new Error(problem);

	const now = Date.now();
	const message = await getOne(`INSERT INTO messages (_id, kind, campaignId, newsletterId, email, provider, status, claimedAt, createdAt, updatedAt)
		VALUES (?, 'test', ?, ?, ?, ?, 'sending', ?, ?, ?) RETURNING *`,
	[newId(), campaignId ?? null, newsletter._id, email, mailboxProvider(email), now, now, now]);
	let sesMessageId;
	try {
		await waitForSendSlot();
		({ sesMessageId } = await sendSesEmail(renderMessage({
			message,
			content: { ...content, subject: `[Test] ${content.subject}` },
			newsletter,
			contact: { _id: TEST_CONTACT_ID, email },
		})));
	} catch (error) {
		if (error?.ambiguous) await recordAmbiguous(message, error);
		else await recordFailed(message, error);
		throw error;
	}
	const sentAt = await recordSent(message, { sesMessageId });
	return { messageId: String(message._id), sesMessageId, sentAt };
}

export async function sendTestEmail({ campaignId, to }) {
	assertSendingEnabled();
	if (!isObjectIdString(String(campaignId))) throw new Error("Campaign not found");

	const campaign = await findCampaign(campaignId);
	if (!campaign) throw new Error("Campaign not found");
	const newsletter = await findNewsletter(campaign.newsletterId);
	const result = await sendTest({ content: campaign, newsletter, campaignId: campaign._id, to });
	await execute("UPDATE campaigns SET testSentAt = ?, updatedAt = ? WHERE _id = ?", [result.sentAt, Date.now(), campaign._id]);
	return result;
}

// Sends the saved welcome email, whether or not it's switched on yet.
export async function sendWelcomeTestEmail({ newsletterId, to }) {
	assertSendingEnabled();
	if (!isObjectIdString(String(newsletterId))) throw new Error("Newsletter not found");

	const newsletter = await findNewsletter(newsletterId);
	if (!newsletter) throw new Error("Newsletter not found");
	const content = getWelcomeContent({ welcome: { ...newsletter.welcome, enabled: true } });
	if (!content) throw new Error("Save a subject and content first");
	return sendTest({ content, newsletter, to });
}

const isSuppressed = async (email) => Boolean(await getOne("SELECT 1 AS found FROM suppressions WHERE email = ?", [email]));

export async function queueWelcomeEmail({ newsletter, contact }) {
	assertSendingEnabled();
	const content = getWelcomeContent(newsletter);
	if (!content) return { skipped: "welcome email is off" };
	if (contact?.status !== "active") return { skipped: "contact is not active" };

	const [suppressed, hasWelcome, recentWelcomes] = await Promise.all([
		isSuppressed(contact.email),
		getOne("SELECT 1 AS found FROM messages WHERE kind = 'welcome' AND contactId = ?", [contact._id]),
		countRecentSignupEmails(newsletter),
	]);
	if (suppressed) return { skipped: "suppressed" };
	if (hasWelcome) return { skipped: "already sent" };
	if (recentWelcomes >= LIMITS.welcomeEmailsPer10Minutes) {
		await alertSignupCap(newsletter);
		return { skipped: "rate limited" };
	}
	const problem = getSendProblem({ campaign: content, newsletter });
	if (problem) {
		console.warn(`[sending] Welcome email for ${newsletter.slug} not sent: ${problem}`);
		return { skipped: problem };
	}
	return sendSignupEmail({ kind: "welcome", newsletter, contact });
}

export async function queueConfirmationEmail({ newsletter, contact }) {
	assertSendingEnabled();
	if (contact?.status !== "pending") return { skipped: "contact is not pending" };

	const [suppressed, confirmations, recentSignupEmails] = await Promise.all([
		isSuppressed(contact.email),
		getOne(`SELECT count(*) AS total, coalesce(sum(createdAt >= ?), 0) AS recent FROM messages
			WHERE kind = 'confirmation' AND contactId = ?`, [Date.now() - WELCOME_WINDOW_MS, contact._id]),
		countRecentSignupEmails(newsletter),
	]);
	if (suppressed) return { skipped: "suppressed" };
	if (confirmations.recent > 0 || confirmations.total >= MAX_CONFIRMATIONS_PER_CONTACT) return { skipped: "already sent" };
	if (recentSignupEmails >= LIMITS.welcomeEmailsPer10Minutes) {
		await alertSignupCap(newsletter);
		return { skipped: "rate limited" };
	}
	return sendSignupEmail({ kind: "confirmation", newsletter, contact });
}

// Sent right away, through the same claim, pacing and ambiguity rules as campaign batches.
async function sendSignupEmail({ kind, newsletter, contact }) {
	const now = Date.now();
	const messageId = newId();
	await execute(`INSERT INTO messages (_id, kind, newsletterId, contactId, email, provider, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [messageId, kind, newsletter._id, contact._id, contact.email, mailboxProvider(contact.email), now, now]);
	return { messageId, ...(await sendMessageBatch([messageId])) };
}
