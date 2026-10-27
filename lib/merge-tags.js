// {{first_name}} and {{last_name}} in an email's subject, preview text or content become the contact's name. What
// follows a | stands in for a contact without one, and wherever there's no contact: previews, the archive. With
// nothing there, the tag goes with the spaces before it, so "Hi {{first_name}}," reads "Hi,".
// The editor previews emails in the browser too, so this module imports nothing.
// Those spaces are taken from the start of their run, so a long run is read once, and across the elements opening
// right before the tag, like the bold in "Hi **{{first_name}}**,".
const MERGE_TAG_PATTERN = /(?:(?<![ \t])([ \t]+)((?:<[a-z][^<>]*>)*))?\{\{\s*(first_name|last_name)\s*(?:\|([^{}]*))?\}\}/gi;
const FIELDS = { first_name: "firstName", last_name: "lastName" };

// escape: how a name goes into the text, like escapeHtml for HTML. The fallback is the author's, already in the text's
// own form.
export function fillMergeTags(text, contact = null, escape = (value) => value) {
	if (typeof text !== "string") return text;
	return text.replace(MERGE_TAG_PATTERN, (_, spaces = "", openings = "", field, fallback = "") => {
		const name = contact?.[FIELDS[field.toLowerCase()]]?.trim();
		const value = name ? escape(name) : fallback.trim();
		return value ? `${spaces}${openings}${value}` : openings;
	});
}
