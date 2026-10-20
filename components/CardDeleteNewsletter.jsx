import Link from "next/link";
import { Clock, Send } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import CardSettings from "@/components/CardSettings";
import DialogDeleteNewsletter from "@/components/DialogDeleteNewsletter";
import RowBlocker from "@/components/RowBlocker";
import { formatDate } from "@/lib/format";
import { ACCOUNT_CHECK_DAYS } from "@/lib/sending-rules";

// The end of a newsletter's settings, inside its form: nothing here is a field. blockers: getNewsletterDeletionBlockers's.
export default function CardDeleteNewsletter({ newsletter, blockers, stagger }) {
	return (
		<CardSettings title="Delete newsletter" stagger={stagger}>
			<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
				Its contacts, campaigns, archive and stats are deleted for good. Addresses that bounced or complained stay
				suppressed on your account.
			</p>
			{blockers?.campaigns.length > 0 && (
				<RowBlocker icon={Send} title="Stop its campaigns first" text="Pause the ones sending, and unschedule the scheduled ones.">
					<ul className="flex flex-col gap-1">
						{blockers.campaigns.map((campaign) => (
							<li key={String(campaign._id)}>
								<Link
									href={`/campaigns/${campaign._id}`}
									className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 hover:bg-muted"
								>
									<span className="truncate">{campaign.subject || "Untitled"}</span>
									<BadgeStatus status={campaign.status} />
								</Link>
							</li>
						))}
					</ul>
				</RowBlocker>
			)}
			{blockers?.availableAt && (
				<RowBlocker
					icon={Clock}
					title={`You can delete it from ${formatDate(blockers.availableAt)}`}
					text={`Its emails from the last ${ACCOUNT_CHECK_DAYS} days still count toward your bounce and complaint rates.`}
				/>
			)}
			<div className="flex justify-end rounded-b-xl bg-destructive/[0.03] px-4 py-3 dark:bg-destructive/[0.06]">
				<DialogDeleteNewsletter id={String(newsletter._id)} name={newsletter.name} isDisabled={Boolean(blockers)} />
			</div>
		</CardSettings>
	);
}
