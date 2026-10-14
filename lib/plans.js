import { isCloud } from "./config.js";

// Prices in USD. Yearly costs 10 months. Stripe prices are found by lookup key
// (mailcheap_<plan>_<monthly|yearly>), and checkout refuses a price whose amount differs from this file.
export const YEARLY_MONTHS = 10;
export const INTERVALS = ["month", "year"];

export const PLANS = [
	{ id: "starter", name: "Starter", monthlyPrice: 19, emailsPerMonth: 20_000, subscribers: 5_000 },
	{ id: "growth", name: "Growth", monthlyPrice: 39, emailsPerMonth: 75_000, subscribers: 15_000 },
	{ id: "pro", name: "Pro", monthlyPrice: 79, emailsPerMonth: 200_000, subscribers: 40_000 },
	{ id: "scale", name: "Scale", monthlyPrice: 149, emailsPerMonth: 500_000, subscribers: 100_000 },
];

export const PLAN_IDS = PLANS.map(({ id }) => id);

const LOOKUP_KEY_PATTERN = /^mailcheap_([a-z]+)_(monthly|yearly)$/;

export function getPlan(id) {
	return PLANS.find((plan) => plan.id === id) ?? null;
}

export function readInterval(value) {
	return INTERVALS.includes(value) ? value : "month";
}

export function getPrice(plan, interval) {
	return plan.monthlyPrice * (interval === "year" ? YEARLY_MONTHS : 1);
}

// What a month costs per 1,000 emails of the plan's allowance; yearly plans spread their price over 12 months.
export function getPricePerThousand(plan, interval) {
	const monthlyCost = getPrice(plan, interval) / (interval === "year" ? 12 : 1);
	return monthlyCost / (plan.emailsPerMonth / 1000);
}

export function getLookupKey(planId, interval) {
	return `mailcheap_${planId}_${interval === "year" ? "yearly" : "monthly"}`;
}

export function parseLookupKey(lookupKey) {
	const match = LOOKUP_KEY_PATTERN.exec(String(lookupKey ?? ""));
	if (!match || !getPlan(match[1])) return null;
	return { plan: match[1], interval: match[2] === "yearly" ? "year" : "month" };
}

// Plan buttons on the public pages link here; signed-out visitors come back to it after signing in.
export const CHECKOUT_PATH = "/billing/checkout";

export function getCheckoutPath(planId, interval) {
	return `${CHECKOUT_PATH}?plan=${planId}&interval=${readInterval(interval)}`;
}

// Stripe keeps a subscription past_due while it retries the card; the account keeps working meanwhile.
const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

export function isPaidStatus(status) {
	return PAID_STATUSES.has(status);
}

// A free plan an admin gave (account.comp) runs from grantedAt until `until`, or for good without one.
export function hasActiveFreePlan(account, now = new Date()) {
	const comp = account?.comp;
	return Boolean(getPlan(comp?.plan) && comp.grantedAt) && (!comp.until || new Date(comp.until) > now);
}

// A plan Stripe bills is in charge while it lasts; a free plan still running takes over when it ends.
export function isOnFreePlan(account, now = new Date()) {
	return !isPaidStatus(account?.subscriptionStatus) && hasActiveFreePlan(account, now);
}

// The free plan while the account is on it, else the plan it pays for, or paid for last.
export function getAccountPlan(account) {
	return getPlan(isOnFreePlan(account) ? account.comp.plan : account?.plan);
}

// An admin's numbers win over the plan's. A self-hosted server has no plans, so nothing is limited: null.
export function getAccountLimits(account) {
	if (!isCloud()) return null;
	const plan = getAccountPlan(account);
	return {
		emails: account?.limitOverrides?.emailsPerMonth ?? plan?.emailsPerMonth ?? 0,
		subscribers: account?.limitOverrides?.subscribers ?? plan?.subscribers ?? 0,
	};
}
