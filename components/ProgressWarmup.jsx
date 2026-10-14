import { cn } from "@/lib/utils";

// The account's warm-up as a bar: how much of its first 30 days of sending is behind it (lib/send-spread.js).
export default function ProgressWarmup({ warmup, className }) {
	return (
		<div
			role="progressbar"
			aria-label="Account warm-up"
			aria-valuemin={0}
			aria-valuemax={warmup.days}
			aria-valuenow={warmup.day}
			className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}
		>
			<div className="h-full rounded-full bg-foreground" style={{ width: `${Math.max(warmup.progress * 100, warmup.hasStarted ? 2 : 0)}%` }} />
		</div>
	);
}
