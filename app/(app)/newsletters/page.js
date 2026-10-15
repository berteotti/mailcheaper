import { redirect } from "next/navigation";
import FormNewsletter from "@/components/FormNewsletter";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import { cleanupTotalsQuery } from "@/lib/cleanup";
import { getSharedDomain, isSendingEnabled } from "@/lib/config";
import { getOne } from "@/lib/db";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { findAccountDomains } from "@/lib/sender";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { serialize } from "@/lib/serialize";

export const metadata = { title: "Settings" };

// The open newsletter's settings; /newsletters/<id> opens another one first. The form starts over for each
// newsletter: its fields keep what they were given when it first rendered.
export default async function SettingsPage() {
	const { user, account, selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const [newsletter, domains, cleanupTotals] = await Promise.all([
		getOne("SELECT * FROM newsletters WHERE accountId = ? AND _id = ?", [account._id, selected._id]),
		findAccountDomains(account._id),
		getCleanupTotals(account, selected._id),
	]);

	return (
		<LayoutNarrow>
			<HeaderPage title="Settings" />
			<FormNewsletter
				key={String(newsletter._id)}
				newsletter={serialize(newsletter)}
				domains={serialize(domains)}
				sharedDomain={getSharedDomain()}
				isSendingEnabled={isSendingEnabled()}
				testEmail={user.email}
				cleanupTotals={cleanupTotals}
			/>
		</LayoutNarrow>
	);
}

async function getCleanupTotals(account, newsletterId) {
	const { sql, params } = cleanupTotalsQuery({ accountId: account._id, newsletterId });
	const totals = await getOne(sql, params);
	return { waiting: totals?.waiting ?? 0, kept: totals?.kept ?? 0, dormant: totals?.dormant ?? 0 };
}
