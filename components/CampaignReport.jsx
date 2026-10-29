import Link from "next/link";
import { ChartColumn, Globe, Inbox, Languages, Link2, Pause, Play, Users } from "lucide-react";
import { pauseCampaign, resumeCampaign } from "@/app/(app)/campaigns/actions";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonCampaignAction from "@/components/ButtonCampaignAction";
import ButtonPreview from "@/components/ButtonPreview";
import ButtonCopy from "@/components/ButtonCopy";
import CardStat from "@/components/CardStat";
import ChartOpens from "@/components/ChartOpens";
import DialogSendMore from "@/components/DialogSendMore";
import GatePlan from "@/components/GatePlan";
import HeaderPage from "@/components/HeaderPage";
import ImageFavicon from "@/components/ImageFavicon";
import InputCampaignSlug from "@/components/InputCampaignSlug";
import ListLegend from "@/components/ListLegend";
import MenuReport from "@/components/MenuReport";
import SectionRecipients from "@/components/SectionRecipients";
import TableCampaignLinks from "@/components/TableCampaignLinks";
import TabsPage, { PanelTab } from "@/components/TabsPage";
import TextEmpty from "@/components/TextEmpty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isPlanLimitCode } from "@/lib/account-state";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getCampaignLinkLabels } from "@/lib/campaign-links";
import { FIRST_SEND } from "@/lib/first-send";
import { LIMITS, isSendingEnabled } from "@/lib/config";
import { formatCount, formatDate, formatNumber, formatRate, formatRateChange, formatWeekdayHour } from "@/lib/format";
import { rateTone } from "@/lib/health";
import { getLanguageName, getLanguageTag } from "@/lib/languages";
import { PROVIDER_DOMAINS, PROVIDER_LABELS } from "@/lib/providers";
import { TIMELINE_HOURS, findPeak, hoursToHalf, reachedOf } from "@/lib/report-stats";
import { SEND_SPREAD } from "@/lib/send-spread";
import { timeZoneLabel } from "@/lib/time-zone";

