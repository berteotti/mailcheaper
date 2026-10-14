import { cn } from "@/lib/utils";

export default function BadgeStatus({ status, label, className }) {
	const key = String(status ?? "").toLowerCase();

	return (
		<span
			className={cn(
				"inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-xs font-medium whitespace-nowrap text-foreground/80 shadow-border",
				className
			)}
		>
			<span className={cn("size-1.5 rounded-full", DOT_TONES[STATUS_TONES[key] || "gray"])} />
			{label || statusLabel(key)}
		</span>
	);
}

function statusLabel(status) {
	const text = status.replaceAll("_", " ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

const DOT_TONES = {
	green: "bg-emerald-500",
	amber: "bg-amber-500",
	red: "bg-red-500",
	blue: "bg-sky-500",
	gray: "bg-zinc-400 dark:bg-zinc-500",
};

const STATUS_TONES = {
	active: "green",
	trialing: "green",
	past_due: "amber",
	incomplete: "amber",
	unpaid: "red",
	sent: "green",
	delivered: "green",
	success: "green",
	verified: "green",
	healthy: "green",
	scheduled: "blue",
	sending: "blue",
	queued: "blue",
	paused: "amber",
	pending: "amber",
	temporary_failure: "amber",
	probation: "amber",
	sandbox: "amber",
	bounced: "red",
	complained: "red",
	failed: "red",
	shutdown: "red",
	deleting: "red",
	blocked: "red",
};
