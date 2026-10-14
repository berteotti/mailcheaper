import { Send } from "lucide-react";
import ButtonNewCampaign from "@/components/ButtonNewCampaign";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import TableCampaigns from "@/components/TableCampaigns";
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
				<ButtonNewCampaign newsletterId={selected ? String(selected._id) : null} />
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
