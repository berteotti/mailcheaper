import "server-only";
import { BLOCKED_CAMPAIGN_REASON, blockAccount } from "@/lib/account-blocks";
import {
	ERROR_CODES,
	codedError,
	getAccountSendProblem,
	getPlanLimitProblem,
	hasActiveSubscription,
	isBlocked,
} from "@/lib/account-state";
import { sendAlert } from "@/lib/alerts";
import { getLinkBaseUrl } from "@/lib/archive-hosts";
import { assignArchiveSlug } from "@/lib/archive-slugs";
import { buildAudiencePage, languageFilter } from "@/lib/audience";
import { findEditions } from "@/lib/campaign-queries";
import { addToPreview, emptyPreview, getCleanupSettings, splitAudience, summarizePreview } from "@/lib/cleanup";
import { LIMITS, isSendingEnabled } from "@/lib/config";
import { getConfirmUrl } from "@/lib/confirmation";
import { getConfirmationContent } from "@/lib/confirmation-content";
import { connectDb, execute, getAll, getOne, getValue, json, statement } from "@/lib/db";
import { getCampaignLanguage, getEditionContent, getEditionMatcher } from "@/lib/editions";
import { getEmailProvider } from "@/lib/email-provider";
import { FIRST_SEND, getFirstSendProblem, getFirstSendSlice } from "@/lib/first-send";
import { commitJobs } from "@/lib/jobs";
import { getLanguageName, getLanguageTag } from "@/lib/languages";
import { getKeepUrl } from "@/lib/last-chance";
import { getLastChanceContent } from "@/lib/last-chance-content";
import { getNewsletterPagePath } from "@/lib/newsletters";
import { mailboxProvider } from "@/lib/providers";
import { insertRow } from "@/lib/records";
import { waitForSendSlot } from "@/lib/send-rate";
import { getBatchStarts, getSpreadEnd, getSpreadHours, getSpreadMs } from "@/lib/send-spread";
import { createSenderCache, loadSender } from "@/lib/sender";
import {
	CAMPAIGN_MESSAGE_KINDS,
	MAX_BATCH_MESSAGES,
	MAX_CONSECUTIVE_FAILURES,
	SEND_BATCH_SIZE,
	TEST_CONTACT_ID,
	buildRecipientEmail,
	chunk,
	getCampaignRateProblem,
	getCampaignSendProblem,
	getFeedbackId,
	getNextStepLimit,
	getSendErrorAction,
	getSendProblem,
	getWelcomeContent,
} from "@/lib/sending-rules";
import { blockAccountForHold } from "@/lib/tenant-events";
import { ensureTenant } from "@/lib/tenants";
import {
	addEmailsSent,
	claimCampaignEmails,
	countActiveContacts,
	countEmailsInFlight,
	rollUsagePeriod,
} from "@/lib/usage";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";

export { buildRecipientEmail } from "@/lib/sending-rules";

// Job kinds in the outbox (lib/jobs.js), run by the queue consumer (worker/jobs.js).
export const SEND_JOB = "send";
export const CHECK_FIRST_SEND_JOB = "check-first-send";

const QUEUEABLE_STATUSES = ["draft", "scheduled", "paused"];
// What keeps a send open: emails still to go, held for the first-send check, or claimed and mid-call. Ambiguous
// attempts don't: they're reconciled from the provider's events, never resent.
const WAITING_STATUSES_SQL = "'queued', 'held', 'sending'";
const FIRST_SEND_PAUSE_CODE = "first_send_slice";
const RATES_PAUSE_CODE = "high_rates";
// Resuming from one of these pauses is the owner accepting the rates: only the block level stops the send then.
const RATE_PAUSE_CODES = new Set([FIRST_SEND_PAUSE_CODE, RATES_PAUSE_CODE]);
// Contacts read per audience page: bounded work per D1 query, whatever the list size.
const AUDIENCE_PAGE_SIZE = 500;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const WELCOME_WINDOW_MS = 10 * 60 * 1000;
const SIGNUP_KINDS = ["welcome", "confirmation"];
// Their links have to work, so they go out clean: no tracking pixel or redirect.
const UNTRACKED_KINDS = new Set(["confirmation", "last-chance"]);
// Signing up again resends the confirmation, but a script can't make us mail an address over and over.
const MAX_CONFIRMATIONS_PER_CONTACT = 3;
// When the provider is full and says nothing more precise.
const DEFAULT_RETRY_SECONDS = 60;
const MAX_RETRY_SECONDS = 3600;
// A claim this old never finished: the worker stopped somewhere around the provider call.
const STALE_CLAIM_MS = 15 * MINUTE_MS;
// A sending campaign whose send jobs all finished or died this long ago gets its queued messages again.
const STALLED_CAMPAIGN_MS = 30 * MINUTE_MS;
const STALLED_PAGE = 20;
// Why a send stopped halfway; it resumes from the campaign's page once the reason is gone.
const PAUSE_REASONS = {
	[ERROR_CODES.subscriptionRequired]: "the account has no active plan",
	[ERROR_CODES.accountBlocked]: BLOCKED_CAMPAIGN_REASON,
	[ERROR_CODES.planLimitEmails]: "this month's emails are used up",
};
const CLEANUP_COLUMNS =
	"c._id, c.email, c.lastSentAt, c.ignoredIssues, c.lastEngagedAt, c.lastOpenAt, c.lastClickAt, c.confirmedAt, c.subscribedAt, c.createdAt, c.lastChanceAt, c.language, c.languageRegion";
const AUDIENCE_COLUMNS = "c._id, c.email, c.lastSentAt, c.language, c.languageRegion";
const kindList = (kinds) => kinds.map((kind) => `'${kind}'`).join(", ");
const CAMPAIGN_KINDS_SQL = kindList(CAMPAIGN_MESSAGE_KINDS);
const SENDABLE_KINDS_SQL = kindList([...CAMPAIGN_MESSAGE_KINDS, ...SIGNUP_KINDS]);

// Codes from lib/actions/errors.js, so the API and MCP can tell these apart.
function fail(code, message) {
	return codedError({ code, message });
}

function assertSendingEnabled() {
	if (!isSendingEnabled()) throw fail("sending_disabled", "Sending is off");
}

function formatError(error) {
	return String(error?.message || error).slice(0, 500);
}

function normalizeLimit(audienceLimit) {
	const limit = Number(audienceLimit);
	return Number.isInteger(limit) && limit > 0 ? limit : null;
}

// A from address the account can't use, or a check the email itself fails (lib/sending-rules.js).
function sendProblemError(problem, sender) {
	return fail(problem === sender?.problem ? "sender_not_allowed" : "send_check_failed", problem);
}

function senderNotAllowed(problem) {
	return Object.assign(new Error(problem), { name: "SenderNotAllowed" });
}

// Each batch or test reads the account's tenant once, creating it if the plan started without one.
function createTenantLoader(account) {
	let tenant;
	return () => (tenant ??= ensureTenant(account));
}

// sender: the from address checked against the account's domains (lib/sender.js), for every kind of email.
// The email goes through the account's tenant at the email provider (lib/email-provider). The caller has claimed
// the message (status "sending") first; only an error from the provider call itself can be ambiguous.
async function deliver({ message, content, newsletter, contact, sender, getTenant }) {
	if (sender.problem) throw senderNotAllowed(sender.problem);
	const provider = getEmailProvider();
	const tenant = await getTenant();
	const reference = { contactId: contact._id, newsletterId: newsletter._id };
	const baseUrl = getLinkBaseUrl(newsletter);
	const createdAt = new Date(message.createdAt ?? Date.now()).getTime();
	const email = buildRecipientEmail({
		campaign: content,
		newsletter,
		contact,
		sender,
		messageId: UNTRACKED_KINDS.has(message.kind) ? null : message._id,
		confirmUrl: message.kind === "confirmation" ? getConfirmUrl(reference, baseUrl, createdAt) : "",
		keepUrl: message.kind === "last-chance" ? getKeepUrl(reference, baseUrl, createdAt) : "",
	});
	const feedbackId = getFeedbackId({
		campaignId: message.campaignId,
		kind: message.kind,
		newsletterSlug: newsletter.slug,
	});
	await waitForSendSlot(provider.getSendLane(message.kind));
	const { providerMessageId } = await provider.sendEmail({ tenant, message, email, feedbackId });
	return { providerMessageId, sentAt: new Date() };
}

