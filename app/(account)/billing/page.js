import { redirect } from "next/navigation";
import { CreditCard } from "lucide-react";
import { choosePlan, openBillingPortal } from "@/app/(account)/billing/actions";
import CardSubscription from "@/components/CardSubscription";
import CardUsage from "@/components/CardUsage";
import HeaderPage from "@/components/HeaderPage";
import ListPricing from "@/components/ListPricing";
import StateEmpty from "@/components/StateEmpty";
import { Button } from "@/components/ui/button";
import { hasActiveSubscription } from "@/lib/account-state";
import { requireAccount } from "@/lib/auth";
import { isCloud } from "@/lib/config";
import { getRecommendedPlanId } from "@/lib/onboarding";
import { isOwner } from "@/lib/organizations";
import { isOnFreePlan, readInterval } from "@/lib/plans";
import { getUsage } from "@/lib/usage";
import { cn } from "@/lib/utils";

export const metadata = { title: "Billing" };

// The plans as the pricing page shows them: without an active plan, starting on the one the account's list fits; with
// one, on the account's plan, marked. A free plan subscribes through Checkout like no plan; a paid plan's changes are
// confirmed on Stripe.
export default async function BillingPage({ searchParams }) {
	const { account, member } = await requireAccount();
	if (!isCloud()) return <PageBillingOff />;
	const params = await searchParams;
	const isActive = hasActiveSubscription(account);
	if (isActive && params.checkout === "pending") redirect("/");
	const interval = readInterval(params.interval ?? account.interval);
	const canPay = isOwner(member);
	const notice = getNotice({ account, isActive, canPay, ...params });

	if (!isActive) {
		return (
			<div className="relative isolate">
				{params.checkout === "pending" && <meta httpEquiv="refresh" content="3" />}
				<div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-24 -z-10 h-[30rem] bg-dots" />
				<div className="mx-auto mb-10 flex max-w-xl flex-col items-center text-center animate-enter">
					<h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Pick a plan</h1>
					<p className="mt-3 text-muted-foreground text-balance">
						Every plan has every feature. They differ in emails sent each month and subscribers.
					</p>
				</div>
				{notice && <TextNotice {...notice} className="mx-auto mb-8 max-w-xl text-center" />}
				<ListPricing initialPlanId={getRecommendedPlanId(account)} initialPeriod={interval} />
			</div>
		);
	}

	const usage = await getUsage(account);
	const isFree = isOnFreePlan(account);
	const current = isFree ? { plan: account.comp.plan } : { plan: account.plan, interval: readInterval(account.interval) };
	return (
		<>
			<HeaderPage title="Billing">
				{account.stripeCustomerId && canPay && (
					<form action={openBillingPortal}>
						<Button type="submit" variant="outline">
							<CreditCard data-icon="inline-start" />
							Manage billing
						</Button>
					</form>
				)}
			</HeaderPage>
			{notice && <TextNotice {...notice} className="mb-6" />}
			<div className="flex flex-col gap-8">
				<CardSubscription account={account} />
				<section style={{ "--stagger": 1 }} className="flex flex-col gap-3 animate-enter">
					<h2 className="text-sm font-medium text-muted-foreground">This month</h2>
					<CardUsage usage={usage} />
				</section>
				<section style={{ "--stagger": 2 }} className="flex flex-col gap-3 animate-enter">
					<div className="flex flex-col gap-1">
						<h2 className="text-sm font-medium text-muted-foreground">Change plan</h2>
						{isFree && <p className="text-sm text-pretty text-muted-foreground">A paid plan takes over from your free plan.</p>}
					</div>
					<ListPricing initialPlanId={current.plan} initialPeriod={interval} current={current} action={isFree ? undefined : choosePlan} />
				</section>
			</div>
		</>
	);
}

function PageBillingOff() {
	return (
		<>
			<HeaderPage title="Billing" />
			<StateEmpty icon={CreditCard} title="Billing is off on this server">
				<p className="max-w-sm text-sm text-pretty text-muted-foreground">
					Every account has every feature, without plan limits on emails or subscribers.
				</p>
			</StateEmpty>
		</>
	);
}

function getNotice({ account, isActive, canPay, checkout, error }) {
	if (error === "owner" || (!canPay && !checkout)) return { tone: "info", text: "Only the organization's owners change its plan. Ask one of them." };
	if (error === "stripe") return { tone: "error", text: "Stripe can't be reached right now. Try again in a minute." };
	if (error === "rate_limited") return { tone: "error", text: "You opened Stripe too many times in the last hour. Try again later." };
	if (checkout === "pending") return { tone: "info", text: "Payment received. Your plan turns on in a few seconds." };
	if (!isActive && (account.subscriptionStatus || account.comp?.plan)) {
		return { tone: "info", text: "Your plan isn't active. Your newsletter, contacts and campaigns are kept: pick a plan to send again." };
	}
	return null;
}

function TextNotice({ tone, text, className }) {
	return (
		<p
			role={tone === "error" ? "alert" : "status"}
			className={cn(
				"rounded-xl px-4 py-3 text-sm text-pretty animate-enter",
				tone === "error" ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground",
				className
			)}
		>
			{text}
		</p>
	);
}
