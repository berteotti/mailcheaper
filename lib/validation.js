const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
// Dot-atom local part and hostname labels: rejects quoted strings, commas, display names and doubled dots. Domain
// endings are letters, or xn-- for internationalized ones: none has a digit.
const EMAIL_PATTERN =
	/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?)$/;

export const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
export const MAX_NAME_LENGTH = 100;
// A stray tab or line break in a name becomes a space; invisible characters that hide or reorder text (a zero-width
// space, a right-to-left override) go. Zero-width joiners stay: Persian and some Indic names are spelled with them.
const NAME_CONTROL_PATTERN = /\p{Cc}+/gu;
const NAME_INVISIBLE_PATTERN = /[\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;
// Issue bodies from the API and the editor. Archive pages clean them on each render.
export const MAX_BODY_BYTES = 500_000;

// Where to go after signing in: a path on this site, with at most a plain query string (?plan=growth&interval=year).
const NEXT_PATH_PATTERN = /^\/(?!\/)[\w\-/]*(\?[\w\-=&]*)?$/;

export function toSafeNextPath(value) {
	return typeof value === "string" && NEXT_PATH_PATTERN.test(value) ? value : "/";
}

export function isObjectIdString(value) {
	return typeof value === "string" && OBJECT_ID_PATTERN.test(value);
}

export function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeEmail(value) {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	if (email.length > MAX_EMAIL_LENGTH || email.indexOf("@") > MAX_LOCAL_PART_LENGTH) return null;
	return EMAIL_PATTERN.test(email) ? email : null;
}

// A contact's first or last name as it's stored, or null for none.
export function normalizeName(value) {
	if (typeof value !== "string") return null;
	const name = value.normalize("NFC").replace(NAME_CONTROL_PATTERN, " ").replace(NAME_INVISIBLE_PATTERN, "").replace(/\s+/g, " ").trim();
	return name ? [...name].slice(0, MAX_NAME_LENGTH).join("").trim() : null;
}

// "Jane van Doe" -> ["Jane", "van Doe"]: a full name's first word, then the rest.
export function splitFullName(value) {
	const name = normalizeName(value);
	if (!name) return [null, null];
	const space = name.indexOf(" ");
	return space === -1 ? [name, null] : [name.slice(0, space), name.slice(space + 1)];
}

// "Dana <dana@example.com>" or a bare address, as mail headers and SES events give them.
export function normalizeAddress(value) {
	const match = /<([^<>]+)>\s*$/.exec(String(value ?? ""));
	return normalizeEmail(match ? match[1] : value);
}