// An issue goes out in the edition picked for its contact when the send started (editionId), or in the campaign's own
// content.
function getMessageContent({ message, newsletter, campaign, editions }) {
	const { kind, editionId } = message;
	if (kind === "welcome") return getWelcomeContent(newsletter);
	if (kind === "confirmation") return newsletter ? getConfirmationContent(newsletter) : null;
	if (kind === "last-chance") return newsletter ? getLastChanceContent(newsletter) : null;
	if (!editionId || !campaign) return campaign;
	const edition = editions.get(String(editionId));
	return edition ? getEditionContent(campaign, edition) : null;
}

// Welcome and confirmation emails share one cap per newsletter, so a signup flood can't burn its sending
// domain's reputation, and a flood on one newsletter doesn't hold up the others' signup emails.
function countRecentSignupEmails(newsletter) {
	return getValue(
		`SELECT count(*) FROM messages WHERE accountId = ? AND kind IN (${kindList(SIGNUP_KINDS)}) AND newsletterId = ? AND createdAt >= ?`,
		[newsletter.accountId, newsletter._id, Date.now() - WELCOME_WINDOW_MS]
	);
}

async function alertSignupCap(newsletter) {
	await sendAlert({
		accountId: newsletter.accountId,
		key: `welcome-cap:${newsletter.slug}`,
		title: "Signup emails capped",
		detail: `Over ${LIMITS.welcomeEmailsPer10Minutes} welcome and confirmation emails for ${newsletter.name} in 10 minutes. New signups get none until it slows down.`,
		path: getNewsletterPagePath(newsletter._id, "/contacts"),
	});
}

const TABLES = new Set(["campaigns", "campaign_editions", "newsletters", "contacts"]);

async function findByIds(table, accountId, ids) {
	if (!TABLES.has(table)) throw new Error(`Not a table: ${table}`);
	const uniqueIds = [...new Set(ids.filter(Boolean).map(String))];
	if (uniqueIds.length === 0) return new Map();
	const rows = await getAll(`SELECT * FROM ${table} WHERE accountId = ? AND _id IN (SELECT value FROM json_each(?))`, [
		accountId,
		JSON.stringify(uniqueIds),
	]);
	return new Map(rows.map((row) => [String(row._id), row]));
}

async function findAccount(accountId) {
	const account = isObjectIdString(String(accountId)) ? await getOne("SELECT * FROM accounts WHERE _id = ?", [String(accountId)]) : null;
	if (!account) throw fail("not_found", "Account not found");
	return account;
}

function findCampaign(accountId, campaignId) {
	return getOne("SELECT * FROM campaigns WHERE accountId = ? AND _id = ?", [accountId, String(campaignId)]);
}

function findNewsletter(accountId, newsletterId) {
	return getOne("SELECT * FROM newsletters WHERE accountId = ? AND _id = ?", [accountId, String(newsletterId)]);
}

// isQuiet: the account's block that comes with it already tells the owner.
async function pauseCampaign({ accountId, campaignId, reason, code, isQuiet = false }) {
	const { meta } = await execute(
		"UPDATE campaigns SET status = 'paused', pauseReason = ?, pauseCode = ?, updatedAt = ? WHERE accountId = ? AND _id = ? AND status = 'sending'",
		[reason, code ?? null, Date.now(), accountId, String(campaignId)]
	);
	if (!meta.changes || isQuiet) return;
	await sendAlert({
		accountId,
		key: `campaign-paused-${campaignId}`,
		title: "Campaign paused",
		detail: reason,
		path: `/campaigns/${campaignId}`,
		cooldownMinutes: 1,
	});
}

// Over the block level a send blocks its whole account, which pauses it with the others: "block". Over the pause
// level it pauses alone and its owner is emailed: "pause", unless its owner resumed it from such a pause already
// (ratesAcceptedAt), and then only the block level stops it.
async function stopIfUnhealthy(accountId, campaignId) {
	const campaign = await getOne(
		"SELECT stats, lastChance, ratesAcceptedAt FROM campaigns WHERE accountId = ? AND _id = ? AND status = 'sending'",
		[accountId, String(campaignId)]
	);
	const problem = campaign ? getCampaignRateProblem(campaign.stats, campaign.lastChance) : null;
	if (!problem || (problem.level === "pause" && campaign.ratesAcceptedAt)) return null;
	if (problem.level === "block") {
		await blockAccount(accountId, { reason: problem.reason, by: "campaign" });
		await pauseCampaign({ accountId, campaignId, reason: BLOCKED_CAMPAIGN_REASON, code: ERROR_CODES.accountBlocked, isQuiet: true });
	} else {
		await pauseCampaign({ accountId, campaignId, reason: problem.reason, code: RATES_PAUSE_CODE });
	}
	return problem.level;
}

// Done once nothing is queued, held or mid-send. A campaign sent in steps keeps the date of its first step.
async function settleCampaign(accountId, campaignId) {
	if (await stopIfUnhealthy(accountId, campaignId)) return;
	const now = Date.now();
	await execute(
		`UPDATE campaigns SET status = 'sent', sentAt = coalesce(sentAt, ?), sendingUntil = NULL, updatedAt = ?
		WHERE accountId = ? AND _id = ? AND status = 'sending' AND NOT EXISTS (SELECT 1 FROM messages
			WHERE accountId = campaigns.accountId AND campaignId = campaigns._id AND kind IN (${CAMPAIGN_KINDS_SQL})
			AND status IN (${WAITING_STATUSES_SQL}))`,
		[now, now, accountId, String(campaignId)]
	);
}

// One statement per kind and page: the contacts travel as a single JSON parameter, so pages of any size fit D1's
// limit. Rows go in in the page's order, which is the send order (batchJobs). Contacts never mailed are marked for the
// first-send slice (lib/first-send.js). The one-email-per-contact indexes skip whoever already has it. An issue goes
// in with the edition its contact reads (lib/editions.js); last-chance emails are the newsletter's.
function insertMessagesStatement(db, campaign, kind, contacts) {
	const now = Date.now();
	const rows = contacts.map(({ _id, editionId }) => ({ id: _id, editionId: kind === "campaign" ? (editionId ?? null) : null }));
	return statement(
		db,
		`INSERT INTO messages (_id, accountId, kind, campaignId, newsletterId, contactId, email, editionId, firstSend, createdAt, updatedAt)
		SELECT lower(hex(randomblob(12))), c.accountId, ?, ?, c.newsletterId, c._id, c.email, json_extract(j.value, '$.editionId'),
			CASE WHEN ? = 'campaign' AND c.lastSentAt IS NULL THEN 1 END, ?, ?
		FROM json_each(?) j JOIN contacts c ON c._id = json_extract(j.value, '$.id')
		WHERE c.accountId = ? AND c.newsletterId = ? ORDER BY j.key ON CONFLICT DO NOTHING`,
		[kind, campaign._id, kind, now, now, JSON.stringify(rows), campaign.accountId, campaign.newsletterId]
	);
}

// A sign of life since the walk read them sets ignoredIssues back to 0: those contacts stay.
function makeDormantStatements(db, campaign, contacts) {
	const ids = JSON.stringify(contacts.map(({ _id }) => _id));
	const now = Date.now();
	const match = "accountId = ? AND _id IN (SELECT value FROM json_each(?)) AND status = 'active' AND ignoredIssues > 0";
	return [
		statement(
			db,
			`UPDATE campaigns SET lastChance = json_set(lastChance, '$.dormant', coalesce(json_extract(lastChance, '$.dormant'), 0)
			+ (SELECT count(*) FROM contacts WHERE ${match})), updatedAt = ? WHERE accountId = ? AND _id = ?`,
			[campaign.accountId, ids, now, campaign.accountId, campaign._id]
		),
		statement(db, `UPDATE contacts SET status = 'dormant', updatedAt = ? WHERE ${match}`, [now, campaign.accountId, ids]),
	];
}

