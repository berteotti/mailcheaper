// Plans allow a number of emails per month, so yearly plans count by month too: the paid period is cut
// into months from its first day, each with the full allowance. No month starts past what's paid. A free plan
// pays nothing (no paidThrough): its months run on from the day it was given, and its end date stops access instead.
const AVERAGE_MONTH_MS = (365.25 / 12) * 24 * 60 * 60 * 1000;

function toDate(value) {
	return value ? new Date(value) : null;
}

function earlier(left, right) {
	return left < right ? left : right;
}

// Same day of the month, or the month's last day when it's shorter: Jan 31 + 1 month is Feb 28.
export function addMonths(date, months) {
	const start = new Date(date);
	const target = new Date(start);
	target.setUTCDate(1);
	target.setUTCMonth(start.getUTCMonth() + months);
	const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
	target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
	return target;
}

function isLongerThanAMonth(start, end) {
	return Math.round((end - start) / AVERAGE_MONTH_MS) > 1;
}

function getFirstPeriodEnd(anchor, paidThrough) {
	if (!paidThrough) return addMonths(anchor, 1);
	return isLongerThanAMonth(anchor, paidThrough) ? earlier(addMonths(anchor, 1), paidThrough) : paidThrough;
}

// The usage fields for a period that was just paid, [start, end), or a free plan's first month without an end.
export function startUsagePeriod({ start, end = null }) {
	const anchor = new Date(start);
	const paidThrough = end ? new Date(end) : null;
	return { emailsSent: 0, anchor, paidThrough, periodStart: anchor, periodEnd: getFirstPeriodEnd(anchor, paidThrough) };
}

// The month of a free plan that now falls in, counted from the day it was given.
export function startFreePlanUsage(grantedAt, now = new Date()) {
	const usage = startUsagePeriod({ start: grantedAt });
	return { ...usage, ...getNextUsagePeriod(usage, now) };
}

// The month now falls in, once the current one is over and while the period is paid; otherwise null.
export function getNextUsagePeriod(usage, now = new Date()) {
	const anchor = toDate(usage?.anchor);
	const paidThrough = toDate(usage?.paidThrough);
	const periodEnd = toDate(usage?.periodEnd);
	if (!anchor || !periodEnd || now < periodEnd) return null;
	if (paidThrough && (periodEnd >= paidThrough || now >= paidThrough)) return null;

	let index = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth();
	while (index > 0 && addMonths(anchor, index) > now) index -= 1;
	while (addMonths(anchor, index + 1) <= now) index += 1;
	const end = addMonths(anchor, index + 1);
	return { periodStart: addMonths(anchor, index), periodEnd: paidThrough ? earlier(end, paidThrough) : end };
}
