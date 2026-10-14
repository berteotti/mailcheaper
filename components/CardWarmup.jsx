import { Flame } from "lucide-react";
import ProgressWarmup from "@/components/ProgressWarmup";
import { formatDate } from "@/lib/format";
import { describeSpreadHours } from "@/lib/send-spread";

// On the overview while the account warms up: its first 30 days of sending, when every campaign goes out over hours.
export default function CardWarmup({ warmup }) {
	return (
		<div className="flex flex-col gap-3 rounded-2xl bg-card p-5 shadow-border sm:p-6">
			<div className="flex items-center justify-between gap-3">
				<h2 className="flex items-center gap-2 text-sm font-medium">
					<Flame className="size-4 text-muted-foreground" />
					{warmup.hasStarted ? "Your account is warming up" : "Your account warms up with its first campaign"}
				</h2>
				<span className="shrink-0 text-sm text-muted-foreground tabular-nums">
					{warmup.hasStarted ? `Day ${warmup.day} of ${warmup.days}` : `${warmup.days} days`}
				</span>
			</div>
			<ProgressWarmup warmup={warmup} />
			<p className="text-sm text-pretty text-muted-foreground">
				For your first {warmup.days} days of sending, campaigns go out over hours instead of all at once: {describeSpreadHours()}. Your
				next one goes out over {warmup.nextHours} hours. Mailbox providers like Gmail see your volume grow gradually, and a problem with a
				list shows up early.
				{warmup.hasStarted && ` Campaigns go out at full speed from ${formatDate(warmup.endsAt)}.`}
			</p>
		</div>
	);
}