// Contacts this campaign already reached on this page: an earlier step, or an attempt that stopped halfway.
async function findPreviousMessages(campaign, contacts) {
	if (contacts.length === 0) return new Map();
	const rows = await getAll(
		`SELECT contactId, kind FROM messages WHERE accountId = ? AND campaignId = ? AND kind IN (${CAMPAIGN_KINDS_SQL})
		AND contactId IN (SELECT value FROM json_each(?))`,
		[campaign.accountId, campaign._id, JSON.stringify(contacts.map(({ _id }) => _id))]
	);
	return new Map(rows.map(({ contactId, kind }) => [String(contactId), kind]));
}

// Active, unsuppressed contacts reading one of the campaign's languages, most engaged first (lib/audience.js), in
// bounded pages. Each carries the edition it gets (lib/editions.js).
async function* walkAudience(campaign, columns, matcher, newsletter) {
	const filter = languageFilter(matcher.languages, newsletter);
	let after = null;
	for (;;) {
		const { sql, params } = buildAudiencePage({
			accountId: campaign.accountId,
			newsletterId: campaign.newsletterId,
			columns,
			filter,
			after,
			limit: AUDIENCE_PAGE_SIZE,
		});
		const rows = await getAll(sql, params);
		const page = rows.map((contact) => ({ ...contact, editionId: matcher.pick(contact) })).filter(({ editionId }) => editionId !== undefined);
		if (page.length > 0) yield page;
		if (rows.length < AUDIENCE_PAGE_SIZE) return;
		after = rows.at(-1);
	}
}

// Without the list cleanup, the top of the audience goes in page by page. With it, each page is split
// (lib/cleanup.js splitAudience) and the limit counts issue recipients only.
async function insertCampaignMessages(campaign, newsletter, editions) {
	const db = await connectDb();
	const settings = getCleanupSettings(newsletter);
	const matcher = getEditionMatcher({ campaign, newsletter, editions });
	const now = Date.now();
	let remaining = normalizeLimit(campaign.audienceLimit) ?? Infinity;
	for await (const page of walkAudience(campaign, settings.enabled ? CLEANUP_COLUMNS : AUDIENCE_COLUMNS, matcher, newsletter)) {
		if (!settings.enabled) {
			const issue = page.slice(0, remaining);
			await insertMessagesStatement(db, campaign, "campaign", issue).run();
			remaining -= issue.length;
			if (remaining <= 0) break;
			continue;
		}
		const previous = await findPreviousMessages(campaign, page);
		const split = splitAudience(page, { settings, limit: remaining, previous, now });
		const statements = [];
		if (split.issue.length) statements.push(insertMessagesStatement(db, campaign, "campaign", split.issue));
		if (split.lastChance.length) statements.push(insertMessagesStatement(db, campaign, "last-chance", split.lastChance));
		if (split.dormant.length) statements.push(...makeDormantStatements(db, campaign, split.dormant));
		if (statements.length) await db.batch(statements);
		remaining -= split.issue.length + split.received;
		if (remaining <= 0) break;
	}
}

// What the list cleanup would do at this send: one read-only walk over the whole list.
async function walkCleanupPreview({ campaign, newsletter, editions, settings }) {
	const preview = emptyPreview();
	const now = Date.now();
	const matcher = getEditionMatcher({ campaign, newsletter, editions });
	for await (const page of walkAudience(campaign, CLEANUP_COLUMNS, matcher, newsletter)) {
		addToPreview(preview, page, { settings, previous: await findPreviousMessages(campaign, page), now });
	}
	return preview;
}

export async function getCleanupPreview({ accountId, campaignId }) {
	if (!isObjectIdString(String(campaignId))) throw fail("not_found", "Campaign not found");
	const campaign = await getOne("SELECT _id, accountId, newsletterId, language, languageRegion FROM campaigns WHERE accountId = ? AND _id = ?", [
		String(accountId),
		String(campaignId),
	]);
	if (!campaign) throw fail("not_found", "Campaign not found");
	const newsletter = await getOne("SELECT slug, cleanup, language, languageRegion FROM newsletters WHERE accountId = ? AND _id = ?", [
		campaign.accountId,
		campaign.newsletterId,
	]);
	const settings = getCleanupSettings(newsletter);
	if (!settings.enabled) return { enabled: false };
	return { enabled: true, ...(await walkCleanupPreview({ campaign, newsletter, editions: await findEditions(campaign), settings })) };
}

// The emails a send would add, counted before anything is written: the list cleanup makes contacts
// dormant as the send walks the list, so the plan check can't wait for that walk.
async function countNewEmails({ campaign, newsletter, editions, audienceLimit, issuesSoFar = 0 }) {
	const settings = getCleanupSettings(newsletter);
	if (settings.enabled) {
		const { issue, lastChance } = summarizePreview(await walkCleanupPreview({ campaign, newsletter, editions, settings }), audienceLimit);
		return Math.max(0, issue - issuesSoFar) + lastChance;
	}
	const filter = languageFilter(getEditionMatcher({ campaign, newsletter, editions }).languages, newsletter);
	const audience = await getValue(
		`SELECT count(*) FROM contacts c WHERE c.accountId = ? AND c.newsletterId = ? AND c.status = 'active' ${filter.sql}
		AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.accountId = c.accountId AND s.email = c.email)`,
		[campaign.accountId, campaign.newsletterId, ...filter.params]
	);
	return Math.max(0, Math.min(normalizeLimit(audienceLimit) ?? Infinity, audience) - issuesSoFar);
}

function countQueuedEmails(campaign) {
	return getValue(
		`SELECT count(*) FROM messages WHERE accountId = ? AND campaignId = ? AND kind IN (${CAMPAIGN_KINDS_SQL}) AND status IN ('queued', 'held')`,
		[campaign.accountId, campaign._id]
	);
}

// Jobs and the state changes they belong to commit only while the campaign is still sending.
function whileSending(campaign) {
	return { sql: "SELECT 1 FROM campaigns WHERE accountId = ? AND _id = ? AND status = 'sending'", params: [campaign.accountId, campaign._id] };
}

function firstSendCheckJob(campaign, at) {
	return {
		kind: CHECK_FIRST_SEND_JOB,
		payload: { accountId: String(campaign.accountId), campaignId: String(campaign._id) },
		availableAt: new Date(at).getTime(),
	};
}

// In a spread send (lib/send-spread.js) each batch waits for its start time; like every batch, it checks the
// campaign's rates first. A batch holds one kind, issues first, each in audience order: a deferred last-chance
// batch never holds back issues (sendMessageBatch). Queues have no per-account flow control: every batch claims its
// messages one by one, and all of them share the provider's rate (lib/send-rate.js).
function batchJobs(campaign, messages, spreadMs = 0, now = Date.now()) {
	const batches = CAMPAIGN_MESSAGE_KINDS.flatMap((kind) =>
		chunk(
			messages.filter((message) => message.kind === kind).map(({ _id }) => String(_id)),
			SEND_BATCH_SIZE
		)
	);
	const starts = getBatchStarts(batches.length, spreadMs, now);
	return batches.map((messageIds, index) => ({
		kind: SEND_JOB,
		payload: { accountId: String(campaign.accountId), campaignId: String(campaign._id), messageIds },
		availableAt: starts[index] ? starts[index] * 1000 : now,
	}));
}

// The held rest of a spread send takes its own share of the spread's hours, like the slice did.
function getRestSpreadMs(campaign, held) {
	if (!campaign.sendingUntil || !campaign.spreadHours) return 0;
	const total = (campaign.stats?.recipients ?? 0) + (campaign.lastChance?.recipients ?? 0);
	return total > 0 ? Math.round((campaign.spreadHours * HOUR_MS * held) / total) : 0;
}

function countFirstSendSlice(campaign) {
	return getOne(
		`SELECT coalesce(sum(status IN ('queued', 'sending')), 0) AS queued, coalesce(sum(sentAt IS NOT NULL), 0) AS sent,
			coalesce(sum(bouncedAt IS NOT NULL), 0) AS bounced, coalesce(sum(complainedAt IS NOT NULL), 0) AS complained
		FROM messages WHERE accountId = ? AND campaignId = ? AND kind = 'campaign' AND firstSend = 1 AND status != 'held'`,
		[campaign.accountId, campaign._id]
	);
}

