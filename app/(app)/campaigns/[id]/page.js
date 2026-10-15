import { notFound } from "next/navigation";
import CampaignReport from "@/components/CampaignReport";
import FormCampaign from "@/components/FormCampaign";
import { getAccountSendProblem, hasActiveSubscription, isBlocked } from "@/lib/account-state";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { countNewContacts, countStartedCampaigns, listSendTimes } from "@/lib/campaign-queries";
import { isSendingEnabled } from "@/lib/config";
import { getAll, getOne, getValue } from "@/lib/db";
import { MESSAGE_STATS_SQL } from "@/lib/message-stats";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";
import { getWarmup } from "@/lib/send-spread";
import { serialize } from "@/lib/serialize";
import { loadSender } from "@/lib/sender";
import { countEmailsInFlight, getUsage } from "@/lib/usage";
import { isObjectIdString } from "@/lib/validation";

export const metadata = { title: "Campaign" };

export default async function CampaignPage({ params }) {
	const [{ id }, view] = await Promise.all([params, getSelectedNewsletter()]);
	const { user, account } = view;
	if (!isObjectIdString(id)) notFound();

	const campaign = await getOne("SELECT * FROM campaigns WHERE accountId = ? AND _id = ?", [account._id, id.toLowerCase()]);
	if (!campaign) notFound();
	openNewsletter(view, campaign.newsletterId, `/campaigns/${id}`);
	const newsletter = await getOne("SELECT * FROM newsletters WHERE accountId = ? AND _id = ?", [account._id, campaign.newsletterId]);
	if (!newsletter) notFound();
	const plan = await getPlanState(account);

	if (!["draft", "scheduled"].includes(campaign.status)) {
		const [providers, remainingCount] = await Promise.all([
			getProviderBreakdown(campaign),
			countRemaining(campaign),
		]);
		return (
			<CampaignReport
				campaign={serialize(campaign)}
				newsletter={serialize(newsletter)}
				providers={providers}
				remainingCount={remainingCount}
				emailsLeft={plan.emailsLeft}
				isBlocked={isBlocked(account)}
			/>
		);
	}

	const [audienceCount, sender, sendTimes, place, newContacts] = await Promise.all([
		countActiveContacts(account._id, newsletter._id),
		loadSender(account, newsletter),
		getSendTimes(campaign),
		countStartedCampaigns(account),
		countNewContacts(account, newsletter._id),
	]);

	return (
		<FormCampaign
			campaign={serialize(campaign)}
			newsletter={serialize(newsletter)}
			audienceCount={audienceCount}
			senderProblem={sender.problem ?? null}
			isSendingEnabled={isSendingEnabled()}
			testEmail={user.email}
			sendTimes={sendTimes}
			archiveUrlBase={newsletter.archiveEnabled ? getArchiveUrls(newsletter).absolutePost("") : null}
			planProblem={plan.problem}
			emailsLeft={plan.emailsLeft}
			warmup={getWarmup(account, { place })}
			newContacts={newContacts}
		/>
	);
}

// What the send dialogs need: emails left after the sends already going out (null: no limit), and what
// blocks any send. Without a plan, the send buttons open the paywall instead.
async function getPlanState(account) {
	if (!hasActiveSubscription(account)) return { emailsLeft: null, problem: null };
	const [usage, inFlight] = await Promise.all([getUsage(account), countEmailsInFlight(account._id)]);
	const accountProblem = getAccountSendProblem(account)?.message ?? null;
	if (usage.emailsLimit === null) return { emailsLeft: null, problem: accountProblem };
	const emailsLeft = Math.max(0, usage.emailsLimit - usage.emailsSent - inFlight);
	const problem =
		accountProblem ??
		(usage.subscribers > usage.subscribersLimit
			? "Over your plan's subscriber limit"
			: emailsLeft === 0
				? "This month's emails are used up"
				: null);
	return { emailsLeft, problem };
}

// A newsletter's first issue borrows the times the account's other newsletters go out.
async function getSendTimes(campaign) {
	const { accountId } = campaign;
	const own = await listSendTimes({ accountId, newsletterId: campaign.newsletterId, excludeId: campaign._id });
	const rows = own.length > 0 ? own : await listSendTimes({ accountId, excludeId: campaign._id });
	return {
		history: rows.map(({ at }) => at.toISOString()),
		taken: own.filter(({ status }) => status === "scheduled").map(({ at }) => at.toISOString()),
	};
}

// Only a send capped to the most engaged has a next step. Close enough for the dialog: contacts who
// left after receiving it make this a little low, and the send itself skips everyone who has it.
async function countRemaining(campaign) {
	if (campaign.status !== "sent" || !campaign.audienceLimit) return 0;
	const active = await countActiveContacts(campaign.accountId, campaign.newsletterId);
	const reached = (campaign.stats?.recipients ?? 0) + (campaign.lastChance?.recipients ?? 0);
	return Math.max(0, active - reached);
}

function countActiveContacts(accountId, newsletterId) {
	return getValue("SELECT count(*) FROM contacts WHERE accountId = ? AND newsletterId = ? AND status = 'active'", [accountId, newsletterId]);
}

function getProviderBreakdown(campaign) {
	return getAll(
		`SELECT coalesce(provider, 'other') AS provider, ${MESSAGE_STATS_SQL} FROM messages
		WHERE accountId = ? AND campaignId = ? AND kind = 'campaign' GROUP BY coalesce(provider, 'other')
		HAVING sum(sentAt IS NOT NULL) > 0 ORDER BY sent DESC`,
		[campaign.accountId, campaign._id]
	);
}
