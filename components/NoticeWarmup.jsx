import ProgressWarmup from "@/components/ProgressWarmup";
import { describeSpreadHours } from "@/lib/send-spread";

// In the send and schedule dialogs while the account warms up (lib/send-spread.js).
export default function NoticeWarmup({ warmup }) {
	return (
		<div className="flex flex-col gap-2.5 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
			<p className="text-pretty">
				{warmup.hasStarted
					? `Your account is warming up (day ${warmup.day} of ${warmup.days}): this campaign goes out over ${warmup.nextHours} hours.`
					: `Your first campaign starts your account's warm-up. For ${warmup.days} days, campaigns go out over hours: ${describeSpreadHours()}.`}
			</p>
			{warmup.hasStarted && <ProgressWarmup warmup={warmup} className="bg-background" />}
		</div>
	);
}