// A sent campaign: its numbers on top, the details in tabs under them, and the email as it went out. editions: its
// editions in other languages, whose links count with its own. languages: its results by the language each contact got.
// recipients: who it went to and what they did (components/SectionRecipients.jsx).
export default function CampaignReport({
	campaign,
	newsletter,
	editions = [],
	providers,
	languages = [],
	links = null,
	recipients = null,
	timeline = null,
	comparison = null,
	timeZone,
	remainingCount = 0,
	emailsLeft = 0,
	isBlocked = false,
}) {
	const { stats } = campaign;
	const id = campaign._id.toString();
	const hasPage = newsletter.archiveEnabled && Boolean(campaign.archiveSlug);
	const isOnArchive = hasPage && campaign.archiveListed !== false;
	const progress = stats.recipients ? Math.min(stats.sent / stats.recipients, 1) : 0;
	const content = {
		format: campaign.format,
		markdown: campaign.markdown ?? "",
		html: campaign.html ?? "",
		subject: campaign.subject,
		previewText: campaign.previewText,
		newsletter: { name: newsletter.name, postalAddress: newsletter.postalAddress, theme: newsletter.theme },
		language: getLanguageTag(campaign) ?? undefined,
	};
	const sender = { name: newsletter.name, fromName: newsletter.fromName, fromEmail: newsletter.fromEmail, imageUrl: newsletter.imageUrl };

	return (
		<>
			<HeaderPage
				title={campaign.subject || "Untitled"}
				backHref="/campaigns"
				icon={<AvatarNewsletter newsletter={newsletter} size={28} />}
				meta={<BadgeStatus status={campaign.status} />}
			>
				{campaign.status === "sent" && remainingCount > 0 && isSendingEnabled() && !isBlocked && (
					<GatePlan reason="send">
						<DialogSendMore
							campaignId={id}
							sentCount={stats.recipients}
							remainingCount={remainingCount}
							emailsLeft={emailsLeft}
							isCleanupEnabled={Boolean(newsletter.cleanup?.enabled)}
						/>
					</GatePlan>
				)}
				{campaign.status === "sending" && (
					<ButtonCampaignAction action={pauseCampaign} id={id}>
						<Pause data-icon="inline-start" />
						Pause
					</ButtonCampaignAction>
				)}
				{campaign.status === "paused" && (
					<GatePlan reason="send">
						<ButtonCampaignAction
							action={resumeCampaign}
							id={id}
							disabledReason={isBlocked ? "The account is blocked" : isSendingEnabled() ? null : "Sending is off"}
						>
							<Play data-icon="inline-start" />
							Resume
						</ButtonCampaignAction>
					</GatePlan>
				)}
				<ButtonPreview content={content} sender={sender} newsletterId={String(newsletter._id)} />
				<MenuReport
					id={id}
					pageUrl={isOnArchive ? getArchiveUrls(newsletter).post(campaign.archiveSlug) : null}
					isPinned={Boolean(campaign.archivePinned)}
				/>
			</HeaderPage>

			<div className="flex flex-col gap-6">
				{campaign.status === "paused" && campaign.pauseReason && (
					<TextPauseReason reason={campaign.pauseReason} code={campaign.pauseCode} />
				)}
				{["sending", "paused"].includes(campaign.status) && (
					<div className="flex flex-col gap-2 animate-enter">
						<div className="flex justify-between text-sm tabular-nums">
							<span className="text-muted-foreground">
								{formatNumber(stats.sent)} of {formatNumber(stats.recipients)}
							</span>
							<span>{Math.round(progress * 100)}%</span>
						</div>
						<div className="h-1.5 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-foreground transition-[width] duration-500"
								style={{ width: `${progress * 100}%` }}
							/>
						</div>
						{campaign.status === "sending" && campaign.firstSend?.held > 0 && !campaign.firstSend.checkedAt && (
							<p className="text-xs text-pretty text-muted-foreground">
								{formatNumber(campaign.firstSend.slice)} contacts who never got an email from you go first. The other{" "}
								{formatNumber(campaign.firstSend.held)} follow {FIRST_SEND.waitMinutes / 60} hours after them if their bounces and
								complaints stay low. If they don&apos;t, the rest waits for you to resume, and if they&apos;re far over, your account is
								blocked.
							</p>
						)}
						{campaign.status === "sending" && campaign.sendingUntil && (
							<p className="text-xs text-pretty text-muted-foreground">
								Your account is warming up, so this campaign goes out over {campaign.spreadHours ?? SEND_SPREAD.hours} hours: about{" "}
								{formatCount(hoursUntil(campaign.sendingUntil), "hour")} to go.
							</p>
						)}
					</div>
				)}

				<EmailResults
					campaign={campaign}
					newsletter={newsletter}
					editions={editions}
					stats={stats}
					comparison={comparison}
					timeline={timeline}
					timeZone={timeZone}
					links={links}
					providers={providers}
					languages={languages}
					recipients={recipients}
					page={hasPage && <RowPageUrl id={id} slug={campaign.archiveSlug} newsletter={newsletter} />}
				/>
			</div>
		</>
	);
}

