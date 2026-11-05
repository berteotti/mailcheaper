import "server-only";
import { getAll } from "@/lib/db";
import { MESSAGE_STATS_FIELDS, MESSAGE_STATS_SQL } from "@/lib/message-stats";
import { PERIOD_DAYS, buildHourlySeries, buildSubscriberSeries, getPeriodPoints, splitPeriods } from "@/lib/overview-series";
import { DEFAULT_TIME_ZONE, hourIn, shiftDateKey, startOfDateKey, toDateKey, toHourKey } from "@/lib/time-zone";

const DAY_MS = 86_400_000;
// Every timezone is a whole number of quarter hours from UTC, so emails counted by the quarter hour in SQL land in the
// right local hour and day.
const QUARTER_HOUR_MS = 900_000;
const STAT_KEYS = Object.keys(MESSAGE_STATS_FIELDS);
const IMPORT_WINDOW_MS = 60_000;
const PAGE_SIZE = 500;

function joinedKey(contact, rangeStart, toKey) {
	const joined = new Date(Math.max(contact.subscribedAt?.getTime() ?? 0, contact.confirmedAt?.getTime() ?? 0));
	const importedWithoutDate = contact.source === "import" && Math.abs(contact.subscribedAt - contact.createdAt) < IMPORT_WINDOW_MS;
	return importedWithoutDate || joined < rangeStart ? null : toKey(joined);
}

function hasLeftInMailcheap(leftAt, contact) {
	return Boolean(leftAt) && leftAt.getTime() > contact.createdAt.getTime() + IMPORT_WINDOW_MS;
}

// Active subscribers at the end of each of a period's points, its days or its hours (lib/overview-series.js
// getPeriodPoints), and of the period before's: the last 30 days unless points picks another. Active contacts count
// from the day they joined (confirmed, for confirmed opt-in; CSV imports keep the file's signup date). Contacts who
// left count until they left, when MailCheap knows the date: unsubscribedAt, or the suppression a bounce or complaint
// created. Pending, dormant and contacts imported as unsubscribed or bounced have no such date and are left out of
// every day.
export async function getSubscriberHistory({
	accountId,
	newsletterId,
	timeZone,
	now = new Date(),
	points = getPeriodPoints({ days: PERIOD_DAYS }, { timeZone, now }),
}) {
	const rangeStart = points.start;
	const toKey = (date) => (points.unit === "hour" ? toHourKey(date, timeZone) : toDateKey(date, timeZone));
	const joins = {};
	const leaves = {};
	let baseline = 0;
	let cursor = "";
	for (;;) {
		const contacts = await getAll(`SELECT c._id, c.status, c.source, c.subscribedAt, c.confirmedAt, c.unsubscribedAt, c.createdAt,
			s.createdAt AS suppressedAt, s.reason AS suppressionReason, s.detail AS suppressionDetail
			FROM contacts c LEFT JOIN suppressions s ON s.accountId = c.accountId AND s.email = c.email
			WHERE c.accountId = ? AND c.newsletterId = ? AND c._id > ? ORDER BY c._id LIMIT ?`, [accountId, newsletterId, cursor, PAGE_SIZE]);
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
			const joined = joinedKey(contact, rangeStart, toKey);
			if (joined) joins[joined] = (joins[joined] ?? 0) + 1;
			else baseline++;
			if (leftAt) {
				const key = toKey(leftAt);
				leaves[key] = (leaves[key] ?? 0) + 1;
			}
		}
		if (contacts.length < PAGE_SIZE) break;
		cursor = contacts.at(-1)._id;
	}
	const dayKeys = [...points.previous, ...points.current];
	return splitPeriods(buildSubscriberSeries({ dayKeys, baseline, joins, leaves }), points.previous.length);
}

function emptyStats() {
	return Object.fromEntries(STAT_KEYS.map((key) => [key, 0]));
}

