import Link from "next/link";
import { ArrowRight } from "lucide-react";
import ShellBannerPlan from "@/components/ShellBannerPlan";
import { Button } from "@/components/ui/button";
import { formatUsd } from "@/lib/format";
import { getRecommendedPlanId } from "@/lib/onboarding";
import { getPlan } from "@/lib/plans";

// Across the top of the dashboard while the account has no plan: everything but sending is open, so this says how
// to send.
export default function BannerPlan({ account }) {
	const plan = getPlan(getRecommendedPlanId(account));
	const hasList = Boolean(account.onboarding?.listSize) && account.onboarding.listSize !== "none";
	const price = `${formatUsd(plan.monthlyPrice)} a month`;
	const offer = hasList ? `${plan.name} fits your list, at ${price}` : `From ${price}`;

	return (
		<ShellBannerPlan>
			<div
				data-plan-bar
				className="sticky top-0 z-40 flex h-(--plan-bar-height) items-center justify-center gap-3 bg-foreground px-3 text-background sm:gap-4 sm:px-4"
			>
				<p className="min-w-0 truncate text-[13px] font-medium sm:text-sm">
					Pick a plan to start sending
					<span className="hidden font-normal text-background/60 md:inline">{` · ${offer}`}</span>
				</p>
				<Button asChild size="sm" variant="secondary">
					<Link href="/billing">
						See plans
						<ArrowRight data-icon="inline-end" className="transition-transform duration-150 group-hover/button:translate-x-0.5" />
					</Link>
				</Button>
			</div>
		</ShellBannerPlan>
	);
}
