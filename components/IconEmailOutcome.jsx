import { Ban, Clock, Mail, MailOpen, MailWarning, MailX, MousePointerClick, Send, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export const ICON_TONES = {
	muted: "bg-muted text-muted-foreground",
	green: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
	blue: "bg-sky-500/12 text-sky-600 dark:text-sky-400",
	amber: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
	red: "bg-red-500/10 text-red-600 dark:text-red-400",
};

// How each outcome of lib/email-outcome.js shows in a campaign's recipients.
export const EMAIL_OUTCOME_LOOKS = {
	complained: { verb: "Marked as spam", icon: ShieldAlert, tone: "red" },
	bounced: { verb: "Bounced", icon: MailX, tone: "red" },
	clicked: { verb: "Clicked", icon: MousePointerClick, tone: "green" },
	opened: { verb: "Opened", icon: MailOpen, tone: "blue" },
	delivered: { verb: "Received", icon: Mail, tone: "muted" },
	undelivered: { verb: "Not delivered", icon: MailWarning, tone: "amber" },
	sent: { verb: "Sent", icon: Send, tone: "muted" },
	waiting: { verb: "Sending", icon: Clock, tone: "muted" },
	unsent: { verb: "Not sent", icon: Ban, tone: "muted" },
};

export default function IconEmailOutcome({ outcome, className }) {
	const { icon: Icon, tone } = EMAIL_OUTCOME_LOOKS[outcome] ?? EMAIL_OUTCOME_LOOKS.sent;
	return (
		<span aria-hidden="true" className={cn("grid size-6 shrink-0 place-items-center rounded-full", ICON_TONES[tone], className)}>
			<Icon className="size-3" />
		</span>
	);
}
