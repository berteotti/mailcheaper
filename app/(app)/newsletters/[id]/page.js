import { isObjectIdString as isValidObjectId } from "@/lib/validation";
import { notFound } from "next/navigation";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import FormNewsletter from "@/components/FormNewsletter";
import HeaderPage from "@/components/HeaderPage";
import { isSendingEnabled } from "@/lib/config";
import { getOne } from "@/lib/db";
import { findNewsletter } from "@/lib/newsletter-data";
import { serialize } from "@/lib/serialize";
import { listSesDomains } from "@/lib/ses";

export const metadata = { title: "Newsletter" };

export default async function NewsletterPage({ params }) {
	const { id } = await params;
	const isNew = id === "new";
	if (!isNew && !isValidObjectId(id)) notFound();

	const [newsletter, domains, cleanupTotals] = await Promise.all([
		isNew ? null : findNewsletter(id),
		listSesDomains(),
		isNew ? null : getCleanupTotals(id),
	]);
	if (!isNew && !newsletter) notFound();

	const verifiedDomains = Array.isArray(domains)
		? domains.filter(({ verified }) => verified).map(({ domain }) => domain)
		: null;

	return (
		<>
			<HeaderPage
				title={isNew ? "New newsletter" : newsletter.name}
				backHref="/newsletters"
				icon={newsletter && <AvatarNewsletter newsletter={newsletter} size={32} />}
			/>
			<FormNewsletter
				newsletter={newsletter ? serialize(newsletter) : null}
				verifiedDomains={verifiedDomains}
				isSendingEnabled={isSendingEnabled()}
				testEmail={process.env.ADMIN_EMAIL}
				cleanupTotals={cleanupTotals}
			/>
		</>
	);
}

async function getCleanupTotals(newsletterId) {
	const totals = await getOne(`SELECT
		sum(status = 'active' AND lastChanceAt >= max(coalesce(lastEngagedAt, 0), coalesce(lastOpenAt, 0), coalesce(lastClickAt, 0), coalesce(confirmedAt, 0), subscribedAt)) AS waiting,
		sum(status = 'active' AND lastChanceAt < max(coalesce(lastEngagedAt, 0), coalesce(lastOpenAt, 0), coalesce(lastClickAt, 0), coalesce(confirmedAt, 0), subscribedAt)) AS kept,
		sum(status = 'dormant') AS dormant
		FROM contacts WHERE newsletterId = lower(?) AND lastChanceAt IS NOT NULL`, [newsletterId]);
	return { waiting: totals?.waiting ?? 0, kept: totals?.kept ?? 0, dormant: totals?.dormant ?? 0 };
}
