import { Send } from "lucide-react";
import ButtonNewCampaign from "@/components/ButtonNewCampaign";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import TableCampaigns from "@/components/TableCampaigns";
import ThumbnailCampaign from "@/components/ThumbnailCampaign";
import { getIssuePageUrl } from "@/lib/archive-data";
import { listNewsletterCampaigns } from "@/lib/campaign-queries";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Campaigns" };

export default async function CampaignsPage() {
	const { account, selected } = await getSelectedNewsletter();
	const campaigns = selected ? await listNewsletterCampaigns(account, selected._id, 200) : [];
	const pageUrls = Object.fromEntries(
		campaigns
			.map((campaign) => [campaign._id.toString(), getIssuePageUrl({ campaign, newsletter: selected })])
			.filter(([, url]) => url)
	);

	return (
		<>
			<HeaderPage title="Campaigns">
				<ButtonNewCampaign
					newsletterId={selected ? String(selected._id) : null}
					campaigns={campaigns.map((campaign) => toCopyOption(campaign, selected))}
				/>
			</HeaderPage>

			{campaigns.length === 0 ? (
				<StateEmpty icon={Send} title="No campaigns yet" />
			) : (
				<div className="animate-enter">
					<TableCampaigns campaigns={campaigns} newsletter={selected} hasActions pageUrls={pageUrls} />
				</div>
			)}
		</>
	);
}

// A campaign New can copy, with the date the table shows: when it goes out, went out, or was last edited.
function toCopyOption(campaign, newsletter) {
	const at = campaign.status === "scheduled" ? campaign.scheduledAt : campaign.sentAt || campaign.startedAt || campaign.updatedAt;
	return {
		id: campaign._id.toString(),
		subject: campaign.subject,
		status: campaign.status,
		at: at?.toISOString() ?? null,
		thumbnail: <ThumbnailCampaign campaign={campaign} newsletter={newsletter} width={48} height={30} hasBadge={false} />,
	};
}
