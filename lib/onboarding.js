import "server-only";
import { getSharedDomain } from "@/lib/config";
import { accountIdOf, getOne } from "@/lib/db";
import { formatNumber } from "@/lib/format";
import { PLANS, getPlan } from "@/lib/plans";
import { isReservedSlug } from "@/lib/reserved-slugs";
import { slugify } from "@/lib/slug";

// The list a new account says it has, in the plans' subscriber steps: each size but the ends is the id of
// the plan it fits, which the paywall shows first.
export const LIST_SIZES = [
	{ id: "none", label: "Not yet" },
	...PLANS.map((plan, index) => ({
		id: plan.id,
		label: index === 0 ? `Under ${formatNumber(plan.subscribers)}` : `${formatNumber(PLANS[index - 1].subscribers)} to ${formatNumber(plan.subscribers)}`,
	})),
	{ id: "more", label: `Over ${formatNumber(PLANS.at(-1).subscribers)}` },
];

export const LIST_SOURCES = ["Substack", "beehiiv", "Mailchimp", "Kit", "Ghost", "Somewhere else"];

export function getRecommendedPlanId(account) {
	const size = account?.onboarding?.listSize;
	return size === "more" ? PLANS.at(-1).id : (getPlan(size)?.id ?? PLANS[0].id);
}

// With a shared domain, a new account's first stop is /welcome, which names its newsletter. Without one, a
// newsletter needs a from address on the account's own domain, so the dashboard opens and Add a newsletter asks for it.
export async function needsOnboarding(account) {
	if (!getSharedDomain()) return false;
	return !(await getOne("SELECT 1 AS found FROM newsletters WHERE accountId = ? LIMIT 1", [accountIdOf(account)]));
}

// The slug made from the name, numbered when another account's newsletter has it or MailCheap keeps it.
export async function findFreeSlug(name) {
	const base = slugify(name, 37) || "newsletter";
	for (let number = 1; number < 100; number++) {
		const slug = number === 1 ? base : `${base}-${number}`;
		// Slugs are unique across accounts, so this looks at every account's newsletters.
		if (!isReservedSlug(slug) && !(await getOne("SELECT 1 AS found FROM newsletters WHERE slug = ?", [slug]))) return slug;
	}
	return `${slugify(name, 30) || "newsletter"}-${Date.now().toString(36)}`;
}
