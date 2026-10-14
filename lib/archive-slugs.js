import "server-only";
import { execute, getOne, isUniqueConstraint } from "@/lib/db";
import { slugify } from "@/lib/slug";

// Slugs are unique across accounts (/p/<slug> on the app's domain), so the check looks at every account.
export async function isArchiveSlugTaken(slug, { exceptId } = {}) {
	return Boolean(await getOne("SELECT 1 AS taken FROM campaigns WHERE archiveSlug = ? AND (? IS NULL OR _id != ?)", [slug, exceptId ?? null, exceptId ?? null]));
}

export async function uniqueArchiveSlug(base) {
	for (let suffix = 1; suffix < 100; suffix += 1) {
		const slug = suffix === 1 ? base : `${base}-${suffix}`;
		if (!(await isArchiveSlugTaken(slug))) return slug;
	}
	return `${base}-${Date.now()}`;
}

// Unless the API set one, the slug comes from the subject as it is when the issue goes out, so the
// /p/ page exists before the first email links to it. Another issue can take the slug between the check
// and the write (the column is unique): then it picks again.
export async function assignArchiveSlug({ campaign, newsletter }) {
	if (!newsletter.archiveEnabled || campaign.archiveSlug) return;
	const base = slugify(campaign.subject, 80) || "issue";
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await execute("UPDATE campaigns SET archiveSlug = ?, updatedAt = ? WHERE accountId = ? AND _id = ? AND archiveSlug IS NULL", [
				await uniqueArchiveSlug(base),
				Date.now(),
				campaign.accountId,
				campaign._id,
			]);
			return;
		} catch (error) {
			if (!isUniqueConstraint(error) || attempt === 2) throw error;
		}
	}
}