// What the email did, always on top: delivery, opens and clicks against the newsletter's average, bounces and
// unsubscribes. Once it has gone out, its details in tabs under them: opens and clicks over time, its links, who it went
// to, its inboxes, its languages, and its page on the archive. Complaints show by inbox.
function EmailResults({ campaign, newsletter, editions, stats, comparison, timeline, timeZone, links, providers, languages, recipients, page }) {
	const reached = reachedOf(stats);
	// Bounced is hard bounces only: the rest are on their way, or an inbox refused them for now, like a full mailbox.
	const notDelivered = Math.max(0, stats.sent - stats.delivered - stats.bounced);
	const cards = [
		{
			label: "Delivered",
			value: formatRate(stats.delivered, stats.sent),
			detail: notDelivered > 0 ? `${formatNumber(stats.delivered)} · ${formatNumber(notDelivered)} not delivered` : formatNumber(stats.delivered),
		},
		{ label: "Opened", value: formatRate(stats.opened, reached), detail: formatNumber(stats.opened), change: toChange(comparison, "opened") },
		{ label: "Clicked", value: formatRate(stats.clicked, reached), detail: formatNumber(stats.clicked), change: toChange(comparison, "clicked") },
		{
			label: "Bounced",
			value: formatQuietRate(stats.bounced, stats.sent, 2),
			detail: formatNumber(stats.bounced),
			tone: rateTone(stats.bounced, stats.sent, LIMITS.pause.bounceRate),
		},
		{ label: "Unsubscribed", value: formatQuietRate(stats.unsubscribed, reached, 2), detail: formatNumber(stats.unsubscribed) },
	];
	const hasRecipients = recipients?.counts.all > 0;
	const hasLanguages = languages.length > 1;
	const tabs = [
		TABS.timeline,
		TABS.links,
		hasRecipients && TABS.recipients,
		TABS.inboxes,
		hasLanguages && TABS.languages,
		page && TABS.archive,
	].filter(Boolean);
	// Picking whom to show, or showing more of them, reloads the page on its recipients.
	const isOnRecipients = hasRecipients && (recipients.filter !== "all" || recipients.shown > recipients.step);

	return (
		<>
			<div style={{ "--stagger": 1 }} className="grid grid-cols-2 gap-3 animate-enter lg:grid-cols-5">
				{cards.map((card, index) => (
					<CardStat key={card.label} {...card} className={index === 0 ? "max-lg:col-span-2" : undefined} />
				))}
			</div>

			{(stats.sent > 0 || hasRecipients) && (
				<TabsPage tabs={tabs} defaultValue={isOnRecipients ? "recipients" : "timeline"} style={{ "--stagger": 2 }}>
					<PanelTab value="timeline">{timeline && reached > 0 && <CardOpens timeline={timeline} timeZone={timeZone} />}</PanelTab>
					<PanelTab value="links" className="flex flex-col gap-3">
						<p className="text-sm text-muted-foreground tabular-nums">
							{links?.clickers > 0 ? `${formatCount(links.clickers, "contact")} clicked a link` : "No clicks yet"}
						</p>
						{links?.links.length > 0 && (
							<TableCampaignLinks stats={links} labels={getCampaignLinkLabels({ campaign, newsletter, editions })} />
						)}
					</PanelTab>
					{hasRecipients && (
						<PanelTab value="recipients">
							<SectionRecipients campaignId={campaign._id.toString()} timeZone={timeZone} {...recipients} />
						</PanelTab>
					)}
					<PanelTab value="inboxes">
						{providers.length > 0 ? <TableProviders providers={providers} /> : <TextPanelEmpty>No emails sent yet</TextPanelEmpty>}
					</PanelTab>
					{hasLanguages && (
						<PanelTab value="languages">
							<TableLanguages languages={languages} />
						</PanelTab>
					)}
					{page && (
						<PanelTab value="archive" className="flex flex-col gap-3">
							<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
								<CardStat label="Page views" value={formatNumber(campaign.webViews ?? 0)} detail="Once per reader a day" />
								<CardStat label="Published" value={formatDate(campaign.sentAt ?? campaign.startedAt)} detail="On your public archive" />
							</div>
							{page}
						</PanelTab>
					)}
				</TabsPage>
			)}
		</>
	);
}

// Its address on the archive, which its owner can change, with a copy of it.
function RowPageUrl({ id, slug, newsletter }) {
	const urls = getArchiveUrls(newsletter);
	return (
		<div className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-xl bg-card px-4 shadow-border transition-colors duration-150 focus-within:bg-muted/40">
			<span className="text-sm text-muted-foreground">URL</span>
			<InputCampaignSlug campaignId={id} initialSlug={slug} urlBase={urls.absolutePost("")} isPublished />
			<ButtonCopy value={urls.absolutePost(slug)} label="Copy link" />
		</div>
	);
}