// Runs as a check-first-send job: a slice still going out waits a little more; a slice over the block level
// blocks the account, one over the pause level holds the rest until its owner resumes; a good one lets them go.
export async function checkFirstSend({ accountId, campaignId }) {
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(campaignId))) return { skipped: "invalid job" };
	const campaign = await getOne(
		"SELECT _id, accountId, status, sendingUntil, spreadHours, stats, lastChance FROM campaigns WHERE accountId = ? AND _id = ?",
		[String(accountId), String(campaignId)]
	);
	if (!campaign) return { skipped: "campaign not found" };
	const held = await getAll("SELECT _id, kind FROM messages WHERE accountId = ? AND campaignId = ? AND status = 'held' ORDER BY rowid", [
		campaign.accountId,
		campaign._id,
	]);
	if (held.length === 0) return { skipped: "nothing held" };
	if (campaign.status !== "sending") return { skipped: `campaign is ${campaign.status}` };

	const slice = await countFirstSendSlice(campaign);
	if (slice.queued > 0) {
		await commitJobs([{ ...firstSendCheckJob(campaign, Date.now() + FIRST_SEND.recheckMinutes * MINUTE_MS), onlyIf: whileSending(campaign) }]);
		return { waiting: true, ...slice };
	}
	const problem = getFirstSendProblem(slice);
	if (problem?.level === "block") {
		const reason = `${problem.reason}. The rest of the new contacts weren't sent.`;
		await pauseCampaign({ accountId: campaign.accountId, campaignId: campaign._id, reason, code: FIRST_SEND_PAUSE_CODE, isQuiet: true });
		await blockAccount(campaign.accountId, { reason: problem.reason, by: "slice" });
		return { paused: true, blocked: true, ...slice };
	}
	if (problem) {
		const reason = `${problem.reason}. The rest of the new contacts wait: clean the list of addresses you can't vouch for, then resume to send to them.`;
		await pauseCampaign({ accountId: campaign.accountId, campaignId: campaign._id, reason, code: FIRST_SEND_PAUSE_CODE });
		return { paused: true, ...slice };
	}
	// Only the held ones: batches of a spread send still waiting for their time keep it. The release and its
	// batches commit together, and only while the campaign is still sending.
	const now = Date.now();
	const restMs = getRestSpreadMs(campaign, held.length);
	const guard = whileSending(campaign);
	const db = await connectDb();
	const jobs = batchJobs(campaign, held, restMs, now).map((job) => ({ ...job, onlyIf: guard }));
	const [released] = await commitJobs(jobs, [
		statement(
			db,
			`UPDATE messages SET status = 'queued', updatedAt = ? WHERE accountId = ? AND campaignId = ? AND status = 'held'
			AND EXISTS (${guard.sql})`,
			[now, campaign.accountId, campaign._id, ...guard.params]
		),
		statement(
			db,
			`UPDATE campaigns SET firstSend = json_set(coalesce(firstSend, '{}'), '$.checkedAt', ?),
				sendingUntil = CASE WHEN ? > 0 THEN ? ELSE sendingUntil END, updatedAt = ?
			WHERE accountId = ? AND _id = ? AND status = 'sending'`,
			[new Date(now).toISOString(), restMs, now + restMs, now, campaign.accountId, campaign._id]
		),
	]);
	return { released: released.meta.changes, batches: jobs.length, ...slice };
}

// Campaign sends stop when the account can't send or the plan has no room for them. Signups don't.
async function assertCanSendCampaign(account, recipients) {
	const accountProblem = getAccountSendProblem(account);
	if (accountProblem) throw codedError(accountProblem);
	const current = await rollUsagePeriod(account);
	const [activeContacts, queued] = await Promise.all([countActiveContacts(account._id), countEmailsInFlight(account._id)]);
	const problem = getPlanLimitProblem({
		account: current,
		emailsSent: current.usage?.emailsSent ?? 0,
		queued,
		recipients,
		activeContacts,
	});
	if (problem) throw codedError(problem);
}

// Before scheduling. A send that goes out after the month resets only needs the account able to send and
// under its subscriber limit; it's checked in full when it goes out.
export async function checkCampaignSend({ accountId, campaignId, audienceLimit, at }) {
	const account = await findAccount(accountId);
	const campaign = await findCampaign(account._id, campaignId);
	if (!campaign) throw fail("not_found", "Campaign not found");
	const newsletter = await findNewsletter(account._id, campaign.newsletterId);
	const periodEnd = account.usage?.periodEnd;
	const isAfterReset = Boolean(at && periodEnd && at >= new Date(periodEnd));
	const newEmails = isAfterReset ? 0 : await countNewEmails({ campaign, newsletter, editions: await findEditions(campaign), audienceLimit });
	await assertCanSendCampaign(account, newEmails);
}

async function countCampaignMessages(campaign) {
	const row = await getOne(
		`SELECT coalesce(sum(kind = 'campaign'), 0) AS recipients, coalesce(sum(kind = 'last-chance'), 0) AS lastChances
		FROM messages WHERE accountId = ? AND campaignId = ? AND kind IN (${CAMPAIGN_KINDS_SQL})`,
		[campaign.accountId, campaign._id]
	);
	return [row.recipients, row.lastChances];
}

// What a send queued goes out now, over its spread; contacts held back for the first-send check follow once it
// passes. sendingUntil: about when its last batch goes, the check's 3 hours included. Resuming a send that held
// contacts back: a customer resuming after a bad slice sends the rest; any other pause checks the slice again first.
// Nothing is written here: startSend commits the plan with the campaign's change of status.
async function planSend(campaign, spreadMs, { isResuming = false } = {}) {
	const rows = await getAll(
		`SELECT _id, kind, status, firstSend FROM messages WHERE accountId = ? AND campaignId = ? AND kind IN (${CAMPAIGN_KINDS_SQL})
		AND status IN ('queued', 'held') ORDER BY kind, rowid`,
		[campaign.accountId, campaign._id]
	);
	const now = Date.now();
	const plan = { now, release: false, hold: null, firstSend: null, checkAt: null };
	let queued = rows.filter(({ status }) => status === "queued");
	const heldCount = rows.length - queued.length;
	if (isResuming && heldCount > 0) {
		if (campaign.pauseCode === FIRST_SEND_PAUSE_CODE) {
			plan.release = true;
			queued = rows;
		} else {
			plan.checkAt = now;
		}
	}
	let sendMs = spreadMs;
	if (!isResuming) {
		const neverMailed = queued.filter(({ kind, firstSend }) => kind === "campaign" && firstSend);
		const slice = getFirstSendSlice(neverMailed.length);
		if (slice) {
			const rest = new Set(neverMailed.slice(slice).map(({ _id }) => _id));
			queued = queued.filter(({ _id }) => !rest.has(_id));
			sendMs = Math.round((spreadMs * queued.length) / (queued.length + rest.size));
			plan.checkAt = now + sendMs + FIRST_SEND.waitMinutes * MINUTE_MS;
			plan.hold = { offset: slice };
			plan.firstSend = { slice, held: rest.size, checkAt: new Date(plan.checkAt) };
		}
	}
	plan.jobs = batchJobs(campaign, queued, sendMs, now);
	const isSpread = spreadMs > 0 && (plan.jobs.length > 1 || Boolean(plan.firstSend));
	const endsInMs = spreadMs + (plan.firstSend ? FIRST_SEND.waitMinutes * MINUTE_MS : 0);
	plan.sendingUntil = isSpread ? new Date(now + endsInMs) : null;
	return plan;
}

// The campaign's change of status (`flip`, a conditional UPDATE built from the plan) and everything the send needs
// commit in one D1 batch: held and released contacts, the batches and the first-send check. A crash can't leave a
// sending campaign with nothing on the way, and a first slice is never sent without its rest held back.
async function startSend(campaign, plan, flip) {
	const db = await connectDb();
	const guard = whileSending(campaign);
	const statements = [statement(db, flip.sql, flip.params)];
	if (plan.release) {
		statements.push(
			statement(
				db,
				`UPDATE messages SET status = 'queued', updatedAt = ? WHERE accountId = ? AND campaignId = ? AND status = 'held' AND EXISTS (${guard.sql})`,
				[plan.now, campaign.accountId, campaign._id, ...guard.params]
			)
		);
	}
	if (plan.hold) {
		// The same contacts planSend kept back: never-mailed issue recipients past the slice, in audience order.
		statements.push(
			statement(
				db,
				`UPDATE messages SET status = 'held', updatedAt = ? WHERE rowid IN (SELECT rowid FROM messages
					WHERE accountId = ? AND campaignId = ? AND kind = 'campaign' AND status = 'queued' AND firstSend = 1
					ORDER BY rowid LIMIT -1 OFFSET ?) AND EXISTS (${guard.sql})`,
				[plan.now, campaign.accountId, campaign._id, plan.hold.offset, ...guard.params]
			)
		);
	}
	const jobs = [...plan.jobs, ...(plan.checkAt ? [firstSendCheckJob(campaign, plan.checkAt)] : [])].map((job) => ({ ...job, onlyIf: guard }));
	let results;
	try {
		results = await commitJobs(jobs, statements);
	} catch (error) {
		// One D1 transaction: nothing changed.
		throw fail("unavailable", `Could not queue the send, nothing went out: ${formatError(error)}`);
	}
	if (!results[0].meta.changes) throw fail("conflict", "The campaign changed, refresh and try again");
	return plan.jobs.length;
}

