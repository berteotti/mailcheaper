import crypto from "node:crypto";
import Link from "next/link";
import { Globe } from "lucide-react";
import AvatarContact from "@/components/AvatarContact";
import IconEmailOutcome, { EMAIL_OUTCOME_LOOKS } from "@/components/IconEmailOutcome";
import ImageFavicon from "@/components/ImageFavicon";
import { Button } from "@/components/ui/button";
import { RECIPIENT_FILTERS } from "@/lib/campaign-recipient-rules";
import { formatDateTime, formatNumber } from "@/lib/format";
import { formatLinkUrl } from "@/lib/link-stats";
import { cn } from "@/lib/utils";

const FILTER_LABELS = {
	all: "Everyone",
	opened: "Opened",
	clicked: "Clicked",
	unopened: "Didn't open",
	undelivered: "Not delivered",
	bounced: "Bounced",
	unsubscribed: "Unsubscribed",
};
// The others only show once someone is in them.
const ALWAYS_SHOWN = new Set(["all", "opened", "clicked", "unopened"]);
const OUTCOME_AT = { complained: "complainedAt", bounced: "bouncedAt", clicked: "clickedAt", opened: "openedAt", delivered: "deliveredAt" };

// Who a sent campaign went to and what each did with it (lib/campaign-recipients.js), a filter at a time, kept in the
// page's address like Show more: ?recipients= and ?shown=.
export default function SectionRecipients({ campaignId, filter, counts, recipients, hasMore, shown, step, timeZone }) {
	const filters = RECIPIENT_FILTERS.filter((key) => ALWAYS_SHOWN.has(key) || counts[key] > 0 || key === filter);

	function hrefFor(key, count = step) {
		const params = new URLSearchParams({ ...(key !== "all" && { recipients: key }), ...(count > step && { shown: String(count) }) });
		return params.size ? `/campaigns/${campaignId}?${params}` : `/campaigns/${campaignId}`;
	}

	return (
		<section id="recipients" aria-label="Recipients" className="flex flex-col gap-2">
			<div className="overflow-hidden rounded-xl bg-card shadow-border">
				<div className="p-4 sm:px-5">
					<nav aria-label="Recipients to show" className="-m-1 flex gap-1.5 overflow-x-auto p-1 [scrollbar-width:none]">
						{filters.map((key) => (
							<Link
								key={key}
								href={hrefFor(key)}
								scroll={false}
								aria-current={key === filter ? "page" : undefined}
								className={cn(
									"inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm whitespace-nowrap shadow-border outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50",
									key === filter ? "bg-muted/60 font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
								)}
							>
								{FILTER_LABELS[key]}
								<span className="text-xs font-normal text-muted-foreground tabular-nums">{formatNumber(counts[key])}</span>
							</Link>
						))}
					</nav>
				</div>
				{recipients.length > 0 ? (
					<ul className="divide-y divide-border/60 border-t border-border/60">
						{recipients.map((recipient) => (
							<RowRecipient key={recipient.contactId} recipient={recipient} timeZone={timeZone} />
						))}
					</ul>
				) : (
					<p className="border-t border-border/60 px-4 py-8 text-center text-sm text-muted-foreground">No one yet</p>
				)}
				{hasMore && (
					<div className="border-t border-border/60 p-2">
						<Button asChild variant="ghost" className="w-full text-muted-foreground">
							<Link href={hrefFor(filter, shown + step)} scroll={false}>
								Show more
							</Link>
						</Button>
					</div>
				)}
			</div>
			<p className="px-1 text-xs text-pretty text-muted-foreground">
				Opens are an estimate: Gmail and some other inboxes load an email&apos;s images as it arrives.
			</p>
		</section>
	);
}

// A person, what the email came to and when, the links they clicked, and whether they unsubscribed through it.
function RowRecipient({ recipient, timeZone }) {
	const { verb } = EMAIL_OUTCOME_LOOKS[recipient.outcome];
	const at = recipient[OUTCOME_AT[recipient.outcome]] ?? recipient.sentAt;
	const name = [recipient.firstName, recipient.lastName].filter(Boolean).join(" ");
	const links = recipient.clickedLinks.filter((url) => /^https?:\/\//i.test(url));

	return (
		<li className="flex items-start gap-3 px-4 py-3 sm:px-5">
			<AvatarContact
				email={recipient.email}
				name={recipient.firstName ?? recipient.lastName}
				colorHash={crypto.createHash("sha256").update(recipient.email.trim().toLowerCase()).digest("hex")}
				size={28}
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-sm font-medium">{name || recipient.email}</span>
				{name && <span className="truncate text-xs text-muted-foreground">{recipient.email}</span>}
				{links.length > 0 && (
					<ul className="mt-1 flex flex-col gap-1">
						{links.map((url) => (
							<li key={url} className="flex min-w-0">
								<a
									href={url}
									target="_blank"
									rel="noopener noreferrer nofollow"
									title={url}
									className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
								>
									{hostOf(url) ? <ImageFavicon domain={hostOf(url)} size={14} /> : <Globe className="size-3.5 shrink-0" />}
									<span className="truncate">{formatLinkUrl(url)}</span>
								</a>
							</li>
						))}
					</ul>
				)}
			</div>
			<div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
				<span className="flex items-center gap-2 text-sm">
					<IconEmailOutcome outcome={recipient.outcome} className="size-5" />
					{verb}
				</span>
				{at && (
					<time
						dateTime={new Date(at).toISOString()}
						title={formatDateTime(at, timeZone)}
						className="text-xs text-muted-foreground tabular-nums"
					>
						{formatMoment(at, timeZone)}
					</time>
				)}
				{recipient.unsubscribedAt && <span className="text-xs font-medium text-red-600 dark:text-red-400">Unsubscribed</span>}
			</div>
		</li>
	);
}

// "Oct 7, 4:12 PM"
function formatMoment(value, timeZone) {
	return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
}

function hostOf(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}
