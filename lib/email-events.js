import "server-only";
import { blockAccount } from "@/lib/account-blocks";
import { checkAccountHealth } from "@/lib/account-health";
import { sendAlert } from "@/lib/alerts";
import { withEngagement } from "@/lib/cleanup";
import { connectDb, getOne, newId, statement } from "@/lib/db";
import { getEventPlan, getTrackingPlan } from "@/lib/email-event-rules";
import { insertStatement } from "@/lib/records";
import { isLikelyScanner } from "@/lib/tracking";

const SUBSCRIBED_STATUSES = ["active", "dormant"];
const SPAM_TRAP_REASON = "An email reached a spam trap, an address found only on bought, scraped or old lists";
// Any event from the provider proves a send it never confirmed (sending, ambiguous) went out after all.
const UNCONFIRMED = ["sending", "ambiguous"];

// Every email carries its account in a tag or unique arg, so an event only ever looks inside that account.
// The message id covers events that arrive before providerMessageId is saved.
async function findMessage({ accountId, providerMessageId, messageId }) {
	if (!accountId) return null;
	if (providerMessageId) {
		const message = await getOne("SELECT * FROM messages WHERE accountId = ? AND providerMessageId = ?", [String(accountId), providerMessageId]);
		if (message) return message;
	}
	if (!messageId) return null;

	const message = await getOne("SELECT * FROM messages WHERE accountId = ? AND _id = ?", [String(accountId), String(messageId)]);
	if (!message) return null;
	if (message.providerMessageId && providerMessageId && message.providerMessageId !== providerMessageId) return null;
	return message;
}

// One D1 transaction per event with the rest of its changes. The messages_first_events trigger moves each
// campaign and contact counter on a first transition only, so redelivered and out-of-order events are harmless.
function messageStatements(db, message, plan) {
	const { accountId, _id: id } = message;
	const at = plan.occurredAt;
	const now = Date.now();
	const statements = [];
	if (plan.providerMessageId && !message.providerMessageId) {
		statements.push(statement(db, "UPDATE messages SET providerMessageId = ?, updatedAt = ? WHERE accountId = ? AND _id = ? AND providerMessageId IS NULL",
			[plan.providerMessageId, now, accountId, id]));
	}
	// An unconfirmed send is settled as sent: it counts once, from the trigger.
	if (UNCONFIRMED.includes(message.status) && message.kind !== "test") {
		statements.push(statement(db, `UPDATE messages SET status = 'sent', sentAt = coalesce(sentAt, ?), error = NULL, updatedAt = ?
			WHERE accountId = ? AND _id = ? AND status IN ('sending', 'ambiguous')`, [at, now, accountId, id]));
	}
	for (const { field } of plan.firsts) {
		statements.push(statement(db, `UPDATE messages SET ${field} = ?, updatedAt = ? WHERE accountId = ? AND _id = ? AND ${field} IS NULL`,
			[at, now, accountId, id]));
	}
	if (plan.status) {
		statements.push(statement(db, `UPDATE messages SET status = ?, updatedAt = ? WHERE accountId = ? AND _id = ?
			AND status IN (SELECT value FROM json_each(?))`, [plan.status.to, now, accountId, id, JSON.stringify([...plan.status.from, ...UNCONFIRMED])]));
	}
	if (plan.error) {
		statements.push(statement(db, "UPDATE messages SET error = ?, updatedAt = ? WHERE accountId = ? AND _id = ?", [plan.error.slice(0, 500), now, accountId, id]));
	}
	// Repeat opens and clicks still move the contact's engagement dates forward, and any sign of life resets its
	// ignored issues (lib/cleanup.js).
	if (message.contactId && plan.engagement) {
		const { lastOpenAt, lastClickAt } = plan.engagement;
		const engaged = withEngagement(at);
		statements.push(statement(db, `UPDATE contacts SET ${engaged.sql},
			lastOpenAt = nullif(max(coalesce(lastOpenAt, 0), ?), 0), lastClickAt = nullif(max(coalesce(lastClickAt, 0), ?), 0),
			updatedAt = ? WHERE accountId = ? AND _id = ?`,
		[...engaged.params, lastOpenAt?.getTime() ?? 0, lastClickAt?.getTime() ?? 0, now, accountId, message.contactId]));
	}
	return statements;
}

// The address is never emailed again by this account, from any of its newsletters. A complaint outranks an earlier
// bounce or manual suppression, and a hard bounce a manual one; the suppressions triggers update the account's contacts.
function suppressionStatements(db, { accountId, emails, reason, detail }) {
	const now = Date.now();
	return emails.map((email) => statement(db, `INSERT INTO suppressions (_id, accountId, email, reason, detail, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(accountId, email) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, updatedAt = excluded.updatedAt
		WHERE (excluded.reason = 'complaint' AND suppressions.reason != 'complaint')
			OR (excluded.reason = 'bounce' AND suppressions.reason IN ('manual', 'provider'))`,
	[newId(), String(accountId), email, reason, detail ?? null, now, now]));
}

