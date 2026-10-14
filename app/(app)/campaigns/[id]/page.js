import { isObjectIdString as isValidObjectId } from "@/lib/validation";
import { notFound } from "next/navigation";
import CampaignReport from "@/components/CampaignReport";
import FormCampaign from "@/components/FormCampaign";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { findCampaign, listSendTimes } from "@/lib/campaign-queries";
import { isSendingEnabled } from "@/lib/config";
import { getAll, getOne } from "@/lib/db";
import { MESSAGE_STATS_SQL } from "@/lib/message-stats";
import { findNewsletter } from "@/lib/newsletter-data";
import { serialize } from "@/lib/serialize";
import { listSesDomains } from "@/lib/ses";

export const metadata = { title: "Campaign" };

export default async function CampaignPage({ params }) {
	const { id } = await params;
	if (!isValidObjectId(id)) notFound();

	const campaign = await findCampaign(id);
	if (!campaign) notFound();
	const newsletter = await findNewsletter(campaign.newsletterId);
	if (!newsletter) notFound();

	if (!["draft", "scheduled"].includes(campaign.status)) {
		const [providers, remainingCount] = await Promise.all([
			getProviderBreakdown(campaign._id),
			countRemaining(campaign),
		]);
		return (
			<CampaignReport
				campaign={serialize(campaign)}
				newsletter={serialize(newsletter)}
				providers={providers}
				remainingCount={remainingCount}
			/>
		);
	}

	const [audienceCount, domains, sendTimes] = await Promise.all([
		getOne("SELECT count(*) AS count FROM contacts WHERE newsletterId = ? AND status = 'active'", [newsletter._id]).then((row) => row.count),
		listSesDomains(),
		getSendTimes(campaign),
	]);
	const fromDomain = newsletter.fromEmail.split("@")[1];
	const isDomainVerified =
		Array.isArray(domains) && domains.some(({ domain, verified }) => domain === fromDomain && verified);

	return (
		<FormCampaign
			campaign={serialize(campaign)}
			newsletter={serialize(newsletter)}
			audienceCount={audienceCount}
			isDomainVerified={isDomainVerified}
			isSendingEnabled={isSendingEnabled()}
			testEmail={process.env.ADMIN_EMAIL}
			sendTimes={sendTimes}
			archiveUrlBase={newsletter.archiveEnabled ? getArchiveUrls(newsletter).absolutePost("") : null}
		/>
	);
}

// A newsletter's first issue borrows the times the other newsletters go out.
async function getSendTimes(campaign) {
	const own = await listSendTimes({ newsletterId: campaign.newsletterId, excludeId: campaign._id });
	const rows = own.length > 0 ? own : await listSendTimes({ excludeId: campaign._id });
	return {
		history: rows.map(({ at }) => at.toISOString()),
		taken: own.filter(({ status }) => status === "scheduled").map(({ at }) => at.toISOString()),
	};
}

// Only a send capped to the most engaged has a next step. Close enough for the dialog: contacts who
// left after receiving it make this a little low, and the send itself skips everyone who has it.
async function countRemaining(campaign) {
	if (campaign.status !== "sent" || !campaign.audienceLimit) return 0;
	const { count: active } = await getOne("SELECT count(*) AS count FROM contacts WHERE newsletterId = ? AND status = 'active'", [campaign.newsletterId]);
	const reached = (campaign.stats?.recipients ?? 0) + (campaign.lastChance?.recipients ?? 0);
	return Math.max(0, active - reached);
}

async function getProviderBreakdown(campaignId) {
	return getAll(`SELECT coalesce(provider, 'other') AS provider, ${MESSAGE_STATS_SQL} FROM messages
		WHERE campaignId = ? AND kind = 'campaign' GROUP BY coalesce(provider, 'other') HAVING sum(sentAt IS NOT NULL) > 0
		ORDER BY sent DESC`, [campaignId]);
}
