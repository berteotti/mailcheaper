import { formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

// isShared: the account has several newsletters, and these count all of them.
export default function CardUsage({ usage, isShared = false, now = new Date() }) {
	const resetsAt = usage.periodEnd && new Date(usage.periodEnd) > now ? `Resets ${formatDate(usage.periodEnd)}` : null;

	return (
		<div className="grid gap-px overflow-hidden rounded-xl bg-border/60 shadow-border sm:grid-cols-2">
			<MeterUsage label="Emails this month" used={usage.emailsSent} limit={usage.emailsLimit} detail={resetsAt} />
			<MeterUsage
				label="Subscribers"
				used={usage.subscribers}
				limit={usage.subscribersLimit}
				detail={isShared ? "All newsletters" : "Active contacts"}
			/>
		</div>
	);
}

function MeterUsage({ label, used, limit, detail }) {
	const ratio = limit > 0 ? used / limit : used > 0 ? 1 : 0;

	return (
		<div className="flex flex-col gap-3 bg-card p-4 sm:p-5">
			<div className="flex items-baseline justify-between gap-3">
				<span className="text-sm text-muted-foreground">{label}</span>
				{detail && <span className="text-xs text-muted-foreground">{detail}</span>}
			</div>
			<p className="flex items-baseline gap-1.5 tabular-nums">
				<span className="text-2xl font-semibold tracking-tight">{formatNumber(used)}</span>
				<span className="text-sm text-muted-foreground">of {formatNumber(limit)}</span>
			</p>
			<div
				role="meter"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={limit}
				aria-valuenow={Math.min(used, limit)}
				className="h-1.5 overflow-hidden rounded-full bg-muted"
			>
				<div
					className={cn("h-full rounded-full transition-[width] duration-500", meterTone(ratio))}
					style={{ width: `${Math.max(Math.min(ratio, 1) * 100, ratio > 0 ? 2 : 0)}%` }}
				/>
			</div>
		</div>
	);
}

function meterTone(ratio) {
	if (ratio >= 1) return "bg-red-500";
	if (ratio >= 0.9) return "bg-amber-500";
	return "bg-foreground/70";
}