// The provider suppresses the address for the whole tenant, so every newsletter of the account loses it. The campaign
// counts the unsubscribe once: its statement runs first, while the contact is still subscribed.
function unsubscribeStatements(db, { accountId, email, message }) {
	if (!email) return [];
	const now = Date.now();
	const isSubscribed = `SELECT 1 FROM contacts WHERE accountId = ? AND email = ? AND status IN (SELECT value FROM json_each(?))`;
	const statuses = JSON.stringify(SUBSCRIBED_STATUSES);
	return [
		...(message?.kind === "campaign" && message.campaignId
			? [statement(db, `UPDATE campaigns SET stats = json_set(stats, '$.unsubscribed', coalesce(json_extract(stats, '$.unsubscribed'), 0) + 1),
				updatedAt = ? WHERE accountId = ? AND _id = ? AND EXISTS (${isSubscribed})`,
			[now, String(accountId), message.campaignId, String(accountId), email, statuses])]
			: []),
		statement(db, `UPDATE contacts SET status = 'unsubscribed', unsubscribedAt = ?, updatedAt = ?
			WHERE accountId = ? AND email = ? AND status IN (SELECT value FROM json_each(?))`, [now, now, String(accountId), email, statuses]),
	];
}

// MailCheap's own open pixel and click links update messages the way provider events do. The link is signed for
// this message, so the message is found by its id alone, whatever its account.
export async function recordEngagement({ messageId, type, userAgent }) {
	const message = await getOne("SELECT _id, accountId, kind, status, campaignId, contactId, providerMessageId, sentAt FROM messages WHERE _id = ?", [
		String(messageId),
	]);
	if (!message) return;
	if (type === "Click" && isLikelyScanner({ userAgent, sentAt: message.sentAt })) return;
	const db = await connectDb();
	// An open or a click proves an unconfirmed send went out, like a provider event.
	await db.batch(messageStatements(db, message, getTrackingPlan(type)));
}

// The same event delivered twice keeps its first record: providerEventId is unique.
function eventStatement(db, { accountId, plan, message, providerEventId }) {
	return insertStatement(
		db,
		"events",
		{
			accountId: String(accountId),
			type: plan.type,
			providerMessageId: plan.providerMessageId,
			providerEventId: providerEventId ?? undefined,
			messageId: message?._id,
			campaignId: message?.campaignId ?? undefined,
			email: plan.email ?? message?.email,
			occurredAt: plan.occurredAt,
			data: plan.data ?? undefined,
		},
		{ orIgnore: true }
	);
}

// One normalized event (lib/email-event-rules.js), only ever inside the account it names. Without a known
// message, it only shows in the logs, unless isAccountTrusted: the provider named the account itself
// (its tenant), so its suppressions and unsubscribes still apply there. eventId: a unique id for an event
// the provider doesn't number (SES), so a replay of the same delivery keeps one record.
export async function handleEmailEvent(event, { isAccountTrusted = false, eventId = null } = {}) {
	const plan = getEventPlan(event);
	if (!plan) return { handled: false };

	const message = await findMessage(plan);
	const accountId = message?.accountId ?? (isAccountTrusted && plan.accountId ? String(plan.accountId) : null);
	if (!accountId) {
		if (plan.suppression || plan.unsubscribe) {
			console.warn(`[email-events] ${plan.type} for an unknown message (${plan.providerMessageId ?? "no id"})`);
		}
		return { handled: true, messageId: null };
	}

	const db = await connectDb();
	const statements = [
		...(message ? messageStatements(db, message, plan) : []),
		...(plan.suppression ? suppressionStatements(db, { accountId, ...plan.suppression }) : []),
		...(plan.unsubscribe ? unsubscribeStatements(db, { accountId, email: plan.email, message }) : []),
	];
	const recordIndex = plan.isRecorded ? statements.push(eventStatement(db, { accountId, plan, message, providerEventId: plan.providerEventId ?? eventId })) - 1 : -1;
	const results = statements.length ? await db.batch(statements) : [];
	// A replay of an event already recorded changed nothing: its alerts went out the first time.
	const isReplay = recordIndex >= 0 && (results[recordIndex]?.results?.length ?? 0) === 0;
	if (isReplay) return { handled: true, messageId: message ? String(message._id) : null };

	// The trap's address and the server's words go to the admins only.
	if (plan.isSpamTrap) {
		const detail = `${plan.email ?? message?.email ?? "An address"} bounced: ${plan.error}`.slice(0, 300);
		await blockAccount(accountId, { reason: SPAM_TRAP_REASON, by: "trap", detail });
	}
	// Complaints are few, so each one is counted at once instead of waiting for the next check.
	if (plan.suppression) await checkAccountHealth(accountId, { isUrgent: plan.suppression.reason === "complaint" });
	if (plan.suppression?.reason === "complaint") {
		await sendAlert({
			accountId,
			key: "complaints",
			title: "Spam complaint",
			detail: `${plan.suppression.emails.join(", ")} marked an email as spam. Contacts are suppressed.`,
			path: message?.campaignId ? `/campaigns/${message.campaignId}` : "",
		});
	}
	return { handled: true, messageId: message ? String(message._id) : null };
}
