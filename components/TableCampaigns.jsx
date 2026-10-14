import Link from "next/link";
import BadgeStatus from "@/components/BadgeStatus";
import MenuCampaign from "@/components/MenuCampaign";
import TextEmpty from "@/components/TextEmpty";
import ThumbnailCampaign from "@/components/ThumbnailCampaign";
import TimeLocal from "@/components/TimeLocal";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { formatDate, formatNumber, formatRate, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

const SCHEDULED_FORMAT = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

// One newsletter's campaigns: their thumbnails fall back to its logo.
export default function TableCampaigns({ campaigns, newsletter, hasActions = false, pageUrls = {} }) {
	return (
		<div className="overflow-hidden rounded-xl shadow-border">
			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead className="pl-4">Subject</TableHead>
						<TableHead>Status</TableHead>
						<TableHead className="hidden text-right md:table-cell">Recipients</TableHead>
						<TableHead className="hidden text-right md:table-cell">Opens</TableHead>
						<TableHead className="hidden text-right md:table-cell">Clicks</TableHead>
						<TableHead className={cn("hidden text-right sm:table-cell", !hasActions && "pr-4")}>Date</TableHead>
						{hasActions && (
							<TableHead className="w-12 pr-2">
								<span className="sr-only">Actions</span>
							</TableHead>
						)}
					</TableRow>
				</TableHeader>
				<TableBody>
					{campaigns.map((campaign) => {
						const id = campaign._id.toString();
						const { stats } = campaign;
						const reached = stats.delivered || stats.sent;
						const date = campaign.sentAt || campaign.startedAt;
						return (
							<TableRow key={id} className="relative">
								<TableCell className="w-full max-w-0 py-3 pl-4 sm:w-1/2">
									<div className="flex min-w-0 items-center gap-3.5">
										<ThumbnailCampaign campaign={campaign} newsletter={newsletter} hasBadge={false} />
										<Link
											href={`/campaigns/${id}`}
											className="min-w-0 truncate font-medium after:absolute after:inset-0"
										>
											{campaign.subject || "Untitled"}
										</Link>
									</div>
								</TableCell>
								<TableCell>
									<BadgeStatus status={campaign.status} />
								</TableCell>
								<TableCell className="hidden text-right tabular-nums md:table-cell">
									{stats.recipients ? formatNumber(stats.recipients) : <TextEmpty />}
								</TableCell>
								<TableCell className="hidden text-right tabular-nums md:table-cell">
									{formatRate(stats.opened, reached) ?? <TextEmpty />}
								</TableCell>
								<TableCell className="hidden text-right tabular-nums md:table-cell">
									{formatRate(stats.clicked, reached) ?? <TextEmpty />}
								</TableCell>
								<TableCell
									className={cn(
										"hidden text-right text-muted-foreground tabular-nums sm:table-cell",
										!hasActions && "pr-4"
									)}
								>
									{campaign.status === "scheduled" && campaign.scheduledAt ? (
										<TimeLocal value={campaign.scheduledAt.toISOString()} options={SCHEDULED_FORMAT} />
									) : date ? (
										formatDate(date)
									) : (
										formatRelative(campaign.updatedAt)
									)}
								</TableCell>
								{hasActions && (
									<TableCell className="pr-2 text-right">
										<MenuCampaign
											id={id}
											status={campaign.status}
											subject={campaign.subject}
											scheduledAt={campaign.scheduledAt?.toISOString() ?? null}
											pageUrl={pageUrls[id] ?? null}
										/>
									</TableCell>
								)}
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
}
