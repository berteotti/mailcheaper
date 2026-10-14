import "server-only";
import { sendAlert } from "@/lib/alerts";
import { connectDb, getOne, newId, statement } from "@/lib/db";
import { getSesEventPlan, getTrackingPlan } from "@/lib/ses-event-mapping";
import { isLikelyScanner } from "@/lib/tracking";

export { getSesEventPlan } from "@/lib/ses-event-mapping";

// Every send produces a delivery event; storing those raw would fill the database within months.
const RECORDED_EVENT_TYPES = new Set(["Bounce", "Complaint", "Reject", "DeliveryDelay", "RenderingFailure"]);
// Any event from SES proves an unconfirmed (ambiguous) attempt went out.
const UNCONFIRMED = ["sending", "ambiguous"];

// The message_id tag covers events that arrive before sesMessageId is saved.
async function findMessage({ sesMessageId, messageId }) {
	if (sesMessageId) {
		const message = await getOne("SELECT * FROM messages WHERE sesMessageId = ?", [sesMessageId]);
		if (message) return message;
	}
	if (!messageId) return null;

	const message = await getOne("SELECT * FROM messages WHERE _id = ?", [messageId]);
	if (!message) return null;
	if (message.sesMessageId && sesMessageId && message.sesMessageId !== sesMessageId) return null;
	return message;
}

// One D1 transaction per event. The trigger in migrations/0002 moves each counter only on a first
// transition, so SNS redeliveries and out-of-order events are harmless.
function messageStatements(db, message, plan, sesMessageId) {
	const at = plan.occurredAt.getTime();
	const now = Date.now();
	const statements = [];
	if (sesMessageId) {
		statements.push(statement(db, "UPDATE messages SET sesMessageId = ?, updatedAt = ? WHERE _id = ? AND sesMessageId IS NULL",
			[sesMessageId, now, message._id]));
	}
	if (UNCONFIRMED.includes(message.status) && message.kind !== "test") {
		statements.push(statement(db, `UPDATE messages SET status = 'sent', sentAt = coalesce(sentAt, ?), error = NULL, updatedAt = ?
			WHERE _id = ? AND status IN ('sending', 'ambiguous')`, [at, now, message._id]));
	}
	for (const { field } of plan.firsts) {
		statements.push(statement(db, `UPDATE messages SET ${field} = ?, updatedAt = ? WHERE _id = ? AND ${field} IS NULL`,
			[at, now, message._id]));
	}
	if (plan.status) {
		const from = [...plan.status.from, ...UNCONFIRMED];
		statements.push(statement(db, `UPDATE messages SET status = ?, updatedAt = ? WHERE _id = ?
			AND status IN (SELECT value FROM json_each(?))`, [plan.status.to, now, message._id, JSON.stringify(from)]));
	}
	if (plan.error) {
		statements.push(statement(db, "UPDATE messages SET error = ?, updatedAt = ? WHERE _id = ?", [plan.error.slice(0, 500), now, message._id]));
	}
	// Repeat opens and clicks still move the contact's engagement dates forward.
	if (message.contactId && plan.engagement) {
		const { lastOpenAt, lastClickAt } = plan.engagement;
		statements.push(statement(db, `UPDATE contacts SET ignoredIssues = 0,
			lastOpenAt = nullif(max(coalesce(lastOpenAt, 0), ?), 0), lastClickAt = nullif(max(coalesce(lastClickAt, 0), ?), 0),
			lastEngagedAt = max(coalesce(lastEngagedAt, 0), ?), updatedAt = ? WHERE _id = ?`,
		[lastOpenAt?.getTime() ?? 0, lastClickAt?.getTime() ?? 0, at, now, message.contactId]));
	}
	return statements;
}

// Global: the address is never emailed again, from any newsletter. A complaint outranks an earlier
// bounce or manual suppression, and a hard bounce outranks a manual one; the triggers in migrations/0002 update every newsletter's contacts.
function suppressionStatements(db, { emails, reason, detail }) {
	const now = Date.now();
	return emails.map((email) => statement(db, `INSERT INTO suppressions (_id, email, reason, detail, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, updatedAt = excluded.updatedAt
		WHERE (excluded.reason = 'complaint' AND suppressions.reason != 'complaint')
			OR (excluded.reason = 'bounce' AND suppressions.reason = 'manual')`, [newId(), email, reason, detail ?? null, now, now]));
}

// Mailcheap's own open pixel and click links update messages the way SES events do.
export async function recordEngagement({ messageId, type, userAgent }) {
	const message = await getOne("SELECT _id, kind, status, campaignId, contactId, sentAt FROM messages WHERE _id = ?", [messageId]);
	if (!message) return;
	if (type === "Click" && isLikelyScanner({ userAgent, sentAt: message.sentAt })) return;
	const db = await connectDb();
	await db.batch(messageStatements(db, message, getTrackingPlan(type), null));
}

export async function handleSesEvent(sesEvent) {
	const plan = getSesEventPlan(sesEvent);
	if (!plan) return { handled: false };

	const db = await connectDb();
	const message = await findMessage(plan);
	const statements = [
		...(message ? messageStatements(db, message, plan, plan.sesMessageId) : []),
		...(plan.suppression ? suppressionStatements(db, plan.suppression) : []),
	];
	if (RECORDED_EVENT_TYPES.has(plan.type)) {
		const now = Date.now();
		statements.push(statement(db, `INSERT INTO events (_id, type, sesMessageId, messageId, campaignId, email, occurredAt, data, createdAt, updatedAt)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [newId(), plan.type, plan.sesMessageId, message?._id ?? null, message?.campaignId ?? null,
			plan.email ?? message?.email ?? null, plan.occurredAt, JSON.stringify(plan.data), now, now]));
	}
	if (statements.length) await db.batch(statements);

	if (plan.suppression?.reason === "complaint") {
		await sendAlert({
			key: "complaints",
			title: "Spam complaint",
			detail: `${plan.suppression.emails.join(", ")} marked an email as spam. Contacts are suppressed.`,
			path: message?.campaignId ? `/campaigns/${message.campaignId}` : "",
		});
	}
	return { handled: true, messageId: message ? String(message._id) : null };
}
