// {{first_name}} and {{last_name}} in an email's subject, preview text or content become the contact's name. What
// follows a | stands in for a contact without one, and wherever there's no contact: previews, the archive.
// The editor previews emails in the browser too, so this module imports nothing.
const MERGE_TAG_PATTERN = /\{\{\s*(first_name|last_name)\s*(?:\|([^{}]*))?\}\}/gi;
const FIELDS = { first_name: "firstName", last_name: "lastName" };

// escape: how a name goes into the text, like escapeHtml for HTML. The fallback is the author's, already in the text's
// own form.
export function fillMergeTags(text, contact = null, escape = (value) => value) {
	if (typeof text !== "string") return text;
	return text.replace(MERGE_TAG_PATTERN, (_, field, fallback = "") => {
		const name = contact?.[FIELDS[field.toLowerCase()]]?.trim();
		return name ? escape(name) : fallback.trim();
	});
}
