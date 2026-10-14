import { Suspense } from "react";
import { Users } from "lucide-react";
import CardStat from "@/components/CardStat";
import HeaderPage from "@/components/HeaderPage";
import { SkeletonSesAccount } from "@/components/SkeletonOverview";
import StateEmpty from "@/components/StateEmpty";
import StripPostshibaClusters from "@/components/StripPostshibaClusters";
import StripSesAccount from "@/components/StripSesAccount";
import TableAccounts from "@/components/TableAccounts";
import { hasActiveSubscription, isBlocked } from "@/lib/account-state";
import { listAccountsForAdmin } from "@/lib/accounts";
import { requireAdmin } from "@/lib/auth";
import { isCloud } from "@/lib/config";
import { getEmailProvider } from "@/lib/email-provider";
import { formatNumber } from "@/lib/format";
import { isOnFreePlan } from "@/lib/plans";
import { serialize } from "@/lib/serialize";
import { cn } from "@/lib/utils";

export const metadata = { title: "Accounts" };

export default async function AdminPage() {
	await requireAdmin();
	const accounts = await listAccountsForAdmin();
	// Self-hosted, every account counts as paying.
	const withPlan = accounts.filter(hasActiveSubscription);
	const onFreePlan = withPlan.filter((account) => isOnFreePlan(account));
	const blocked = accounts.filter(isBlocked);
	const provider = getEmailProvider();

	return (
		<>
			<HeaderPage title="Accounts" />
			<div className="flex flex-col gap-8">
				<div className={cn("grid gap-3 sm:grid-cols-2 animate-enter", isCloud() ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
					<CardStat label="Accounts" value={formatNumber(accounts.length)} detail="Newest 200 below" />
					{isCloud() && (
						<CardStat
							label="Paying"
							value={formatNumber(withPlan.length - onFreePlan.length)}
							detail={onFreePlan.length > 0 && `${formatNumber(onFreePlan.length)} more on a free plan`}
						/>
					)}
					<CardStat
						label="Blocked"
						value={formatNumber(blocked.length)}
						detail={blocked.length > 0 && "Unblock from an account's menu"}
						tone={blocked.length > 0 ? "warn" : "default"}
					/>
					<CardStat label="Email provider" value={provider.name} detail={process.env.EMAIL_PROVIDER ? "Set by EMAIL_PROVIDER" : "The default"} />
				</div>

				<section style={{ "--stagger": 1 }} className="flex flex-col gap-3 animate-enter">
					<h2 className="text-sm font-medium text-muted-foreground">Accounts</h2>
					{accounts.length === 0 ? (
						<StateEmpty icon={Users} title="No accounts yet" />
					) : (
						<TableAccounts accounts={serialize(accounts)} />
					)}
				</section>

				<section style={{ "--stagger": 2 }} className="flex flex-col gap-3 animate-enter">
					<h2 className="text-sm font-medium text-muted-foreground">{provider.name}</h2>
					<Suspense fallback={<SkeletonSesAccount />}>{provider.id === "ses" ? <StripSesAccount /> : <StripPostshibaClusters />}</Suspense>
				</section>
			</div>
		</>
	);
}
