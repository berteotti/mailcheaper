import { getAppUrl } from "./config.js";
import { createContactToken, verifyContactToken } from "./contact-token.js";

// Its own key, so an unsubscribe link can never confirm a subscription or the other way around.
const INFO = "mailcheap-confirm-v1";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function createConfirmToken({ contactId, newsletterId }, now = Date.now()) {
	return createContactToken({ info: INFO, contactId, newsletterId }, now);
}

export function verifyConfirmToken(token, now = Date.now()) {
	return verifyContactToken(token, { info: INFO, maxAgeMs: MAX_AGE_MS, now });
}

// now: when the email was created, so a retried send carries the same link.
export function getConfirmUrl({ contactId, newsletterId }, baseUrl = getAppUrl(), now = Date.now()) {
	return `${baseUrl}/confirm?token=${createConfirmToken({ contactId, newsletterId }, now)}`;
}
