import { CONFIRM_URL_PLACEHOLDER } from "./confirmation-content.js";
import { getLanguageName } from "./languages.js";
import { KEEP_URL_PLACEHOLDER } from "./last-chance-content.js";
import { fillForReader } from "./merge-tags.js";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail, withResponsiveImages } from "./render-email.js";

// What a preview's frame shows of a rendered email: its links to unsubscribe, confirm or stay go nowhere, and pictures
// fit the frame.
export function toPreviewFrame(html) {
	return withResponsiveImages(
		html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#").replaceAll(CONFIRM_URL_PLACEHOLDER, "#").replaceAll(KEEP_URL_PLACEHOLDER, "#")
	);
}

// An email as one reader gets it, for the full-screen preview. content: what renderEmail takes. reader: a contact or
// SAMPLE_READER, whose name fills the merge tags the way a send fills them (buildRecipientEmail).
export function previewForReader(content, reader) {
	return { html: toPreviewFrame(renderEmail({ ...content, contact: reader }).html), ...fillForReader(content, reader) };
}

// The preview shows the language being edited, whoever is picked. A contact the send gives another language's email, or
// nothing, is told so: matcher is the campaign's getEditionMatcher, shown the language on screen. Null when it's theirs.
export function getEditionNote({ matcher, shown, contact }) {
	const tag = matcher.match(contact.language);
	const name = contact.firstName || contact.email;
	if (!tag) return `${name} is left out: nothing in their language or the newsletter's`;
	return tag === shown ? null : `${name} gets the ${getLanguageName(tag)} email`;
}