// None once the account's warm-up is over. Otherwise the campaign's place among the account's campaigns gives it
// (lib/send-spread.js), and it keeps it for its resumes and next steps.
async function getCampaignSpreadMs(account, campaign) {
	if (!getSpreadMs(account)) return 0;
	if (campaign.spreadHours) return campaign.spreadHours * HOUR_MS;
	const place = await getValue("SELECT count(*) FROM campaigns WHERE accountId = ? AND _id != ? AND startedAt < ?", [
		account._id,
		campaign._id,
		campaign.startedAt ?? new Date(),
	]);
	return getSpreadHours(place) * HOUR_MS;
}

// The account's first campaign starts its first 30 days of spread sends.
async function startSpread(account) {
	if (account.spreadUntil) return;
	await execute("UPDATE accounts SET spreadUntil = ?, updatedAt = ? WHERE _id = ? AND spreadUntil IS NULL", [getSpreadEnd(), Date.now(), account._id]);
}

async function loadCampaignSend({ accountId, campaignId }) {
	assertSendingEnabled();
	if (!isObjectIdString(String(campaignId))) throw fail("not_found", "Campaign not found");
	const account = await findAccount(accountId);
	const campaign = await findCampaign(account._id, campaignId);
	if (!campaign) throw fail("not_found", "Campaign not found");
	const [newsletter, editions] = await Promise.all([findNewsletter(account._id, campaign.newsletterId), findEditions(campaign)]);
	return { account, campaign, newsletter, editions };
}

async function prepareArchivePage(campaign, newsletter) {
	try {
		await assignArchiveSlug({ campaign, newsletter });
	} catch (error) {
		throw fail("unavailable", `Could not prepare the archive page: ${formatError(error)}`);
	}
}

// Draft or scheduled: selects the audience. Paused: resumes with the audience it already has.
export async function queueCampaign({ accountId, campaignId }) {
	const { account, campaign, newsletter, editions } = await loadCampaignSend({ accountId, campaignId });
	if (!QUEUEABLE_STATUSES.includes(campaign.status)) {
		throw fail("conflict", `Campaign is already ${campaign.status}`);
	}
	const sender = newsletter && (await loadSender(account, newsletter));
	const problem = getCampaignSendProblem({ campaign, editions, newsletter, sender });
	if (problem) throw sendProblemError(problem, sender);

	const isResuming = campaign.status === "paused";
	const newEmails = isResuming
		? await countQueuedEmails(campaign)
		: await countNewEmails({ campaign, newsletter, editions, audienceLimit: campaign.audienceLimit });
	await assertCanSendCampaign(account, newEmails);

	if (!isResuming) await insertCampaignMessages(campaign, newsletter, editions);
	const [recipients, lastChances] = await countCampaignMessages(campaign);
	if (recipients + lastChances === 0) throw fail("no_recipients", "No active contacts to send to");

	await prepareArchivePage(campaign, newsletter);
	const spreadMs = await getCampaignSpreadMs(account, campaign);
	const plan = await planSend(campaign, spreadMs, { isResuming });
	const isAcceptingRates = isResuming && RATE_PAUSE_CODES.has(campaign.pauseCode);
	// A campaign in its newsletter's language keeps the one it went out in.
	const batches = await startSend(campaign, plan, {
		sql: `UPDATE campaigns SET status = 'sending',
			stats = json_set(stats, '$.recipients', CAST(? AS INTEGER)), lastChance = json_set(lastChance, '$.recipients', CAST(? AS INTEGER)),
			spreadHours = coalesce(?, spreadHours), ratesAcceptedAt = coalesce(?, ratesAcceptedAt), pauseReason = NULL, pauseCode = NULL,
			startedAt = coalesce(startedAt, ?), sendingUntil = ?, firstSend = coalesce(?, firstSend),
			language = coalesce(language, ?), languageRegion = CASE WHEN language IS NULL THEN ? ELSE languageRegion END, updatedAt = ?
			WHERE accountId = ? AND _id = ? AND status = ?`,
		params: [
			recipients,
			lastChances,
			spreadMs ? spreadMs / HOUR_MS : null,
			isAcceptingRates ? plan.now : null,
			plan.now,
			plan.sendingUntil,
			json(plan.firstSend),
			newsletter.language,
			newsletter.languageRegion,
			plan.now,
			campaign.accountId,
			campaign._id,
			campaign.status,
		],
	});
	if (spreadMs) await startSpread(account);
	if (batches === 0) await settleCampaign(campaign.accountId, campaign._id);
	return { recipients, batches };
}

// Sending in steps: a sent campaign goes to the next most engaged contacts. It takes the top of the
// audience again and the one-email-per-contact index skips everyone who already received it.
export async function sendToMoreContacts({ accountId, campaignId, additional }) {
	const { account, campaign, newsletter, editions } = await loadCampaignSend({ accountId, campaignId });
	if (campaign.status !== "sent") throw fail("conflict", "Wait until the current step has gone out");
	const sender = newsletter && (await loadSender(account, newsletter));
	const problem = getCampaignSendProblem({ campaign, editions, newsletter, sender });
	if (problem) throw sendProblemError(problem, sender);

	const [sentSoFar, lastChancesSoFar] = await countCampaignMessages(campaign);
	const audienceLimit = getNextStepLimit({ sentSoFar, additional });
	// At least this many: contacts who got it and left since make room for new ones.
	const newEmails = await countNewEmails({ campaign, newsletter, editions, audienceLimit, issuesSoFar: sentSoFar });
	await assertCanSendCampaign(account, newEmails);

	await insertCampaignMessages({ ...campaign, audienceLimit }, newsletter, editions);
	const [recipients, lastChances] = await countCampaignMessages(campaign);
	if (recipients === sentSoFar && lastChances === lastChancesSoFar) throw fail("no_recipients", "Everyone has received it already");

	const plan = await planSend(campaign, await getCampaignSpreadMs(account, campaign));
	const batches = await startSend(campaign, plan, {
		sql: `UPDATE campaigns SET status = 'sending', audienceLimit = ?,
			stats = json_set(stats, '$.recipients', CAST(? AS INTEGER)), lastChance = json_set(lastChance, '$.recipients', CAST(? AS INTEGER)),
			pauseReason = NULL, pauseCode = NULL, sendingUntil = ?, firstSend = coalesce(?, firstSend), updatedAt = ?
			WHERE accountId = ? AND _id = ? AND status = 'sent'`,
		params: [
			audienceLimit ?? null,
			recipients,
			lastChances,
			plan.sendingUntil,
			json(plan.firstSend),
			plan.now,
			campaign.accountId,
			campaign._id,
		],
	});
	if (batches === 0) await settleCampaign(campaign.accountId, campaign._id);
	return { added: recipients - sentSoFar, recipients, batches };
}

// The claim: queued -> sending before the provider is called, only while the contact can still get it, the account
// hasn't suppressed the address and the campaign is still sending. At most once per message, whoever runs the batch.
async function claimMessage(message) {
	const now = Date.now();
	const claimed = await getOne(
		`UPDATE messages SET status = 'sending', claimedAt = ?, provider = ?, updatedAt = ?
		WHERE accountId = ? AND _id = ? AND status = 'queued'
		AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.accountId = messages.accountId AND s.email = messages.email)
		AND EXISTS (SELECT 1 FROM contacts c WHERE c._id = messages.contactId AND c.accountId = messages.accountId AND c.status = ?)
		AND (kind NOT IN (${CAMPAIGN_KINDS_SQL}) OR EXISTS (SELECT 1 FROM campaigns
			WHERE accountId = messages.accountId AND _id = messages.campaignId AND status = 'sending'))
		RETURNING _id`,
		[now, mailboxProvider(message.email), now, message.accountId, message._id, message.kind === "confirmation" ? "pending" : "active"]
	);
	return Boolean(claimed);
}