function TextPanelEmpty({ children }) {
	return <p className="rounded-xl bg-card px-4 py-10 text-center text-sm text-muted-foreground shadow-border">{children}</p>;
}

// Opens and clicks hour by hour after sending, with when most came and how fast half of the opens did.
function CardOpens({ timeline, timeZone }) {
	const peak = findPeak(timeline.hours);
	const half = hoursToHalf(timeline);
	const summary = [
		peak !== null && `Peak ${formatWeekdayHour(timeline.hours[peak].at, timeZone)}`,
		half !== null && `half of opens in ${half === 1 ? "the first hour" : formatSpan(half)}`,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<section className="flex flex-col gap-5 rounded-xl bg-card p-5 shadow-border sm:p-6">
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
				<div className="flex flex-col gap-1">
					<h2 className="text-sm font-medium text-muted-foreground">After sending</h2>
					{summary && <p className="text-sm text-pretty tabular-nums">{summary}</p>}
				</div>
				<ListLegend
					items={[{ swatch: "ghost", label: "Opens" }, { swatch: "bar", label: "Clicks" }, { label: timeZoneLabel(timeZone) }]}
				/>
			</div>
			<ChartOpens timeline={timeline} timeZone={timeZone} />
			{timeline.later.opens > 0 && (
				<p className="text-xs text-muted-foreground tabular-nums">
					{formatCount(timeline.later.opens, "open")} came after {formatSpan(TIMELINE_HOURS)}.
				</p>
			)}
		</section>
	);
}