// Issues and welcome emails of a period and of as many days before: the last `days` up to now, or the whole days
// from and to, both included, in timeZone.
export async function getEmailStats({ accountId, newsletterId, days = PERIOD_DAYS, from, to, timeZone = DEFAULT_TIME_ZONE, now = new Date() }) {
	const since = from ? startOfDateKey(from, timeZone).getTime() : now.getTime() - days * DAY_MS;
	const previousSince = from ? startOfDateKey(shiftDateKey(from, -days), timeZone).getTime() : since - days * DAY_MS;
	// The last instant counted: now, or the day to's last.
	const until = to ? startOfDateKey(shiftDateKey(to, 1), timeZone).getTime() - 1 : now.getTime();
	const [campaigns, welcomes] = await Promise.all([
		getAll(`SELECT CASE WHEN coalesce(startedAt, sentAt) >= ? THEN 'current' ELSE 'previous' END AS period,
			${STAT_KEYS.map((key) => `sum(coalesce(json_extract(stats, '$.${key}'), 0)) AS ${key}`).join(", ")}
			FROM campaigns WHERE accountId = ? AND newsletterId = ? AND coalesce(startedAt, sentAt) BETWEEN ? AND ? GROUP BY period`,
		[since, accountId, newsletterId, previousSince, until]),
		getAll(`SELECT CASE WHEN createdAt >= ? THEN 'current' ELSE 'previous' END AS period, ${MESSAGE_STATS_SQL}
			FROM messages WHERE accountId = ? AND newsletterId = ? AND kind = 'welcome' AND createdAt BETWEEN ? AND ? GROUP BY period`,
		[since, accountId, newsletterId, previousSince, until]),
	]);
	const totals = { current: emptyStats(), previous: emptyStats() };
	for (const row of [...campaigns, ...welcomes]) for (const key of STAT_KEYS) totals[row.period][key] += row[key] ?? 0;
	return totals;
}

// The issues and welcome emails sent at each of a period's points and the period before's (lib/overview-series.js
// getPeriodPoints), a number for each key. Hour by hour, each email counts when it went out; day by day, an issue's
// emails count on the day it started, as in the email stats, which spares reading every email of a year.
export async function getSends({ accountId, newsletterId, timeZone, points }) {
	const range = [accountId, newsletterId, points.start, points.end];
	const rows = points.unit === "hour"
		? await getAll(`SELECT sentAt / ${QUARTER_HOUR_MS} AS quarter, count(*) AS count FROM messages
			WHERE accountId = ? AND newsletterId = ? AND kind IN ('campaign', 'welcome') AND sentAt >= ? AND sentAt < ? GROUP BY quarter`, range)
		: (await Promise.all([
			getAll(`SELECT coalesce(startedAt, sentAt) / ${QUARTER_HOUR_MS} AS quarter, sum(coalesce(json_extract(stats, '$.sent'), 0)) AS count
				FROM campaigns WHERE accountId = ? AND newsletterId = ? AND coalesce(startedAt, sentAt) >= ? AND coalesce(startedAt, sentAt) < ?
				GROUP BY quarter`, range),
			getAll(`SELECT createdAt / ${QUARTER_HOUR_MS} AS quarter, sum(sentAt IS NOT NULL) AS count FROM messages
				WHERE accountId = ? AND newsletterId = ? AND kind = 'welcome' AND createdAt >= ? AND createdAt < ? GROUP BY quarter`, range),
		])).flat();
	const toKey = points.unit === "hour" ? toHourKey : toDateKey;
	const counts = new Map();
	for (const { quarter, count } of rows) {
		const key = toKey(new Date(quarter * QUARTER_HOUR_MS), timeZone);
		counts.set(key, (counts.get(key) ?? 0) + count);
	}
	return {
		previous: points.previous.map((key) => counts.get(key) ?? 0),
		current: points.current.map((key) => counts.get(key) ?? 0),
	};
}

// Every email the provider accepted for the newsletter (issues, welcome, confirmation and test emails), by hour
// of today and yesterday.
export async function getHourlySends({ accountId, newsletterId, timeZone, now = new Date() }) {
	const todayKey = toDateKey(now, timeZone);
	const since = startOfDateKey(shiftDateKey(todayKey, -1), timeZone).getTime();
	const buckets = new Map();
	let sentAt = since;
	let id = "";
	for (;;) {
		const rows = await getAll(`SELECT _id, sentAt FROM messages WHERE accountId = ? AND newsletterId = ? AND (sentAt, _id) > (?, ?)
			ORDER BY sentAt, _id LIMIT ?`, [accountId, newsletterId, sentAt, id, PAGE_SIZE]);
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
