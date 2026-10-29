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

// The tags emails fill in, as the editor names them: its suggestions, its pills' tooltips and the review step.
export const MERGE_FIELDS = [
	{ key: "first_name", label: "First name", sample: "Jane" },
	{ key: "last_name", label: "Last name", sample: "Doe" },
];
const TAG_PATTERN = /\{\{\s*(first_name|last_name)\s*(?:\|([^{}]*))?\}\}/gi;
const ANY_TAG_PATTERN = /\{\{[^{}]{0,200}\}\}/g;
const WHOLE_TAG_PATTERN = new RegExp(`^${TAG_PATTERN.source}$`, "i");

export function getMergeField(key) {
	return MERGE_FIELDS.find((field) => field.key === String(key ?? "").toLowerCase()) ?? null;
}

// Each tag in the text, where it is, with its fallback ("" for none): what the editor draws as a pill.
export function findMergeTags(text) {
	return [...String(text ?? "").matchAll(TAG_PATTERN)].map((match) => ({
		index: match.index,
		length: match[0].length,
		key: match[1].toLowerCase(),
		fallback: (match[2] ?? "").trim(),
	}));
}

// {{...}} that isn't a name's tag: another platform's tag, a typo, or a tag split by formatting. It would go out as
// written, so the review step points it out.
export function findBrokenMergeTags(values) {
	const broken = new Set();
	for (const value of values) {
		for (const [token] of String(value ?? "").matchAll(ANY_TAG_PATTERN)) if (!WHOLE_TAG_PATTERN.test(token)) broken.add(token);
	}
	return [...broken];
}