// Not claimed: another consumer has it, the campaign stopped, or the contact can't get it anymore. The last one
// is settled here, so a queued message nobody can send never holds its campaign open.
async function suppressUnclaimable(message) {
	const { meta } = await execute(
		`UPDATE messages SET status = 'suppressed', updatedAt = ? WHERE accountId = ? AND _id = ? AND status = 'queued'
		AND (EXISTS (SELECT 1 FROM suppressions s WHERE s.accountId = messages.accountId AND s.email = messages.email)
			OR NOT EXISTS (SELECT 1 FROM contacts c WHERE c._id = messages.contactId AND c.accountId = messages.accountId AND c.status = ?))
		AND (kind NOT IN (${CAMPAIGN_KINDS_SQL}) OR EXISTS (SELECT 1 FROM campaigns
			WHERE accountId = messages.accountId AND _id = messages.campaignId AND status = 'sending'))`,
		[Date.now(), message.accountId, message._id, message.kind === "confirmation" ? "pending" : "active"]
	);
	return meta.changes > 0;
}

// A send the provider couldn't take, before anything went out: it goes back in the queue.
async function markQueued(message) {
	await execute("UPDATE messages SET status = 'queued', claimedAt = NULL, updatedAt = ? WHERE accountId = ? AND _id = ? AND status = 'sending'", [
		Date.now(),
		message.accountId,
		message._id,
	]);
}

// The messages_first_events trigger counts the send on the campaign and the contact (stats, lastSentAt, and the
// ignored issues the list cleanup reads, lib/cleanup.js), so nothing else is incremented here.
async function recordSent({ message, providerMessageId, sentAt }) {
	await execute(
		`UPDATE messages SET status = 'sent', providerMessageId = coalesce(?, providerMessageId), sentAt = ?, error = NULL, updatedAt = ?
		WHERE accountId = ? AND _id = ? AND status IN ('sending', 'ambiguous')`,
		[providerMessageId ?? null, sentAt, Date.now(), message.accountId, message._id]
	);
}

// The provider refuses the address for this account: it's kept out of the account's next sends too.
async function recordSuppressed({ message, error }) {
	const db = await connectDb();
	const now = Date.now();
	await db.batch([
		statement(db, "UPDATE messages SET status = 'suppressed', error = ?, updatedAt = ? WHERE accountId = ? AND _id = ? AND status = 'sending'", [
			formatError(error),
			now,
			message.accountId,
			message._id,
		]),
		statement(
			db,
			`INSERT INTO suppressions (_id, accountId, email, reason, detail, createdAt, updatedAt) VALUES (lower(hex(randomblob(12))), ?, ?, 'provider', ?, ?, ?)
			ON CONFLICT (accountId, email) DO NOTHING`,
			[message.accountId, message.email, formatError(error).slice(0, 200), now, now]
		),
	]);
}

// The trigger counts the failure on the campaign.
async function recordFailed({ message, error }) {
	await execute("UPDATE messages SET status = 'failed', error = ?, updatedAt = ? WHERE accountId = ? AND _id = ? AND status IN ('queued', 'sending')", [
		formatError(error),
		Date.now(),
		message.accountId,
		message._id,
	]);
}

// The provider may have accepted it: never resend blindly. A later provider event for the message settles it
// (lib/ses-events.js, through its message_id tag).
async function recordAmbiguous({ message, error }) {
	await execute("UPDATE messages SET status = 'ambiguous', error = ?, updatedAt = ? WHERE accountId = ? AND _id = ? AND status = 'sending'", [
		`Unconfirmed send: ${formatError(error)}`,
		Date.now(),
		message.accountId,
		message._id,
	]);
}

async function alertAmbiguous(accountId, { count = 1, campaignId, error }) {
	await sendAlert({
		accountId,
		key: "ambiguous-send",
		title: count === 1 ? "Unconfirmed send" : "Unconfirmed sends",
		detail: error
			? `The email provider didn't confirm a send (${formatError(error)}). It won't be resent automatically.`
			: `${count} sends stopped before the email provider answered. They won't be resent automatically.`,
		path: campaignId ? `/campaigns/${campaignId}` : "/",
	});
}

// Last-chance emails wait for the issue to reach everyone else. Batches hold one kind (batchJobs).
async function countIssuesStillGoing(accountId, campaignId) {
	return getValue(
		`SELECT count(*) FROM messages WHERE accountId = ? AND campaignId = ? AND kind = 'campaign' AND status IN ('queued', 'sending')
		AND EXISTS (SELECT 1 FROM campaigns WHERE accountId = messages.accountId AND _id = messages.campaignId AND status = 'sending')`,
		[accountId, String(campaignId)]
	);
}

