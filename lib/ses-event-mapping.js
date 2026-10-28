import { getEventPlan } from "./email-event-rules.js";
import { isObjectIdString, isPlainObject, normalizeAddress } from "./validation.js";

const DETAIL_KEYS = new Map([
	["Send", "send"],
	["Delivery", "delivery"],
	["Bounce", "bounce"],
	["Complaint", "complaint"],
	["Open", "open"],
	["Click", "click"],
	["Reject", "reject"],
	["DeliveryDelay", "deliveryDelay"],
	["RenderingFailure", "failure"],
]);

const EVENT_TYPES = {
	Send: "sent",
	Delivery: "delivered",
	Bounce: "bounce",
	Complaint: "complaint",
	Open: "open",
	Click: "click",
	Reject: "dropped",
	DeliveryDelay: "deferred",
	RenderingFailure: "dropped",
};

// Auto Validation (lib/ses.js) judged the mailbox unlikely to exist, and SES sent nothing.
const VALIDATION_SUPPRESSED = "EmailValidationSuppressed";

// Configuration-set event publishing uses eventType; identity notifications use notificationType.
export function getSesEventType(sesEvent) {
	const type = String(sesEvent?.eventType ?? sesEvent?.notificationType ?? "").replace(" ", "");
	return DETAIL_KEYS.has(type) ? type : null;
}

function toDate(value) {
	const date = value ? new Date(value) : null;
	return date && Number.isFinite(date.getTime()) ? date : null;
}

function readTag(tags, name) {
	if (!isPlainObject(tags) || !Object.hasOwn(tags, name)) return null;
	const value = Array.isArray(tags[name]) ? tags[name][0] : tags[name];
	return isObjectIdString(value) ? value.toLowerCase() : null;
}

function readRecipients(recipients, fallback) {
	const emails = (Array.isArray(recipients) ? recipients : [])
		.map((recipient) => normalizeAddress(recipient?.emailAddress))
		.filter(Boolean);
	if (emails.length > 0) return [...new Set(emails)];
	return fallback ? [fallback] : [];
}

function withoutMailHeaders(sesEvent) {
	if (!isPlainObject(sesEvent.mail)) return sesEvent;
	const mail = { ...sesEvent.mail };
	delete mail.headers;
	return { ...sesEvent, mail };
}

// Pure: one SES event in the shape every provider's events take (lib/email-event-rules.js).
export function normalizeSesEvent(sesEvent) {
	const sesType = getSesEventType(sesEvent);
	if (!sesType) return null;

	const mail = isPlainObject(sesEvent.mail) ? sesEvent.mail : {};
	const detail = isPlainObject(sesEvent[DETAIL_KEYS.get(sesType)]) ? sesEvent[DETAIL_KEYS.get(sesType)] : {};
	const email = normalizeAddress(Array.isArray(mail.destination) ? mail.destination[0] : null);
	const event = {
		type: EVENT_TYPES[sesType],
		recordAs: sesType,
		providerMessageId: typeof mail.messageId === "string" && mail.messageId ? mail.messageId : null,
		messageId: readTag(mail.tags, "message_id"),
		accountId: readTag(mail.tags, "account_id"),
		email,
		emails: [],
		occurredAt: toDate(detail.timestamp) ?? toDate(mail.timestamp) ?? new Date(),
		data: withoutMailHeaders(sesEvent),
	};

	if (sesType === "Bounce") {
		const reason = [detail.bounceSubType, detail.bouncedRecipients?.[0]?.diagnosticCode].filter(Boolean).join(", ");
		Object.assign(event, {
			bounce: detail.bounceType === "Permanent" ? "hard" : "soft",
			unsent: detail.bounceSubType === VALIDATION_SUPPRESSED,
			reason: reason || null,
			detail: `${detail.bounceType}/${detail.bounceSubType ?? "General"}`,
			emails: readRecipients(detail.bouncedRecipients, email),
		});
	}
	if (sesType === "Complaint") {
		Object.assign(event, {
			feedback: detail.complaintFeedbackType ?? null,
			detail: detail.complaintFeedbackType ?? "abuse",
			emails: readRecipients(detail.complainedRecipients, email),
		});
	}
	if (sesType === "Click") event.link = detail.link;
	if (sesType === "Reject") event.error = `Rejected by SES: ${detail.reason ?? "unknown"}`;
	if (sesType === "RenderingFailure") event.error = `Rendering failed: ${detail.errorMessage ?? "unknown"}`;
	return event;
}

// Pure: turns one SES event into the updates lib/email-events.js applies, so the mapping is testable.
export function getSesEventPlan(sesEvent) {
	return getEventPlan(normalizeSesEvent(sesEvent));
}
