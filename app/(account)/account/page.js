import Link from "next/link";
import { ArrowUpRight, CreditCard, Lock, Send } from "lucide-react";
import { openBillingPortal } from "@/app/(account)/billing/actions";
import AvatarUser from "@/components/AvatarUser";
import BadgeStatus from "@/components/BadgeStatus";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { getPlanDetails } from "@/components/CardSubscription";
import DialogDeleteAccount from "@/components/DialogDeleteAccount";
import FormProfile from "@/components/FormProfile";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import { Button } from "@/components/ui/button";
import { DELETION_GRACE_DAYS, getDeletionBlockers } from "@/lib/account-deletion";
import { getAccountStatus, hasActiveSubscription } from "@/lib/account-state";
import { hasGoogleSignIn } from "@/lib/accounts";
import { requireAccount } from "@/lib/auth";
import { isCloud } from "@/lib/config";
import { formatDate } from "@/lib/format";
import { getAccountPlan } from "@/lib/plans";
import { MAX_NAME_LENGTH } from "@/lib/profile";

export const metadata = { title: "Account" };

// The whole account, apart from any newsletter: who signs in, billing, and deleting it.
export default async function AccountPage() {
	const { user, account } = await requireAccount();
	const [blockers, hasGoogle] = await Promise.all([getDeletionBlockers(account), hasGoogleSignIn(user.id)]);

	return (
		<LayoutNarrow>
			<HeaderPage title="Account" icon={<AvatarUser name={user.name} email={user.email} image={user.image} size={32} />} />
			<div className="flex flex-col gap-4">
				<FormProfile name={user.name ?? ""} image={user.image ?? ""} maxNameLength={MAX_NAME_LENGTH} />
				<CardSettings title="Email" stagger={1}>
					<RowSettings label="Address" hint={hasGoogle ? "You sign in with Google or with a code sent here." : "You sign in with a code sent here."}>
						<span className="flex h-9 items-center justify-between gap-3 rounded-lg bg-muted/60 px-2.5 text-sm">
							<span className="truncate">{user.email}</span>
							<Lock aria-label="Can't be changed" className="size-3.5 shrink-0 text-muted-foreground" />
						</span>
					</RowSettings>
				</CardSettings>
				{isCloud() && <CardBilling account={account} />}
				<CardDelete email={user.email} blockers={blockers} cancelAt={account.cancelAt} />
			</div>
		</LayoutNarrow>
	);
}

function CardBilling({ account }) {
	const isActive = hasActiveSubscription(account);
	const details = isActive ? getPlanDetails(account) : [];

	return (
		<CardSettings
			title="Billing"
			stagger={2}
			action={
				<Button asChild variant="outline" size="sm">
					<Link href="/billing">{isActive ? "Manage billing" : "Pick a plan"}</Link>
				</Button>
			}
		>
			<RowSettings label="Plan">
				<span className="flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-1">
					<span className="text-sm font-medium">{isActive ? (getAccountPlan(account)?.name ?? "Your plan") : "No plan"}</span>
					{(isActive || account.subscriptionStatus) && <BadgeStatus status={getAccountStatus(account)} />}
					{details.length > 0 && <span className="text-sm text-muted-foreground tabular-nums">{details.join(" · ")}</span>}
				</span>
			</RowSettings>
		</CardSettings>
	);
}

function CardDelete({ email, blockers, cancelAt }) {
	return (
		<CardSettings title="Delete account" stagger={3} className="mt-6">
			<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
				Your account stops at once. {DELETION_GRACE_DAYS} days later, its newsletters, contacts, campaigns and images are deleted
				for good. Signing in before then restores it.
			</p>
			{blockers?.hasPlan && (
				<RowBlocker
					icon={CreditCard}
					title={cancelAt ? `Your plan ends on ${formatDate(cancelAt)}` : "Cancel your plan first"}
					text={
						cancelAt
							? "You can delete your account once it has ended."
							: "Deleting your account doesn't stop Stripe from billing it. Cancel it in the billing portal."
					}
				>
					<form action={openBillingPortal}>
						<Button type="submit" variant="outline" size="sm">
							Billing portal
							<ArrowUpRight data-icon="inline-end" className="opacity-60" />
						</Button>
					</form>
				</RowBlocker>
			)}
			{blockers?.campaigns.length > 0 && (
				<RowBlocker icon={Send} title="Stop your campaigns first" text="Pause the ones sending, and cancel the scheduled ones.">
					<ul className="flex flex-col gap-1">
						{blockers.campaigns.map((campaign) => (
							<li key={String(campaign._id)}>
								<Link
									href={`/campaigns/${campaign._id}`}
									className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 hover:bg-muted"
								>
									<span className="truncate">{campaign.subject || "Untitled"}</span>
									<BadgeStatus status={campaign.status} />
								</Link>
							</li>
						))}
					</ul>
				</RowBlocker>
			)}
			<div className="flex justify-end rounded-b-xl bg-destructive/[0.03] px-4 py-3 dark:bg-destructive/[0.06]">
				<DialogDeleteAccount email={email} graceDays={DELETION_GRACE_DAYS} isDisabled={Boolean(blockers)} />
			</div>
		</CardSettings>
	);
}

function RowBlocker({ icon: Icon, title, text, children }) {
	return (
		<div className="flex gap-3 px-4 py-3">
			<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
				<Icon className="size-4" />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-2.5">
				<div className="flex flex-col gap-0.5">
					<p className="text-sm font-medium">{title}</p>
					<p className="text-sm text-pretty text-muted-foreground">{text}</p>
				</div>
				{children}
			</div>
		</div>
	);
}
