import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";

// Shown near or over a plan limit: campaign sends stop at the limit, signups don't.
export default function BannerUsage({ usage }) {
	const message = getMessage(usage);
	if (!message) return null;

	return (
		<div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-500/10 px-4 py-3 text-sm animate-enter">
			<p className="flex min-w-0 items-center gap-2.5">
				<TriangleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
				<span className="text-pretty">{message}</span>
			</p>
			<Button asChild size="sm">
				<Link href="/billing">Upgrade</Link>
			</Button>
		</div>
	);
}

function getMessage({ emailsSent, emailsLimit, subscribers, subscribersLimit }) {
	if (emailsLimit === null) return null;
	if (subscribers > subscribersLimit) {
		return `You have ${formatNumber(subscribers)} subscribers and your plan allows ${formatNumber(subscribersLimit)}. Campaigns can't go out until you upgrade.`;
	}
	if (emailsSent >= emailsLimit) {
		return "This month's emails are used up. Campaigns can't go out until you upgrade or the month resets.";
	}
	if (emailsSent >= emailsLimit * 0.9) {
		return `You've sent ${formatNumber(emailsSent)} of your ${formatNumber(emailsLimit)} emails this month.`;
	}
	return null;
}
