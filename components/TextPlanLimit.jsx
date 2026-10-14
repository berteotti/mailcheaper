import Link from "next/link";
import { formatCount } from "@/lib/format";

// In the send dialogs, when the chosen number of contacts is over what the plan has left this month.
export default function TextPlanLimit({ emailsLeft }) {
	return (
		<p className="rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-pretty tabular-nums">
			Your plan has {formatCount(emailsLeft, "email")} left this month. Send to fewer contacts or{" "}
			<Link href="/billing" className="font-medium underline underline-offset-4">
				upgrade
			</Link>
			.
		</p>
	);
}
