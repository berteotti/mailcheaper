import { isDisposableDomain } from "./disposable-domains.js";
import { getEmailSuggestion } from "./email-typos.js";

export const CONSENT_TEXT = "These people agreed to receive my emails";

export const DROP_REASONS = {
	invalid: "invalid address",
	typo: "misspelled domain (gmial.com…)",
	trap: "spam trap address",
	role: "role address (info@, support@…)",
	disposable: "throwaway inbox",
	duplicate: "duplicate in the file",
	suppressed: "bounced or complained before",
	noMail: "domain can't receive email",
};

// Addresses that say what they are: published on web pages to catch scrapers, never by a person signing up.
const TRAP_LOCAL_PART = /spam[._-]?trap|honey[._-]?pot/;

// Shared inboxes nobody signed up with personally; they complain and bounce more than people do.
const ROLE_LOCAL_PARTS = new Set([
	"abuse",
	"accounting",
	"admin",
	"administrator",
	"billing",
	"careers",
	"compliance",
	"contact",
	"customerservice",
	"enquiries",
	"feedback",
	"hello",
	"help",
	"helpdesk",
	"hostmaster",
	"hr",
	"info",
	"inquiries",
	"jobs",
	"legal",
	"mail",
	"mailer-daemon",
	"marketing",
	"media",
	"newsletter",
	"no-reply",
	"noreply",
	"office",
	"postmaster",
	"press",
	"privacy",
	"root",
	"sales",
	"security",
	"spam",
	"support",
	"team",
	"webmaster",
]);

// For a normalized address: why it shouldn't become a contact that gets emails, or null.
export function getDropReason(email) {
	const [localPart, domain] = email.split("@");
	if (TRAP_LOCAL_PART.test(localPart)) return "trap";
	if (getEmailSuggestion(email)) return "typo";
	if (ROLE_LOCAL_PARTS.has(localPart.split("+")[0])) return "role";
	if (isDisposableDomain(domain)) return "disposable";
	return null;
}

// A signup form, add_contact or MCP adding one normalized address: what to tell the person typing it, or null.
// Role and throwaway addresses still sign up, since people do sign up with them themselves.
export function getSignupEmailProblem(email) {
	const suggestion = getEmailSuggestion(email);
	if (suggestion) return `Did you mean ${suggestion}?`;
	if (TRAP_LOCAL_PART.test(email.split("@")[0])) return "This address can't be added";
	return null;
}

export function emptyDropped() {
	return Object.fromEntries(Object.keys(DROP_REASONS).map((reason) => [reason, 0]));
}

export function addDropped(total, dropped) {
	return Object.fromEntries(Object.keys(DROP_REASONS).map((reason) => [reason, (total[reason] ?? 0) + (dropped[reason] ?? 0)]));
}
