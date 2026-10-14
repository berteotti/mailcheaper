import "server-only";
import { getAll } from "@/lib/db";
import { MESSAGE_STATS_FIELDS, MESSAGE_STATS_SQL } from "@/lib/message-stats";
import { PERIOD_DAYS, buildHourlySeries, buildSubscriberSeries, periodDayKeys, splitPeriods } from "@/lib/overview-series";
import { hourIn, shiftDateKey, startOfDateKey, toDateKey } from "@/lib/time-zone";

const DAY_MS = 86_400_000;
const STAT_KEYS = Object.keys(MESSAGE_STATS_FIELDS);
const IMPORT_WINDOW_MS = 60_000;
const PAGE_SIZE = 500;

function joinedKey(contact, rangeStart, timeZone) {
	const joined = new Date(Math.max(contact.subscribedAt?.getTime() ?? 0, contact.confirmedAt?.getTime() ?? 0));
	const importedWithoutDate = contact.source === "import" && Math.abs(contact.subscribedAt - contact.createdAt) < IMPORT_WINDOW_MS;
	return importedWithoutDate || joined < rangeStart ? null : toDateKey(joined, timeZone);
}

function hasLeftInMailcheap(leftAt, contact) {
	return Boolean(leftAt) && leftAt.getTime() > contact.createdAt.getTime() + IMPORT_WINDOW_MS;
}

export async function getSubscriberHistory({ newsletterId, timeZone, now = new Date() }) {
	const dayKeys = periodDayKeys(toDateKey(now, timeZone));
	const rangeStart = startOfDateKey(dayKeys[0], timeZone);
	const joins = {};
	const leaves = {};
	let baseline = 0;
	let cursor = "";
	for (;;) {
		const contacts = await getAll(`SELECT c._id, c.status, c.source, c.subscribedAt, c.confirmedAt, c.unsubscribedAt, c.createdAt,
			s.createdAt AS suppressedAt, s.reason AS suppressionReason, s.detail AS suppressionDetail
			FROM contacts c LEFT JOIN suppressions s ON s.email = c.email
			WHERE c.newsletterId = ? AND c._id > ? ORDER BY c._id LIMIT ?`, [newsletterId, cursor, PAGE_SIZE]);
		for (const contact of contacts) {
			let leftAt = null;
			if (contact.status !== "active") {
				if (!["unsubscribed", "bounced", "complained"].includes(contact.status)) continue;
				if (hasLeftInMailcheap(contact.unsubscribedAt, contact)) leftAt = contact.unsubscribedAt;
				else if (["bounced", "complained"].includes(contact.status)
					&& ["bounce", "complaint"].includes(contact.suppressionReason) && contact.suppressionDetail !== "import"
					&& hasLeftInMailcheap(contact.suppressedAt, contact)) leftAt = contact.suppressedAt;
				if (!leftAt || leftAt < rangeStart) continue;
			}
			const joined = joinedKey(contact, rangeStart, timeZone);
			if (joined) joins[joined] = (joins[joined] ?? 0) + 1;
			else baseline++;
			if (leftAt) {
				const key = toDateKey(leftAt, timeZone);
				leaves[key] = (leaves[key] ?? 0) + 1;
			}
		}
		if (contacts.length < PAGE_SIZE) break;
		cursor = contacts.at(-1)._id;
	}
	return splitPeriods(buildSubscriberSeries({ dayKeys, baseline, joins, leaves }));
}

function emptyStats() {
	return Object.fromEntries(STAT_KEYS.map((key) => [key, 0]));
}

export async function getEmailStats({ newsletterId, now = new Date() }) {
	const since = now.getTime() - PERIOD_DAYS * DAY_MS;
	const previousSince = since - PERIOD_DAYS * DAY_MS;
	const [campaigns, welcomes] = await Promise.all([
		getAll(`SELECT CASE WHEN coalesce(startedAt, sentAt) >= ? THEN 'current' ELSE 'previous' END AS period,
			${STAT_KEYS.map((key) => `sum(coalesce(json_extract(stats, '$.${key}'), 0)) AS ${key}`).join(", ")}
			FROM campaigns WHERE newsletterId = ? AND coalesce(startedAt, sentAt) >= ? GROUP BY period`, [since, newsletterId, previousSince]),
		getAll(`SELECT CASE WHEN createdAt >= ? THEN 'current' ELSE 'previous' END AS period, ${MESSAGE_STATS_SQL}
			FROM messages WHERE newsletterId = ? AND kind = 'welcome' AND createdAt >= ? GROUP BY period`, [since, newsletterId, previousSince]),
	]);
	const totals = { current: emptyStats(), previous: emptyStats() };
	for (const row of [...campaigns, ...welcomes]) for (const key of STAT_KEYS) totals[row.period][key] += row[key] ?? 0;
	return totals;
}

export async function getHourlySends({ newsletterId, timeZone, now = new Date() }) {
	const todayKey = toDateKey(now, timeZone);
	const since = startOfDateKey(shiftDateKey(todayKey, -1), timeZone).getTime();
	const buckets = new Map();
	let sentAt = since;
	let id = "";
	for (;;) {
		const rows = await getAll(`SELECT _id, sentAt FROM messages WHERE newsletterId = ? AND (sentAt, _id) > (?, ?)
			ORDER BY sentAt, _id LIMIT ?`, [newsletterId, sentAt, id, PAGE_SIZE]);
		for (const row of rows) {
			const day = toDateKey(row.sentAt, timeZone);
			const hour = hourIn(row.sentAt, timeZone);
			const key = `${day} ${hour}`;
			const bucket = buckets.get(key) ?? { day, hour, count: 0 };
			bucket.count++;
			buckets.set(key, bucket);
		}
		if (rows.length < PAGE_SIZE) break;
		sentAt = rows.at(-1).sentAt.getTime();
		id = rows.at(-1)._id;
	}
	return buildHourlySeries({ rows: [...buckets.values()], todayKey, currentHour: hourIn(now, timeZone) });
}