// At most once per message: the queued -> sending claim happens before the provider is called. Campaign emails take
// room in the plan first (claimCampaignEmails); what a batch doesn't send goes back at the end. retry: try the rest of
// the batch again later (retryAfter seconds, or deferMs); nothing left queued was sent.
export async function sendMessageBatch({ accountId, messageIds }) {
	assertSendingEnabled();
	const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).map((id) => String(id).toLowerCase()))]
		.filter(isObjectIdString)
		.slice(0, MAX_BATCH_MESSAGES);
	const result = { sent: 0, failed: 0, suppressed: 0, skipped: 0, ambiguous: 0, retry: false, deferMs: 0 };
	if (ids.length === 0 || !isObjectIdString(String(accountId))) return result;

	const stored = await getOne("SELECT * FROM accounts WHERE _id = ?", [String(accountId)]);
	if (!stored) {
		result.skipped = ids.length;
		return result;
	}
	const account = await rollUsagePeriod(stored);
	const order = new Map(ids.map((id, index) => [id, index]));
	const messages = (
		await getAll(
			`SELECT * FROM messages WHERE accountId = ? AND _id IN (SELECT value FROM json_each(?)) AND status = 'queued'
			AND kind IN (${SENDABLE_KINDS_SQL})`,
			[account._id, JSON.stringify(ids)]
		)
	).sort((a, b) => order.get(a._id) - order.get(b._id));
	result.skipped = ids.length - messages.length;
	if (messages.length === 0) return result;

	if (messages.every(({ kind }) => kind === "last-chance")) {
		const waiting = await countIssuesStillGoing(account._id, messages[0].campaignId);
		if (waiting > 0) {
			result.retry = true;
			result.deferMs = Math.max(DEFAULT_RETRY_SECONDS * 1000, Math.ceil((waiting / LIMITS.sendRatePerSecond) * 1000));
			return result;
		}
	}

	const [campaigns, editions, newsletters, contacts, suppressedRows] = await Promise.all([
		findByIds("campaigns", account._id, messages.map(({ campaignId }) => campaignId)),
		findByIds("campaign_editions", account._id, messages.map(({ editionId }) => editionId)),
		findByIds("newsletters", account._id, messages.map(({ newsletterId }) => newsletterId)),
		findByIds("contacts", account._id, messages.map(({ contactId }) => contactId)),
		getAll("SELECT email FROM suppressions WHERE accountId = ? AND email IN (SELECT value FROM json_each(?))", [
			account._id,
			JSON.stringify([...new Set(messages.map(({ email }) => email))]),
		]),
	]);
	const suppressed = new Set(suppressedRows.map(({ email }) => email));
	let hasBlocked = false;
	for (const campaignId of campaigns.keys()) hasBlocked = (await stopIfUnhealthy(account._id, campaignId)) === "block" || hasBlocked;

	const accountProblem = getAccountSendProblem(hasBlocked ? await findAccount(account._id) : account);
	const campaignMessageCount = messages.filter(({ kind }) => CAMPAIGN_MESSAGE_KINDS.includes(kind)).length;
	const allowance = accountProblem ? 0 : await claimCampaignEmails(account, campaignMessageCount);
	const sentByKind = { campaign: 0, signup: 0 };
	const senderFor = createSenderCache(account);
	const getTenant = createTenantLoader(account);

	try {
		let consecutiveFailures = 0;
		for (const message of messages) {
			if (!isSendingEnabled()) {
				result.retry = true;
				break;
			}
			const campaign = campaigns.get(String(message.campaignId)) ?? null;
			const isCampaignMessage = CAMPAIGN_MESSAGE_KINDS.includes(message.kind);
			if (isCampaignMessage) {
				const isCampaignSending = await getOne("SELECT 1 AS found FROM campaigns WHERE accountId = ? AND _id = ? AND status = 'sending'", [
					account._id,
					message.campaignId,
				]);
				if (!isCampaignSending) {
					result.skipped++;
					continue;
				}
				// Left queued, so the send picks them up again when it resumes.
				const stopCode = accountProblem?.code ?? (sentByKind.campaign >= allowance ? ERROR_CODES.planLimitEmails : null);
				if (stopCode) {
					await pauseCampaign({
						accountId: account._id,
						campaignId: message.campaignId,
						code: stopCode,
						reason: PAUSE_REASONS[stopCode],
					});
					result.skipped++;
					continue;
				}
			} else if (accountProblem) {
				await execute("UPDATE messages SET status = 'failed', error = ?, updatedAt = ? WHERE accountId = ? AND _id = ? AND status = 'queued'", [
					accountProblem.message,
					Date.now(),
					account._id,
					message._id,
				]);
				result.failed++;
				continue;
			}

			const contact = contacts.get(String(message.contactId));
			const requiredStatus = message.kind === "confirmation" ? "pending" : "active";
			if (contact?.status !== requiredStatus || suppressed.has(message.email)) {
				await execute("UPDATE messages SET status = 'suppressed', updatedAt = ? WHERE accountId = ? AND _id = ? AND status = 'queued'", [
					Date.now(),
					account._id,
					message._id,
				]);
				result.suppressed++;
				continue;
			}

			if (!(await claimMessage(message))) {
				if (await suppressUnclaimable(message)) result.suppressed++;
				else result.skipped++;
				continue;
			}

			const newsletter = newsletters.get(String(message.newsletterId));
			const content = getMessageContent({ message, newsletter, campaign, editions });
			let delivery;
			try {
				if (!newsletter || !content) throw new Error("Newsletter or email content not found");
				delivery = await deliver({ message, content, newsletter, contact, sender: await senderFor(newsletter), getTenant });
			} catch (error) {
				if (error?.ambiguous) {
					// It may have gone out, so it counts toward the plan; a provider that stops answering is likely down,
					// so the rest of the batch waits instead of piling up more unconfirmed sends.
					console.error("[sending] Unconfirmed send:", error?.stack ?? error);
					await recordAmbiguous({ message, error });
					result.ambiguous++;
					sentByKind[isCampaignMessage ? "campaign" : "signup"]++;
					await alertAmbiguous(account._id, { campaignId: campaign?._id, error });
					result.retry = true;
					break;
				}
				// Signup emails have no campaign to pause: they fail, unless the provider says to retry or skip them.
				const outcomeAction = campaign || error?.outcome ? getSendErrorAction(error) : "fail";
				const action = !campaign && outcomeAction === "pause" ? "fail" : outcomeAction;
				if (error?.hold) await blockAccountForHold(account._id, error);
				if (action === "suppress") {
					await recordSuppressed({ message, error });
					result.suppressed++;
					continue;
				}
				if (action === "fail") {
					await recordFailed({ message, error });
					result.failed++;
					consecutiveFailures++;
					if (!campaign || consecutiveFailures < MAX_CONSECUTIVE_FAILURES) continue;
					await pauseCampaign({
						accountId: account._id,
						campaignId: campaign._id,
						reason: `${consecutiveFailures} sends failed in a row`,
					});
					break;
				}
				await markQueued(message);
				if (action === "pause") {
					await pauseCampaign({ accountId: account._id, campaignId: campaign._id, reason: formatError(error) });
				} else {
					result.retry = true;
					if (error?.retryAfter) result.retryAfter = error.retryAfter;
				}
				break;
			}

			await recordSent({ message, ...delivery });
			result.sent++;
			sentByKind[isCampaignMessage ? "campaign" : "signup"]++;
			consecutiveFailures = 0;
		}
	} finally {
		await addEmailsSent(account._id, sentByKind.signup + sentByKind.campaign - allowance);
	}

	for (const campaignId of campaigns.keys()) await settleCampaign(account._id, campaignId);
	return result;
}

// A batch the provider couldn't take yet goes again once it says there's room, as one more outbox job.
export async function publishBatchRetry(job, retryAfterSeconds) {
	const delay = Math.min(Math.max(Math.ceil(retryAfterSeconds || DEFAULT_RETRY_SECONDS), 10), MAX_RETRY_SECONDS);
	const { accountId, campaignId, messageIds } = job;
	await commitJobs([
		{
			kind: SEND_JOB,
			payload: { accountId: String(accountId), ...(campaignId && { campaignId: String(campaignId) }), messageIds },
			availableAt: Date.now() + delay * 1000,
		},
	]);
	return { delaySeconds: delay };
}

// The queue consumer's "send" job. Off: nothing is sent and the job ends; recoverStalledSends republishes
// queued campaign messages once sending is back on. Waiting goes back through the outbox, so it never uses up
// the queue's retries.
export async function runSendJob(payload) {
	if (!isSendingEnabled()) return { skipped: "sending is off" };
	const result = await sendMessageBatch(payload);
	if (result.retry && isSendingEnabled()) {
		await publishBatchRetry(payload, result.retryAfter ?? (result.deferMs ? result.deferMs / 1000 : undefined));
	}
	return result;
}

// Run by the minute cron, across accounts (a stale claim or a stalled campaign is found by time, not by
// account): claims that never finished become ambiguous; sending campaigns whose jobs all finished or died get
// their queued messages published again, over what's left of their spread; a first-send check that never ran is
// published again. Duplicates are harmless: every batch claims its messages.
export async function recoverStalledSends(now = Date.now()) {
	const stale = await getAll(
		`UPDATE messages SET status = 'ambiguous', error = 'Unconfirmed send: the worker stopped mid-send', updatedAt = ?
		WHERE status = 'sending' AND claimedAt < ? RETURNING accountId, campaignId`,
		[now, now - STALE_CLAIM_MS]
	);
	const byAccount = Map.groupBy(stale, ({ accountId }) => accountId);
	for (const [accountId, rows] of byAccount) {
		await alertAmbiguous(accountId, { count: rows.length, campaignId: rows.length === 1 ? rows[0].campaignId : null });
	}
	const recovered = { ambiguous: stale.length, republished: 0, checks: 0 };
	if (!isSendingEnabled()) return recovered;

	const since = now - STALLED_CAMPAIGN_MS;
	const pending = (kind) => `NOT EXISTS (SELECT 1 FROM job_outbox j WHERE j.kind = '${kind}' AND j.completedAt IS NULL
		AND j.availableAt >= ? AND json_extract(j.payload, '$.campaignId') = c._id)`;
	const stalled = await getAll(
		`SELECT c._id, c.accountId, c.sendingUntil FROM campaigns c WHERE c.status = 'sending' AND c.updatedAt < ?
		AND EXISTS (SELECT 1 FROM messages m WHERE m.accountId = c.accountId AND m.campaignId = c._id AND m.status = 'queued')
		AND ${pending(SEND_JOB)} LIMIT ?`,
		[since, since, STALLED_PAGE]
	);
	for (const campaign of stalled) {
		const queued = await getAll(
			`SELECT _id, kind FROM messages WHERE accountId = ? AND campaignId = ? AND kind IN (${CAMPAIGN_KINDS_SQL})
			AND status = 'queued' ORDER BY kind, rowid`,
			[campaign.accountId, campaign._id]
		);
		const spreadMs = Math.max(0, (campaign.sendingUntil?.getTime() ?? 0) - now);
		const jobs = batchJobs(campaign, queued, spreadMs, now).map((job) => ({ ...job, onlyIf: whileSending(campaign) }));
		await commitJobs(jobs);
		recovered.republished += jobs.length;
	}

	const unchecked = await getAll(
		`SELECT c._id, c.accountId FROM campaigns c WHERE c.status = 'sending' AND c.firstSend IS NOT NULL
		AND json_extract(c.firstSend, '$.checkAt') < ? AND json_extract(c.firstSend, '$.checkedAt') IS NULL
		AND EXISTS (SELECT 1 FROM messages m WHERE m.accountId = c.accountId AND m.campaignId = c._id AND m.status = 'held')
		AND ${pending(CHECK_FIRST_SEND_JOB)} LIMIT ?`,
		[new Date(since).toISOString(), since, STALLED_PAGE]
	);
	for (const campaign of unchecked) {
		await commitJobs([{ ...firstSendCheckJob(campaign, now), onlyIf: whileSending(campaign) }]);
		recovered.checks++;
	}
	return recovered;
}

