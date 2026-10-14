import "server-only";
import { revalidatePath } from "next/cache";
import { cache } from "react";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getAll, getOne } from "@/lib/db";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const PUBLISHED_STATUSES = ["sending", "paused", "sent"];
const LISTED_FILTER = "archiveSlug IS NOT NULL AND archiveListed = 1 AND status IN ('sending', 'paused', 'sent')";
const CARD_FIELDS = "_id, subject, previewText, archiveSlug, archivePinned, sentAt, startedAt, thumbnailUrl, webViews";

export const getArchiveNewsletter = cache(async (slug) => {
	if (!SLUG_PATTERN.test(slug)) return null;
	return getOne(`SELECT _id, name, slug, imageUrl, fromName, description, socialLinks, author
		FROM newsletters WHERE slug = ? AND archiveEnabled = 1`, [slug]);
});

const getSharedThumbnails = cache(async (newsletterId) => {
	const rows = await getAll(`SELECT thumbnailUrl FROM campaigns WHERE newsletterId = ? AND thumbnailUrl IS NOT NULL
		AND ${LISTED_FILTER} GROUP BY thumbnailUrl HAVING count(*) > 1`, [newsletterId]);
	return new Set(rows.map(({ thumbnailUrl }) => thumbnailUrl));
});

async function withOwnThumbnails(newsletterId, issues) {
	const shared = await getSharedThumbnails(String(newsletterId));
	return issues.map((issue) => shared.has(issue.thumbnailUrl) ? { ...issue, thumbnailUrl: undefined } : issue);
}

export const getArchiveIssue = cache(async (newsletterId, postSlug) => {
	if (!ARCHIVE_SLUG_PATTERN.test(postSlug)) return null;
	const issue = await getOne(`SELECT ${CARD_FIELDS}, format, markdown, html, source FROM campaigns
		WHERE newsletterId = ? AND archiveSlug = ? AND status IN ('sending', 'paused', 'sent')`, [newsletterId, postSlug]);
	return issue && (await withOwnThumbnails(newsletterId, [issue]))[0];
});

export async function listArchiveIssues(newsletterId, { limit = 0, excludeId } = {}) {
	const issues = await getAll(`SELECT ${CARD_FIELDS} FROM campaigns WHERE newsletterId = ? AND ${LISTED_FILTER}
		AND (? IS NULL OR _id != ?) ORDER BY sentAt DESC, startedAt DESC, _id DESC LIMIT ?`, [newsletterId, excludeId, excludeId, limit || -1]);
	return withOwnThumbnails(newsletterId, issues);
}

export function listPublishedIssues(newsletterId) {
	return getAll(`SELECT _id, subject, previewText, archiveSlug, sentAt, startedAt FROM campaigns
		WHERE newsletterId = ? AND ${LISTED_FILTER} ORDER BY sentAt DESC, startedAt DESC, _id DESC`, [newsletterId]);
}

export const countReaders = cache(async (newsletterId) =>
	(await getOne("SELECT count(*) AS count FROM contacts WHERE newsletterId = ? AND status = 'active'", [newsletterId])).count
);

export function revalidateArchive() {
	revalidatePath("/archive/[slug]", "layout");
}

export function getIssuePageUrl({ campaign, newsletter }) {
	if (!newsletter?.archiveEnabled || !campaign.archiveSlug || !PUBLISHED_STATUSES.includes(campaign.status)) return null;
	return getArchiveUrls(newsletter).absolutePost(campaign.archiveSlug);
}
