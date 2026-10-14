"use client";

import { useId, useState } from "react";
import { useFormStatus } from "react-dom";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// plans: display-ready values from lib/pricing.js, in plan order, with a price for each billing period.
// current: the account's plan, and its interval when Stripe bills it: then only that billing period is marked.
// action: with a plan Stripe bills, the server action that switches to the plan and period picked. Without it, the
// button subscribes through Checkout.
// children: under the button. The Subscribe link isn't a <Link>: a prefetch would open a Checkout session.
export default function SliderPricing({ plans, freeMonths, initialIndex = 0, initialPeriod = "month", current, action, children }) {
	const id = useId();
	const [index, setIndex] = useState(initialIndex);
	const [period, setPeriod] = useState(initialPeriod);
	const plan = plans[index];
	const price = plan.prices[period];
	const isYearly = period === "year";
	const lastIndex = plans.length - 1;
	const barWidth = (100 - lastIndex * BAR_GAP) / plans.length;
	const step = barWidth + BAR_GAP;
	const currentIndex = plans.findIndex((stop) => stop.id === current?.plan && (!current.interval || current.interval === period));
	const isCurrent = index === currentIndex;

	return (
		<div className="grid overflow-hidden rounded-3xl bg-card shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_2px_4px_rgb(0_0_0/0.03),0_24px_48px_-24px_rgb(0_0_0/0.16)] lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] dark:shadow-border">
			<div className="@container flex flex-col p-6 sm:p-9">
				{/* Side by side, the label and the switch take about 22rem: in a narrower column, on any screen, the switch goes first. */}
				<div className="flex flex-col-reverse items-start gap-8 @sm:flex-row @sm:flex-wrap @sm:items-center @sm:justify-between @sm:gap-4">
					<label htmlFor={`${id}-emails`} className="text-sm font-medium">
						Emails a month
					</label>
					<fieldset className="inline-flex items-center gap-1 rounded-xl bg-muted/70 p-1">
						<legend className="sr-only">Billing</legend>
						{PERIODS.map(({ value, label }) => (
							<label
								key={value}
								className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] duration-150 select-none hover:text-foreground has-checked:bg-background has-checked:text-foreground has-checked:shadow-border has-focus-visible:ring-3 has-focus-visible:ring-ring/50 dark:has-checked:bg-muted"
							>
								<input
									type="radio"
									name={`${id}-period`}
									value={value}
									checked={period === value}
									onChange={() => setPeriod(value)}
									className="sr-only"
								/>
								{label}
								{value === "year" && <span className="text-xs font-normal text-emerald-600 dark:text-emerald-400">{freeMonths} months free</span>}
							</label>
						))}
					</fieldset>
				</div>

				<p className="mt-3 font-display text-6xl leading-none font-[440] tracking-[-0.03em] tabular-nums @sm:mt-8 sm:text-7xl">{plan.emails}</p>
				<p className="mt-3 text-sm text-muted-foreground tabular-nums">
					For up to <span className="font-medium text-foreground">{plan.subscribers}</span> subscribers
				</p>

				<div className="mt-auto pt-8">
					<div aria-hidden="true" className="relative h-32 sm:h-36">
						{plans.map((stop, stopIndex) => (
							<button
								key={stop.id}
								type="button"
								tabIndex={-1}
								onClick={() => setIndex(stopIndex)}
								style={{ left: `${stopIndex * step}%`, width: `${barWidth}%`, height: `${Math.max(stop.bar, 0.28) * 100}%` }}
								className={cn(
									"absolute bottom-0 flex justify-center rounded-t-xl pt-2 text-xs font-semibold tabular-nums transition-colors duration-200",
									stopIndex === index ? "bg-foreground text-background" : "bg-foreground/[0.07] text-muted-foreground hover:bg-foreground/[0.12]"
								)}
							>
								{stop.prices[period].price}
								{stopIndex === currentIndex && (
									<span className="absolute bottom-full mb-1.5 text-[11px] font-medium text-foreground">Current</span>
								)}
							</button>
						))}
					</div>
					<input
						id={`${id}-emails`}
						type="range"
						min={0}
						max={lastIndex}
						step={1}
						value={index}
						onChange={(event) => setIndex(Number(event.target.value))}
						aria-valuetext={`${plan.emails} emails a month, the ${plan.name} plan${isCurrent ? ", your current plan" : ""}`}
						style={{ "--ratio": index / lastIndex, marginLeft: `calc(${barWidth / 2}% - 0.875rem)`, width: `calc(${100 - barWidth}% + 1.75rem)` }}
						className="slider-plans mt-3"
					/>
					<div className="relative mt-2 h-8">
						{plans.map((stop, stopIndex) => (
							<button
								key={stop.id}
								type="button"
								tabIndex={-1}
								aria-label={`${stop.emails} emails a month`}
								onClick={() => setIndex(stopIndex)}
								style={{ left: `${barWidth / 2 + stopIndex * step}%` }}
								className={cn(
									"absolute top-0 flex h-8 -translate-x-1/2 items-center rounded-md px-1.5 text-xs font-medium tabular-nums transition-colors duration-150",
									stopIndex === index ? "text-foreground" : "text-muted-foreground hover:text-foreground"
								)}
							>
								{stop.emailsShort}
							</button>
						))}
					</div>
				</div>
			</div>

			<div className="flex flex-col border-t border-border/70 bg-muted/40 p-6 sm:p-9 lg:border-t-0 lg:border-l">
				<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
					<p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
						{plan.name}
						{isCurrent && <span className="rounded-full bg-foreground px-2 py-0.5 text-[11px] whitespace-nowrap text-background">Current plan</span>}
					</p>
					<p className="rounded-full bg-foreground/[0.06] px-2.5 py-0.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
						{price.perThousand} per 1,000 emails
					</p>
				</div>
				<p className="mt-3 flex items-baseline gap-1.5 tabular-nums">
					<span className="text-5xl font-semibold tracking-tight">{price.price}</span>
					<span className="text-muted-foreground">/{isYearly ? "year" : "month"}</span>
				</p>
				<p className="mt-1.5 h-5 text-sm text-muted-foreground tabular-nums">{isYearly ? `${price.monthly} a month, billed yearly` : "Billed monthly"}</p>
				<div className="mt-6 border-t border-border/70 pt-6">
					<p className="text-xs font-medium text-muted-foreground">Every plan includes</p>
					<ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
						{INCLUDED.map((label) => (
							<li key={label} className="flex items-center gap-2">
								<Check className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2.5} />
								{label}
							</li>
						))}
					</ul>
				</div>
				<div className="mt-auto pt-8">
					{action ? (
						<form action={action}>
							<input type="hidden" name="plan" value={plan.id} />
							<input type="hidden" name="interval" value={period} />
							<ButtonSwitch isCurrent={isCurrent} />
						</form>
					) : (
						<Button asChild size="lg" className="h-11 w-full text-[15px]">
							<a href={price.href} rel="nofollow" data-goal="checkout_started" data-goal-plan={plan.id} data-goal-interval={period}>
								Subscribe
								<ArrowRight data-icon="inline-end" />
							</a>
						</Button>
					)}
					{children}
				</div>
			</div>
		</div>
	);
}

function ButtonSwitch({ isCurrent }) {
	const { pending } = useFormStatus();

	return (
		<Button
			type="submit"
			size="lg"
			variant={isCurrent ? "outline" : "default"}
			disabled={isCurrent || pending}
			className="h-11 w-full text-[15px]"
		>
			{isCurrent ? "Current plan" : "Switch"}
			{!isCurrent && (pending ? <Loader2 data-icon="inline-end" className="animate-spin" /> : <ArrowRight data-icon="inline-end" />)}
		</Button>
	);
}

// In % of the width. The range input spans from the first bar's center to the last one's, its thumb (1.75rem)
// overhanging by half at each end, so each stop lands in the middle of a bar.
const BAR_GAP = 4;

const PERIODS = [
	{ value: "month", label: "Monthly" },
	{ value: "year", label: "Yearly" },
];

const INCLUDED = [
	"Campaigns",
	"Scheduling",
	"Web archive",
	"Your own domain",
	"Signup forms",
	"Welcome emails",
	"Imports",
	"Stats",
	"AI agents and API",
	"Email support",
];
