import { formatCompact, formatNumber, formatUsd, formatUsdCents } from "./format.js";
import { INTERVALS, PLANS, YEARLY_MONTHS, getCheckoutPath, getPrice, getPricePerThousand } from "./plans.js";

// What SliderPricing shows, on the pricing pages, the billing page and the paywall: the plans ready to
// display, with a price for each billing period, starting on the given plan.
export function getPricing(initialPlanId = PLANS[0].id) {
	const largest = PLANS.at(-1).emailsPerMonth;
	const plans = PLANS.map((plan) => ({
		id: plan.id,
		name: plan.name,
		emails: formatNumber(plan.emailsPerMonth),
		emailsShort: formatCompact(plan.emailsPerMonth),
		subscribers: formatNumber(plan.subscribers),
		// A square root keeps the smallest plan's bar tall enough to read.
		bar: Math.sqrt(plan.emailsPerMonth / largest),
		prices: Object.fromEntries(
			INTERVALS.map((interval) => [
				interval,
				{
					price: formatUsd(getPrice(plan, interval)),
					monthly: formatUsdCents(getPrice(plan, interval) / 12),
					perThousand: formatUsdCents(getPricePerThousand(plan, interval)),
					href: getCheckoutPath(plan.id, interval),
				},
			])
		),
	}));
	return { plans, freeMonths: 12 - YEARLY_MONTHS, initialIndex: Math.max(0, PLANS.findIndex(({ id }) => id === initialPlanId)) };
}
