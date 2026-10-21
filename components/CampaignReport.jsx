import Link from "next/link";
import { Copy, ExternalLink, Globe, Pause, Pin, PinOff, Play } from "lucide-react";
import {
	duplicateCampaign,
	pauseCampaign,
	resumeCampaign,
	toggleArchivePin,
} from "@/app/(app)/campaigns/actions";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonCampaignAction from "@/components/ButtonCampaignAction";
import ButtonCopy from "@/components/ButtonCopy";
import GatePlan from "@/components/GatePlan";
import CardStat from "@/components/CardStat";
import DialogSendMore from "@/components/DialogSendMore";
import HeaderPage from "@/components/HeaderPage";
import ImageFavicon from "@/components/ImageFavicon";
import InputCampaignSlug from "@/components/InputCampaignSlug";
import PreviewEmail from "@/components/PreviewEmail";
import TextEmpty from "@/components/TextEmpty";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { isPlanLimitCode } from "@/lib/account-state";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { FIRST_SEND } from "@/lib/first-send";
import { LIMITS, isSendingEnabled } from "@/lib/config";
import { formatCount, formatDate, formatNumber, formatRate } from "@/lib/format";
import { rateTone } from "@/lib/health";
import { getLanguageName } from "@/lib/languages";
import { PROVIDER_DOMAINS, PROVIDER_LABELS } from "@/lib/providers";
import { SEND_SPREAD } from "@/lib/send-spread";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail, withResponsiveImages } from "@/lib/render-email";