// Results by inbox provider, each with its share of the send.
function TableProviders({ providers }) {
	const total = providers.reduce((sum, { sent }) => sum + sent, 0);

	return (
		<div className="overflow-hidden rounded-xl shadow-border">
			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead className="pl-4">Inbox</TableHead>
						<TableHead className="text-right">Share</TableHead>
						<TableHead className="text-right">Delivered</TableHead>
						<TableHead className="text-right max-sm:pr-4">Opened</TableHead>
						<TableHead className="hidden text-right sm:table-cell">Clicked</TableHead>
						<TableHead className="hidden text-right sm:table-cell">Bounced</TableHead>
						<TableHead className="hidden pr-4 text-right sm:table-cell">Complaints</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{providers.map((row) => (
						<TableRow key={row.provider} className="tabular-nums">
							<TableCell className="pl-4">
								<span className="flex items-center gap-2.5">
									{PROVIDER_DOMAINS[row.provider] ? (
										<ImageFavicon domain={PROVIDER_DOMAINS[row.provider]} size={16} />
									) : (
										<Globe className="size-4 shrink-0 text-muted-foreground" />
									)}
									<span className="flex min-w-0 flex-col">
										<span className="truncate font-medium">{PROVIDER_LABELS[row.provider] || PROVIDER_LABELS.other}</span>
										<span className="text-xs text-muted-foreground">{formatNumber(row.sent)} sent</span>
									</span>
								</span>
							</TableCell>
							<TableCell>
								<span className="flex items-center justify-end gap-2.5">
									<span aria-hidden="true" className="hidden h-1 w-10 overflow-hidden rounded-full bg-muted sm:block">
										<span className="block h-full rounded-full bg-foreground/70" style={{ width: `${(row.sent / total) * 100}%` }} />
									</span>
									<span className="w-9 text-right">{formatRate(row.sent, total, 0)}</span>
								</span>
							</TableCell>
							<TableCell className="text-right">{formatRate(row.delivered, row.sent) ?? <TextEmpty />}</TableCell>
							<TableCell className="text-right max-sm:pr-4">{formatRate(row.opened, row.delivered) ?? <TextEmpty />}</TableCell>
							<TableCell className="hidden text-right sm:table-cell">{formatRate(row.clicked, row.delivered) ?? <TextEmpty />}</TableCell>
							<TableCell className="hidden text-right sm:table-cell">{formatQuietRate(row.bounced, row.sent, 2) ?? <TextEmpty />}</TableCell>
							<TableCell className="hidden pr-4 text-right sm:table-cell">
								{formatQuietRate(row.complained, row.sent, 3) ?? <TextEmpty />}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

// Results by the language each contact got: the campaign's own or an edition's.
function TableLanguages({ languages }) {
	return (
		<div className="overflow-hidden rounded-xl shadow-border">
			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead className="pl-4">Language</TableHead>
						<TableHead className="text-right">Sent</TableHead>
						<TableHead className="text-right">Delivered</TableHead>
						<TableHead className="text-right max-sm:pr-4">Opened</TableHead>
						<TableHead className="hidden text-right sm:table-cell">Clicked</TableHead>
						<TableHead className="hidden text-right sm:table-cell">Bounced</TableHead>
						<TableHead className="hidden pr-4 text-right sm:table-cell">Complaints</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{languages.map((row) => (
						<TableRow key={row.language} className="tabular-nums">
							<TableCell className="pl-4 font-medium">{getLanguageName(row.language)}</TableCell>
							<TableCell className="text-right">{formatNumber(row.sent)}</TableCell>
							<TableCell className="text-right">{formatRate(row.delivered, row.sent) ?? <TextEmpty />}</TableCell>
							<TableCell className="text-right max-sm:pr-4">{formatRate(row.opened, row.delivered) ?? <TextEmpty />}</TableCell>
							<TableCell className="hidden text-right sm:table-cell">{formatRate(row.clicked, row.delivered) ?? <TextEmpty />}</TableCell>
							<TableCell className="hidden text-right sm:table-cell">{formatQuietRate(row.bounced, row.sent, 2) ?? <TextEmpty />}</TableCell>
							<TableCell className="hidden pr-4 text-right sm:table-cell">
								{formatQuietRate(row.complained, row.sent, 3) ?? <TextEmpty />}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function TextPauseReason({ reason, code }) {
	return (
		<p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-amber-500/10 px-4 py-3 text-sm animate-enter">
			<span className="text-pretty">Paused: {reason}</span>
			{isPlanLimitCode(code) && (
				<Link href="/billing" className="font-medium underline underline-offset-4">
					Upgrade
				</Link>
			)}
		</p>
	);
}

// "+4.2% vs avg" against the newsletter's earlier issues, with their average in the title; none while the send's own
// opens still come in.
function toChange(comparison, key) {
	if (!comparison?.isSettled) return null;
	const text = formatRateChange(comparison.delta[key]);
	if (!text) return null;
	return {
		text,
		note: "vs avg",
		isUp: text.startsWith("+"),
		title: `Your last ${formatCount(comparison.issues, "issue")} averaged ${(comparison.average[key] * 100).toFixed(1)}%`,
	};
}

// A rate with its decimals, or "0%" when nothing happened, so a quiet row stays quiet.
function formatQuietRate(part, total, digits) {
	return part === 0 && total ? "0%" : formatRate(part, total, digits);
}

// "12 h", "3 days"
function formatSpan(hours) {
	if (hours < 48) return `${hours} h`;
	return `${Math.round(hours / 24)} days`;
}

const TABS = {
	timeline: { value: "timeline", icon: ChartColumn, label: "Timeline" },
	links: { value: "links", icon: Link2, label: "Links" },
	recipients: { value: "recipients", icon: Users, label: "Recipients" },
	inboxes: { value: "inboxes", icon: Inbox, label: "Inboxes" },
	languages: { value: "languages", icon: Languages, label: "Languages" },
	archive: { value: "archive", icon: Globe, label: "Archive" },
};

// Whole hours left, at least one: the last batch's time is approximate.
function hoursUntil(date) {
	return Math.max(1, Math.ceil((new Date(date).getTime() - Date.now()) / 3_600_000));
}
