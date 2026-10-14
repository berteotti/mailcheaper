import "server-only";
import { slugify } from "@/lib/slug";
import { execute, getOne, isUniqueConstraint, newId } from "@/lib/db";

export async function uniqueArchiveSlug(base) {
	for (let suffix = 1; suffix < 100; suffix += 1) {
		const slug = suffix === 1 ? base : `${base}-${suffix}`;
		if (!(await getOne("SELECT _id FROM campaigns WHERE archiveSlug = ?", [slug]))) return slug;
	}
	return `${base}-${newId()}`;
}

export async function assignArchiveSlug({ campaign, newsletter }) {
	if (!newsletter.archiveEnabled || campaign.archiveSlug) return;
	const base = slugify(campaign.subject, 80) || "issue";
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await execute("UPDATE campaigns SET archiveSlug = ?, updatedAt = ? WHERE _id = ? AND archiveSlug IS NULL",
				[await uniqueArchiveSlug(base), Date.now(), campaign._id]);
			return;
		} catch (error) {
			if (!isUniqueConstraint(error) || attempt === 2) throw error;
		}
	}
}
