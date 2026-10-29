import "server-only";
import { revalidatePath } from "next/cache";
import { cache } from "react";
import { ACCESS_FIELDS, hasActiveSubscription } from "@/lib/account-state";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getAll, getOne, getValue } from "@/lib/db";
import { fillMergeTags } from "@/lib/merge-tags";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const PUBLISHED_STATUSES = ["sending", "paused", "sent"];
const PUBLISHED_SQL = `status IN (${PUBLISHED_STATUSES.map((status) => `'${status}'`).join(", ")})`;
const LISTED_FILTER = `archiveSlug IS NOT NULL AND archiveListed = 1 AND ${PUBLISHED_SQL}`;
const CARD_FIELDS = "_id, subject, previewText, archiveSlug, archivePinned, sentAt, startedAt, thumbnailUrl, webViews";
// The account columns hasActiveSubscription reads.
const ACCESS_COLUMNS = Object.keys(ACCESS_FIELDS)
	.map((name) => `a.${name}`)
	.join(", ");

// Archives are public by slug (unique across accounts, so no account scope). A canceled account's archive is
// offline until it subscribes again.
export const getArchiveNewsletter = cache(async (slug) => {
	if (!SLUG_PATTERN.test(slug)) return null;
	const row = await getOne(
		`SELECT n._id, n.accountId, n.name, n.slug, n.archiveHost, n.imageUrl, n.fromName, n.description, n.socialLinks, n.author, n.language, n.languageRegion, n.theme,
			${ACCESS_COLUMNS}
		FROM newsletters n JOIN accounts a ON a._id = n.accountId
		WHERE n.slug = ? AND n.archiveEnabled = 1`,
		[slug]
	);
	if (!row) return null;
	const { subscriptionStatus, comp, deletion, ...newsletter } = row;
	return hasActiveSubscription({ subscriptionStatus, comp, deletion }) ? newsletter : null;
});

// A picture several listed issues share is the newsletter's banner, not the issue's own. Those issues
// get a generated card instead, so the archive doesn't repeat one image on every card. Unlisted
// issues don't count.
const getSharedThumbnails = cache(async (newsletter) => {
	const rows = await getAll(
		`SELECT thumbnailUrl FROM campaigns
		WHERE accountId = ? AND newsletterId = ? AND thumbnailUrl IS NOT NULL AND ${LISTED_FILTER}
		GROUP BY thumbnailUrl HAVING count(*) > 1`,
		[newsletter.accountId, newsletter._id]
	);
	return new Set(rows.map(({ thumbnailUrl }) => thumbnailUrl));
});

async function withOwnThumbnails(newsletter, issues) {
	const shared = await getSharedThumbnails(newsletter);
	return issues.map((issue) => (shared.has(issue.thumbnailUrl) ? { ...issue, thumbnailUrl: undefined } : issue));
}

// A page has no reader to name: merge tags in a subject or preview text show their fallback.
function withoutMergeTags(issue) {
	return { ...issue, subject: fillMergeTags(issue.subject), previewText: fillMergeTags(issue.previewText) };
}

export const getArchiveIssue = cache(async (newsletter, postSlug) => {
	if (!ARCHIVE_SLUG_PATTERN.test(postSlug)) return null;
	const issue = await getOne(
		`SELECT ${CARD_FIELDS}, format, markdown, html, source FROM campaigns
		WHERE accountId = ? AND newsletterId = ? AND archiveSlug = ? AND ${PUBLISHED_SQL}`,
		[newsletter.accountId, newsletter._id, postSlug]
	);
	return issue && withoutMergeTags((await withOwnThumbnails(newsletter, [issue]))[0]);
});

export async function listArchiveIssues(newsletter, { limit = 0, excludeId } = {}) {
	const issues = await getAll(
		`SELECT ${CARD_FIELDS} FROM campaigns
		WHERE accountId = ? AND newsletterId = ? AND ${LISTED_FILTER} AND (? IS NULL OR _id != ?)
		ORDER BY sentAt DESC, startedAt DESC, _id DESC LIMIT ?`,
		[newsletter.accountId, newsletter._id, excludeId ?? null, excludeId ?? null, limit || -1]
	);
	return (await withOwnThumbnails(newsletter, issues)).map(withoutMergeTags);
}

// For the API: every listed issue that went out.
export async function listPublishedIssues(newsletter) {
	const issues = await getAll(
		`SELECT _id, subject, previewText, archiveSlug, sentAt, startedAt FROM campaigns
		WHERE accountId = ? AND newsletterId = ? AND ${LISTED_FILTER}
		ORDER BY sentAt DESC, startedAt DESC, _id DESC`,
		[newsletter.accountId, newsletter._id]
	);
	return issues.map(withoutMergeTags);
}

// Cached per render: the layout's popup and the page's own subscribe blocks show the same count.
export const countReaders = cache(async (newsletter) =>
	getValue("SELECT count(*) FROM contacts WHERE accountId = ? AND newsletterId = ? AND status = 'active'", [
		newsletter.accountId,
		newsletter._id,
	])
);

// Cached pages are tagged by route file, so the pattern refreshes every archive page; each
// regenerates on its next visit. Only the app Worker has the cache: work in the jobs Worker calls
// requestRevalidation({ archive: true }) (lib/app-revalidation.js) instead.
export function revalidateArchive() {
	revalidatePath("/archive/[slug]", "layout");
}

// Unlisted issues keep their page, so only the archive switch, the slug and the send decide.
export function getIssuePageUrl({ campaign, newsletter }) {
	if (!newsletter?.archiveEnabled || !campaign.archiveSlug || !PUBLISHED_STATUSES.includes(campaign.status)) return null;
	return getArchiveUrls(newsletter).absolutePost(campaign.archiveSlug);
}
