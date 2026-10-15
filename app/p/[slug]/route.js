import { getArchiveNewsletter } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getOne } from "@/lib/db";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;

// Archive domains rewrite /p/slug in proxy.js; on the app's domain the link doesn't name the newsletter,
// and issue slugs are unique across accounts, so the lookup is by slug alone.
export async function GET(request, { params }) {
	const { slug } = await params;
	if (!SLUG_PATTERN.test(slug)) return new Response("Not found", { status: 404 });

	const owner = await getOne(
		"SELECT n.slug FROM campaigns c JOIN newsletters n ON n.accountId = c.accountId AND n._id = c.newsletterId WHERE c.archiveSlug = ?",
		[slug]
	);
	const newsletter = owner && (await getArchiveNewsletter(owner.slug));
	if (!newsletter) return new Response("Not found", { status: 404 });

	return Response.redirect(new URL(getArchiveUrls(newsletter).post(slug), request.url), 307);
}
