import { DEFAULT_LANGUAGE } from "./languages.js";

// Most engaged first, so warm-up sends capped by audienceLimit reach likely openers.
export const AUDIENCE_SORT = {
	lastClickAt: -1,
	lastOpenAt: -1,
	"imported.clickRate": -1,
	"imported.openRate": -1,
	createdAt: 1,
	_id: 1,
};

function normalizeLimit(audienceLimit) {
	const limit = Number(audienceLimit);
	return Number.isInteger(limit) && limit > 0 ? limit : null;
}

// AUDIENCE_SORT as ascending SQL keys: a missing value sorts last, like MongoDB descending, so a page
// can continue after the previous page's last row with one row-value comparison.
const MISSING_LAST = "1e15";
export const AUDIENCE_KEYS = [
	`coalesce(-c.lastClickAt, ${MISSING_LAST})`,
	`coalesce(-c.lastOpenAt, ${MISSING_LAST})`,
	`coalesce(-json_extract(c.imported, '$.clickRate'), ${MISSING_LAST})`,
	`coalesce(-json_extract(c.imported, '$.openRate'), ${MISSING_LAST})`,
	"c.createdAt",
	"c._id",
];
const KEY_SELECT = AUDIENCE_KEYS.map((key, index) => `${key} AS k${index}`).join(", ");
export const AUDIENCE_ORDER = AUDIENCE_KEYS.map((_, index) => `k${index}`).join(", ");
const KEY_ORDER = AUDIENCE_ORDER;

// Contacts (as c) reading one of these base languages, for a campaign's audience (lib/editions.js): a contact
// without a language reads its newsletter's. Every contact when languages is null.
export function languageFilter(languages, newsletter) {
	if (!languages) return { sql: "", params: [] };
	return {
		sql: "AND coalesce(c.language, ?) IN (SELECT value FROM json_each(?))",
		params: [newsletter?.language ?? DEFAULT_LANGUAGE, JSON.stringify(languages)],
	};
}

// Active contacts the account hasn't suppressed, most engaged first, one bounded page at a time. filter: a
// languageFilter.
export function buildAudiencePage({ accountId, newsletterId, columns = "c._id, c.email", filter = null, after = null, limit }) {
	const params = [String(accountId), String(newsletterId), ...(filter?.params ?? [])];
	let continuation = "";
	if (after) {
		continuation = `AND (${KEY_ORDER}) > (${AUDIENCE_KEYS.map(() => "?").join(", ")})`;
		params.push(...AUDIENCE_KEYS.map((_, index) => after[`k${index}`]));
	}
	params.push(limit);
	return {
		sql: `SELECT * FROM (SELECT ${columns}, ${KEY_SELECT} FROM contacts c
			WHERE c.accountId = ? AND c.newsletterId = ? AND c.status = 'active' ${filter?.sql ?? ""}
			AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.accountId = c.accountId AND s.email = c.email))
			WHERE true ${continuation} ORDER BY ${KEY_ORDER} LIMIT ?`,
		params,
	};
}

export function normalizeAudienceLimit(audienceLimit) {
	return normalizeLimit(audienceLimit);
}

function readPath(document, path) {
	return path.split(".").reduce((value, key) => value?.[key], document);
}

function toComparable(value) {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "object") return String(value);
	return value;
}

// Same order as MongoDB: a missing value is the lowest, so it sorts last when descending.
function compareValues(left, right, direction) {
	const isLeftMissing = left == null;
	const isRightMissing = right == null;
	if (isLeftMissing || isRightMissing) {
		if (isLeftMissing && isRightMissing) return 0;
		return (isLeftMissing ? -1 : 1) * direction;
	}
	const a = toComparable(left);
	const b = toComparable(right);
	if (a === b) return 0;
	return (a < b ? -1 : 1) * direction;
}

export function compareByEngagement(left, right) {
	for (const [path, direction] of Object.entries(AUDIENCE_SORT)) {
		const result = compareValues(readPath(left, path), readPath(right, path), direction);
		if (result !== 0) return result;
	}
	return 0;
}

export function selectAudience(contacts, { suppressedEmails = [], audienceLimit } = {}) {
	const suppressed = new Set(suppressedEmails);
	const limit = normalizeLimit(audienceLimit);
	const audience = contacts
		.filter(({ status, email }) => status === "active" && !suppressed.has(email))
		.toSorted(compareByEngagement);
	return limit ? audience.slice(0, limit) : audience;
}