// Claimed from the start ("sending"), so a test that never got an answer is recovered like any other send.
async function sendTest({ account, content, newsletter, campaignId, to }) {
	const email = normalizeEmail(to);
	if (!email) throw fail("validation_failed", "The test email address is invalid");
	const sender = newsletter && (await loadSender(account, newsletter));
	const problem = getSendProblem({ campaign: content, newsletter, sender });
	if (problem) throw sendProblemError(problem, sender);
	// A tester on the list sees their own name in the merge tags, anyone else the fallbacks.
	const names = await getOne("SELECT firstName, lastName FROM contacts WHERE accountId = ? AND newsletterId = ? AND email = ?", [
		account._id,
		newsletter._id,
		email,
	]);

	const message = await insertRow("messages", {
		kind: "test",
		accountId: account._id,
		campaignId: campaignId ?? undefined,
		newsletterId: newsletter._id,
		email,
		provider: mailboxProvider(email),
		status: "sending",
		claimedAt: Date.now(),
	});
	let delivery;
	try {
		delivery = await deliver({
			message,
			content: { ...content, subject: `[Test] ${content.subject}` },
			newsletter,
			contact: { ...names, _id: TEST_CONTACT_ID, email },
			sender,
			getTenant: createTenantLoader(account),
		});
	} catch (error) {
		if (error?.hold) await blockAccountForHold(account._id, error);
		if (error?.ambiguous) {
			await recordAmbiguous({ message, error });
			await addEmailsSent(account._id, 1);
			throw fail("unavailable", `The email provider didn't confirm the test email, it may still arrive: ${formatError(error)}`);
		}
		await recordFailed({ message, error });
		throw fail(error.name === "SenderNotAllowed" ? "sender_not_allowed" : "unavailable", formatError(error));
	}

	const { providerMessageId, sentAt } = delivery;
	await recordSent({ message, providerMessageId, sentAt });
	await addEmailsSent(account._id, 1);
	return { messageId: String(message._id), providerMessageId, sentAt };
}

async function loadTestAccount(accountId) {
	const account = await findAccount(accountId);
	const problem = getAccountSendProblem(account);
	if (problem) throw codedError(problem);
	return account;
}

// language: the edition to send (a tag like pt-BR), the campaign's own content without one.
export async function sendTestEmail({ accountId, campaignId, to, language = null }) {
	assertSendingEnabled();
	if (!isObjectIdString(String(campaignId))) throw fail("not_found", "Campaign not found");

	const account = await loadTestAccount(accountId);
	const campaign = await findCampaign(account._id, campaignId);
	if (!campaign) throw fail("not_found", "Campaign not found");
	const newsletter = await findNewsletter(account._id, campaign.newsletterId);
	let content = campaign;
	if (language && newsletter && language !== getCampaignLanguage(campaign, newsletter)) {
		const edition = (await findEditions(campaign)).find((each) => getLanguageTag(each) === language);
		if (!edition) throw fail("not_found", `This campaign has no ${getLanguageName(language)} edition`);
		content = getEditionContent(campaign, edition);
	}
	const result = await sendTest({ account, content, newsletter, campaignId: campaign._id, to });
	await execute("UPDATE campaigns SET testSentAt = ?, updatedAt = ? WHERE accountId = ? AND _id = ?", [
		result.sentAt,
		Date.now(),
		account._id,
		campaign._id,
	]);
	return result;
}

// Sends the saved welcome email, whether or not it's switched on yet.
export async function sendWelcomeTestEmail({ accountId, newsletterId, to }) {
	assertSendingEnabled();
	if (!isObjectIdString(String(newsletterId))) throw fail("not_found", "Newsletter not found");

	const account = await loadTestAccount(accountId);
	const newsletter = await findNewsletter(account._id, newsletterId);
	if (!newsletter) throw fail("not_found", "Newsletter not found");
	const content = getWelcomeContent({ welcome: { ...newsletter.welcome, enabled: true } });
	if (!content) throw fail("send_check_failed", "Save a subject and content first");
	return sendTest({ account, content, newsletter, to });
}

// A canceled account takes no signups, so it sends no signup emails either; a blocked one sends nothing.
async function getSignupEmailProblem(newsletter) {
	const account = await getOne("SELECT * FROM accounts WHERE _id = ?", [newsletter.accountId]);
	if (isBlocked(account)) return "account is blocked";
	return hasActiveSubscription(account) ? null : "no active plan";
}

const isSuppressed = async (accountId, email) =>
	Boolean(await getOne("SELECT 1 AS found FROM suppressions WHERE accountId = ? AND email = ?", [accountId, email]));

export async function queueWelcomeEmail({ newsletter, contact }) {
	assertSendingEnabled();
	const content = getWelcomeContent(newsletter);
	if (!content) return { skipped: "welcome email is off" };
	if (contact?.status !== "active") return { skipped: "contact is not active" };

	const { accountId } = newsletter;
	const [suppressed, hasWelcome, recentWelcomes, signupProblem] = await Promise.all([
		isSuppressed(accountId, contact.email),
		getOne("SELECT 1 AS found FROM messages WHERE accountId = ? AND kind = 'welcome' AND contactId = ?", [accountId, contact._id]),
		countRecentSignupEmails(newsletter),
		getSignupEmailProblem(newsletter),
	]);
	if (signupProblem) return { skipped: signupProblem };
	if (suppressed) return { skipped: "suppressed" };
	if (hasWelcome) return { skipped: "already sent" };
	if (recentWelcomes >= LIMITS.welcomeEmailsPer10Minutes) {
		await alertSignupCap(newsletter);
		return { skipped: "rate limited" };
	}
	const problem = getSendProblem({ campaign: content, newsletter, sender: await loadSender({ _id: accountId }, newsletter) });
	if (problem) {
		console.warn(`[sending] Welcome email for ${newsletter.slug} not sent: ${problem}`);
		return { skipped: problem };
	}
	return sendSignupEmail({ kind: "welcome", newsletter, contact });
}

export async function queueConfirmationEmail({ newsletter, contact }) {
	assertSendingEnabled();
	if (contact?.status !== "pending") return { skipped: "contact is not pending" };

	const { accountId } = newsletter;
	const [suppressed, confirmations, recentSignupEmails, signupProblem] = await Promise.all([
		isSuppressed(accountId, contact.email),
		getOne(
			`SELECT count(*) AS total, coalesce(sum(createdAt >= ?), 0) AS recent FROM messages
			WHERE accountId = ? AND kind = 'confirmation' AND contactId = ?`,
			[Date.now() - WELCOME_WINDOW_MS, accountId, contact._id]
		),
		countRecentSignupEmails(newsletter),
		getSignupEmailProblem(newsletter),
	]);
	if (signupProblem) return { skipped: signupProblem };
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
	const message = await insertRow("messages", {
		kind,
		accountId: newsletter.accountId,
		newsletterId: newsletter._id,
		contactId: contact._id,
		email: contact.email,
		provider: mailboxProvider(contact.email),
	});
	const job = { accountId: String(newsletter.accountId), messageIds: [String(message._id)] };
	const result = await sendMessageBatch(job);
	// Sent from the signup request itself: when the provider is full, the outbox brings it back later.
	if (result.retry && result.ambiguous === 0) {
		await publishBatchRetry(job, result.retryAfter).catch((error) => {
			console.error(`[sending] The ${kind} email for ${message._id} stays queued: ${error.message}`);
		});
	}
	return { messageId: String(message._id), ...result };
}
