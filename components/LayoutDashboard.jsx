import { Suspense } from "react";
import BannerBlocked from "@/components/BannerBlocked";
import BannerPlan from "@/components/BannerPlan";
import LogoWordmark from "@/components/LogoWordmark";
import MenuUser from "@/components/MenuUser";
import NavLinks from "@/components/NavLinks";
import NavMobile from "@/components/NavMobile";
import NavNewsletter from "@/components/NavNewsletter";
import PanelGetStarted from "@/components/PanelGetStarted";
import ProviderPaywall from "@/components/ProviderPaywall";
import { Skeleton } from "@/components/ui/skeleton";
import { SiteAnalytics } from "@/components/SiteExtensions";
import { getSendingStatus, hasActiveSubscription, isBlocked } from "@/lib/account-state";
import { isCloud } from "@/lib/config";
import { isGetStartedOpen } from "@/lib/get-started";
import { getRecommendedPlanId } from "@/lib/onboarding";
import { getPricing } from "@/lib/pricing";

export default function LayoutDashboard({ user, account, isAdmin, children }) {
	const hasPlan = hasActiveSubscription(account);
	const menu = <MenuUser name={user.name} email={user.email} image={user.image} status={getSendingStatus(account)} hasBilling={isCloud()} />;

	return (
		<ProviderPaywall hasPlan={hasPlan} pricing={getPricing(getRecommendedPlanId(account))}>
			{isBlocked(account) ? <BannerBlocked account={account} /> : isCloud() && !hasPlan && <BannerPlan account={account} />}
			<div className="flex min-h-[calc(100dvh-var(--plan-bar-height))] flex-col md:flex-row">
				<aside className="sticky top-(--plan-bar-height) hidden h-[calc(100dvh-var(--plan-bar-height))] w-60 shrink-0 flex-col border-r border-border/60 px-3 py-4 md:flex">
					<LogoWordmark href="/" className="mb-4 h-9 px-2.5" />
					<div className="mb-5">
						<Suspense fallback={<Skeleton className="h-11 rounded-xl" />}>
							<NavNewsletter />
						</Suspense>
					</div>
					<NavLinks isAdmin={isAdmin} />
					<div className="mt-auto pt-4">{menu}</div>
				</aside>
				<NavMobile
					isAdmin={isAdmin}
					switcher={
						<Suspense fallback={<Skeleton className="h-8 w-32 rounded-lg" />}>
							<NavNewsletter isCompact />
						</Suspense>
					}
					footer={menu}
				/>
				<main className="min-w-0 flex-1">
					<div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-10 md:py-10">{children}</div>
				</main>
			</div>
			{isGetStartedOpen(account) && (
				<Suspense fallback={null}>
					<PanelGetStarted account={account} />
				</Suspense>
			)}
			{SiteAnalytics && <SiteAnalytics />}
		</ProviderPaywall>
	);
}
