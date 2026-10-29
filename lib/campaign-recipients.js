import "server-only";
import { RECIPIENT_COUNTS_SQL, RECIPIENT_MATCHES, toRecipientCounts } from "@/lib/campaign-recipient-rules";
import { accountIdOf, getAll, getOne } from "@/lib/db";
import { getEmailOutcome } from "@/lib/email-outcome";
import { LINK_CLICK_EVENT } from "@/lib/link-stats";

// How many recipients each filter of lib/campaign-recipient-rules.js picks.
export async function countCampaignRecipients(account, campaign) {
	const row = await getOne(`SELECT ${RECIPIENT_COUNTS_SQL} FROM messages WHERE accountId = ? AND campaignId = ? AND kind = 'campaign'`, [
		accountIdOf(account),
		String(campaign._id),
	]);
	return toRecipientCounts([row]);
}

// A page of the recipients a filter picks, by contact ID, a stable order, each with their name, what the email came to
// (lib/email-outcome.js) and the links they clicked, first clicked first. after: the previous page's last contact ID.
// nextCursor: this page's, when there's another. A contact's emails go when it's deleted, so each one has its contact.
export async function listCampaignRecipients(account, campaign, { filter = "all", limit, after = null }) {
	const accountId = accountIdOf(account);
	const campaignId = String(campaign._id);
	const messages = await getAll(
		`SELECT m.*, c.firstName, c.lastName FROM (SELECT _id, contactId, email, status, error, sentAt, deliveredAt, openedAt, clickedAt,
				bouncedAt, complainedAt, unsubscribedAt FROM messages
			WHERE accountId = ?1 AND campaignId = ?2 AND kind = 'campaign' AND sentAt IS NOT NULL AND (${RECIPIENT_MATCHES[filter]})
			AND (?3 IS NULL OR contactId > ?3) ORDER BY contactId LIMIT ?4) m
		JOIN contacts c ON c.accountId = ?1 AND c._id = m.contactId ORDER BY m.contactId`,
		[accountId, campaignId, after, limit + 1]
	);
	const page = messages.slice(0, limit);
	const clickers = page.filter(({ clickedAt }) => clickedAt).map(({ _id }) => String(_id));
	const clicks = clickers.length
		? await getAll(
				`SELECT messageId, json_extract(data, '$.url') AS url, min(occurredAt) AS firstAt FROM events
				WHERE accountId = ? AND campaignId = ? AND type = ? AND messageId IN (SELECT value FROM json_each(?))
				GROUP BY messageId, json_extract(data, '$.key') ORDER BY firstAt, url`,
				[accountId, campaignId, LINK_CLICK_EVENT, JSON.stringify(clickers)]
			)
		: [];
	const links = Map.groupBy(clicks, ({ messageId }) => String(messageId));

	return {
		recipients: page.map((message) => ({
			contactId: String(message.contactId),
			email: message.email,
			firstName: message.firstName ?? null,
			lastName: message.lastName ?? null,
			outcome: getEmailOutcome(message),
			sentAt: message.sentAt ?? null,
			deliveredAt: message.deliveredAt ?? null,
			openedAt: message.openedAt ?? null,
			clickedAt: message.clickedAt ?? null,
			bouncedAt: message.bouncedAt ?? null,
			complainedAt: message.complainedAt ?? null,
			unsubscribedAt: message.unsubscribedAt ?? null,
			clickedLinks: (links.get(String(message._id)) ?? []).map(({ url }) => url),
		})),
		nextCursor: messages.length > limit ? String(page.at(-1).contactId) : null,
	};
}