export default function CampaignReport({
	campaign,
	newsletter,
	providers,
	languages = [],
	remainingCount = 0,
	emailsLeft = 0,
	isBlocked = false,
}) {
	const { stats } = campaign;
	const id = campaign._id.toString();
	const isOnArchive = newsletter.archiveEnabled && Boolean(campaign.archiveSlug) && campaign.archiveListed !== false;
	const reached = stats.delivered || stats.sent;
	const progress = stats.recipients ? Math.min(stats.sent / stats.recipients, 1) : 0;
	const { html } = renderEmail({
		format: campaign.format,
		markdown: campaign.markdown,
		html: campaign.html,
		subject: campaign.subject,
		previewText: campaign.previewText,
		newsletter,
	});

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
				{isOnArchive && (
					<>
						<Button variant="outline" asChild>
							<a href={getArchiveUrls(newsletter).post(campaign.archiveSlug)} target="_blank" rel="noreferrer">
								<ExternalLink data-icon="inline-start" />
								View page
							</a>
						</Button>
						<ButtonCampaignAction action={toggleArchivePin} id={id}>
							{campaign.archivePinned ? <PinOff data-icon="inline-start" /> : <Pin data-icon="inline-start" />}
							{campaign.archivePinned ? "Unpin" : "Pin"}
						</ButtonCampaignAction>
					</>
				)}
				<ButtonCampaignAction action={duplicateCampaign} id={id}>
					<Copy data-icon="inline-start" />
					Duplicate
				</ButtonCampaignAction>
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

				<div
					style={{ "--stagger": 1 }}
					className="grid grid-cols-2 gap-3 animate-enter sm:grid-cols-3 lg:grid-cols-6"
				>
					<CardStat
						label="Delivered"
						value={formatRate(stats.delivered, stats.sent)}
						detail={formatNumber(stats.delivered)}
					/>
					<CardStat
						label="Opened"
						value={formatRate(stats.opened, reached)}
						detail={formatNumber(stats.opened)}
					/>
					<CardStat
						label="Clicked"
						value={formatRate(stats.clicked, reached)}
						detail={formatNumber(stats.clicked)}
					/>
					<CardStat
						label="Bounced"
						value={formatRate(stats.bounced, stats.sent, 2)}
						detail={formatNumber(stats.bounced)}
						tone={rateTone(stats.bounced, stats.sent, LIMITS.pause.bounceRate)}
					/>
					<CardStat
						label="Complaints"
						value={formatRate(stats.complained, stats.sent, 3)}
						detail={formatNumber(stats.complained)}
						tone={rateTone(stats.complained, stats.sent, LIMITS.pause.complaintRate)}
					/>
					<CardStat
						label="Unsubscribed"
						value={formatRate(stats.unsubscribed, reached, 2)}
						detail={formatNumber(stats.unsubscribed)}
					/>
				</div>

				{providers.length > 0 && (
					<TableResults
						label="Inbox"
						rows={providers.map((row) => ({
							...row,
							key: row.provider,
							name: (
								<span className="flex items-center gap-2.5">
									{PROVIDER_DOMAINS[row.provider] ? (
										<ImageFavicon domain={PROVIDER_DOMAINS[row.provider]} size={16} />
									) : (
										<Globe className="size-4 text-muted-foreground" />
									)}
									{PROVIDER_LABELS[row.provider] || PROVIDER_LABELS.other}
								</span>
							),
						}))}
					/>
				)}

				{languages.length > 1 && (
					<TableResults
						label="Language"
						rows={languages.map((row) => ({ ...row, key: row.language, name: getLanguageName(row.language) }))}
					/>
				)}

				{newsletter.archiveEnabled && campaign.archiveSlug && (
					<div
						style={{ "--stagger": 3 }}
						className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-xl bg-card px-4 shadow-border transition-colors duration-150 animate-enter focus-within:bg-muted/40"
					>
						<span className="text-sm text-muted-foreground">URL</span>
						<InputCampaignSlug
							campaignId={id}
							initialSlug={campaign.archiveSlug}
							urlBase={getArchiveUrls(newsletter).absolutePost("")}
							isPublished
						/>
						<ButtonCopy value={getArchiveUrls(newsletter).absolutePost(campaign.archiveSlug)} label="Copy link" />
					</div>
				)}

				<div style={{ "--stagger": 4 }} className="animate-enter">
					<PreviewEmail
						fit="content"
						sender={newsletter}
						subject={campaign.subject}
						previewText={campaign.previewText}
						html={withResponsiveImages(html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#"))}
						// Rendered next to PreviewEmail's own children, so dev React asks for a key.
						toolbar={
							<span key="toolbar" className="truncate text-xs text-muted-foreground">
								{newsletter.name}
								{campaign.sentAt && ` · ${formatDate(campaign.sentAt)}`}
							</span>
						}
					/>
				</div>
			</div>
		</>
	);
}

// Sends and their rates, a row per inbox provider or per language.
function TableResults({ label, rows }) {
	return (
		<div style={{ "--stagger": 2 }} className="overflow-hidden rounded-xl shadow-border animate-enter">
			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead className="pl-4">{label}</TableHead>
						<TableHead className="text-right">Sent</TableHead>
						<TableHead className="text-right">Delivered</TableHead>
						<TableHead className="text-right">Opened</TableHead>
						<TableHead className="hidden text-right sm:table-cell">Clicked</TableHead>
						<TableHead className="hidden text-right sm:table-cell">Bounced</TableHead>
						<TableHead className="pr-4 text-right">Complaints</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.key} className="tabular-nums">
							<TableCell className="pl-4 font-medium">{row.name}</TableCell>
							<TableCell className="text-right">{formatNumber(row.sent)}</TableCell>
							<TableCell className="text-right">{formatRate(row.delivered, row.sent) ?? <TextEmpty />}</TableCell>
							<TableCell className="text-right">{formatRate(row.opened, row.delivered) ?? <TextEmpty />}</TableCell>
							<TableCell className="hidden text-right sm:table-cell">
								{formatRate(row.clicked, row.delivered) ?? <TextEmpty />}
							</TableCell>
							<TableCell className="hidden text-right sm:table-cell">
								{formatRate(row.bounced, row.sent, 2) ?? <TextEmpty />}
							</TableCell>
							<TableCell className="pr-4 text-right">
								{formatRate(row.complained, row.sent, 3) ?? <TextEmpty />}
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

// Whole hours left, at least one: the last batch's time is approximate.
function hoursUntil(date) {
	return Math.max(1, Math.ceil((new Date(date).getTime() - Date.now()) / 3_600_000));
}
