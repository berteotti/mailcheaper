import assert from "node:assert/strict";
import { test } from "node:test";
import { addMonths, getNextUsagePeriod, startFreePlanUsage, startUsagePeriod } from "../lib/usage-period.js";

const iso = (value) => new Date(value).toISOString();

test("months keep their day, or the month's last day when it's shorter", () => {
	assert.equal(iso(addMonths("2026-01-31T10:00:00Z", 1)), "2026-02-28T10:00:00.000Z");
	assert.equal(iso(addMonths("2026-01-31T10:00:00Z", 2)), "2026-03-31T10:00:00.000Z");
	assert.equal(iso(addMonths("2028-01-31T00:00:00Z", 1)), "2028-02-29T00:00:00.000Z");
	assert.equal(iso(addMonths("2026-11-15T08:30:00Z", 3)), "2027-02-15T08:30:00.000Z");
	assert.equal(iso(addMonths("2026-05-31T00:00:00Z", 0)), "2026-05-31T00:00:00.000Z");
});

test("a monthly plan's paid month is one usage period that only a payment renews", () => {
	const usage = startUsagePeriod({ start: "2026-10-12T05:00:00Z", end: "2026-11-12T05:00:00Z" });
	assert.equal(usage.emailsSent, 0);
	assert.equal(iso(usage.periodStart), "2026-10-12T05:00:00.000Z");
	assert.equal(iso(usage.periodEnd), "2026-11-12T05:00:00.000Z");
	assert.equal(getNextUsagePeriod(usage, new Date("2026-11-01T00:00:00Z")), null);
	assert.equal(getNextUsagePeriod(usage, new Date("2026-12-01T00:00:00Z")), null, "unpaid renewal: no new month");
});

test("a yearly plan resets every month, and never past the paid year", () => {
	const usage = startUsagePeriod({ start: "2026-01-31T12:00:00Z", end: "2027-01-31T12:00:00Z" });
	assert.equal(iso(usage.periodEnd), "2026-02-28T12:00:00.000Z");
	assert.equal(getNextUsagePeriod(usage, new Date("2026-02-20T00:00:00Z")), null, "still in the first month");

	const march = getNextUsagePeriod(usage, new Date("2026-03-05T00:00:00Z"));
	assert.equal(iso(march.periodStart), "2026-02-28T12:00:00.000Z");
	assert.equal(iso(march.periodEnd), "2026-03-31T12:00:00.000Z");

	const skipped = getNextUsagePeriod(usage, new Date("2026-06-15T00:00:00Z"));
	assert.equal(iso(skipped.periodStart), "2026-05-31T12:00:00.000Z", "a quiet stretch jumps to the current month");
	assert.equal(iso(skipped.periodEnd), "2026-06-30T12:00:00.000Z");

	const last = { ...usage, periodStart: new Date("2026-12-31T12:00:00Z"), periodEnd: new Date("2027-01-31T12:00:00Z") };
	assert.equal(getNextUsagePeriod(last, new Date("2027-02-10T00:00:00Z")), null, "the year ran out: wait for the renewal");
	assert.equal(getNextUsagePeriod(null), null);
});

test("a free plan's months start on the day it was given and go on without a payment", () => {
	const usage = startFreePlanUsage(new Date("2026-01-31T09:00:00Z"), new Date("2026-01-31T09:00:00Z"));
	assert.equal(usage.emailsSent, 0);
	assert.equal(usage.paidThrough, null, "nothing paid, so a subscription starts its own month");
	assert.equal(iso(usage.periodStart), "2026-01-31T09:00:00.000Z");
	assert.equal(iso(usage.periodEnd), "2026-02-28T09:00:00.000Z");
	assert.equal(getNextUsagePeriod(usage, new Date("2026-02-20T00:00:00Z")), null, "still in the first month");

	const later = getNextUsagePeriod(usage, new Date("2029-07-04T00:00:00Z"));
	assert.equal(iso(later.periodStart), "2029-06-30T09:00:00.000Z", "years later, still monthly");
	assert.equal(iso(later.periodEnd), "2029-07-31T09:00:00.000Z");

	const handedOver = startFreePlanUsage(new Date("2026-01-31T09:00:00Z"), new Date("2026-05-10T00:00:00Z"));
	assert.equal(iso(handedOver.anchor), "2026-01-31T09:00:00.000Z", "after a paid plan, the months still count from the grant");
	assert.equal(iso(handedOver.periodStart), "2026-04-30T09:00:00.000Z");
	assert.equal(iso(handedOver.periodEnd), "2026-05-31T09:00:00.000Z");
	assert.equal(handedOver.emailsSent, 0);
});
