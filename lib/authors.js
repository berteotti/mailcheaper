import "server-only";
import { MAX_AUTHORS } from "@/lib/author-rules";
import { accountIdOf, getAll, getOne } from "@/lib/db";
import { isObjectIdString } from "@/lib/validation";

// A newsletter's authors, the first added first, as the editor's menu lists them.
export function listLiveAuthors(account, newsletterId) {
	return getAll(
		"SELECT * FROM authors WHERE accountId = ? AND newsletterId = ? AND deletedAt IS NULL ORDER BY createdAt, _id LIMIT ?",
		[accountIdOf(account), String(newsletterId), MAX_AUTHORS]
	);
}

// One of the account's authors, of any of its newsletters.
export function findLiveAuthor(account, id) {
	if (!isObjectIdString(String(id ?? ""))) return null;
	return getOne("SELECT * FROM authors WHERE accountId = ? AND _id = ? AND deletedAt IS NULL", [accountIdOf(account), String(id).toLowerCase()]);
}

// The author a newsletter's new issues start with: the one picked on its Sender page (newsletters.defaultAuthorId)
// while they're still one of its authors, else its first one.
export function pickDefaultAuthor(authors, defaultAuthorId) {
	return authors.find(({ _id }) => String(_id) === String(defaultAuthorId)) ?? authors[0] ?? null;
}

// A newsletter's authors (listLiveAuthors), and its default one among them (pickDefaultAuthor).
export async function findNewsletterAuthors(account, newsletterId) {
	const [authors, newsletter] = await Promise.all([
		listLiveAuthors(account, newsletterId),
		getOne("SELECT defaultAuthorId FROM newsletters WHERE accountId = ? AND _id = ?", [accountIdOf(account), String(newsletterId)]),
	]);
	return { authors, defaultAuthor: pickDefaultAuthor(authors, newsletter?.defaultAuthorId) };
}

export async function findDefaultAuthorId(account, newsletterId) {
	return (await findNewsletterAuthors(account, newsletterId)).defaultAuthor?._id ?? null;
}

// What a newsletter's first author starts with: the signed-in person, at the address its replies go to.
export function getAuthorSuggestion({ user, newsletter }) {
	return { name: user?.name || newsletter?.fromName || "", email: newsletter?.replyTo || user?.email || "" };
}

// A campaign's author as they are now. null without one, or once they're removed.
export function findCurrentAuthor(campaign) {
	if (!campaign?.authorId) return null;
	return getOne("SELECT * FROM authors WHERE accountId = ? AND newsletterId = ? AND _id = ? AND deletedAt IS NULL", [
		String(campaign.accountId),
		String(campaign.newsletterId),
		String(campaign.authorId),
	]);
}

// Who a campaign's emails show and reply to: the author its send started with (sentAuthor), so every email of a send
// is the same, else its author as they are now.
export async function findCampaignAuthor(campaign) {
	return campaign?.sentAuthor?.name ? campaign.sentAuthor : findCurrentAuthor(campaign);
}

// A campaign as its emails read it: with its author (findCampaignAuthor) as author.
export async function withAuthor(campaign) {
	return campaign && { ...campaign, author: await findCampaignAuthor(campaign) };
}

// What a send keeps of its author (campaigns.sentAuthor).
export function toSentAuthor(author) {
	return {
		name: author.name,
		email: author.email,
		...(author.imageUrl && { imageUrl: author.imageUrl }),
		showInEmails: author.showInEmails !== false,
	};
}

// The author an issue's page shows, { name, imageUrl }, or null: never their address, which isn't even read.
export async function findWebAuthor(newsletter, authorId) {
	if (!authorId) return null;
	const author = await getOne(
		"SELECT name, imageUrl FROM authors WHERE accountId = ? AND newsletterId = ? AND _id = ? AND deletedAt IS NULL AND showOnWeb = 1",
		[String(newsletter.accountId), String(newsletter._id), String(authorId)]
	);
	return author ? { name: author.name, imageUrl: author.imageUrl || null } : null;
}

// An author as the API and the editor get them. defaultAuthor: their newsletter's (pickDefaultAuthor).
export function toAuthorView(author, defaultAuthor = null) {
	return {
		id: String(author._id),
		newsletterId: String(author.newsletterId),
		name: author.name,
		email: author.email,
		imageUrl: author.imageUrl || null,
		showOnWeb: author.showOnWeb !== false,
		showInEmails: author.showInEmails !== false,
		isDefault: Boolean(defaultAuthor) && String(defaultAuthor._id) === String(author._id),
	};
}
