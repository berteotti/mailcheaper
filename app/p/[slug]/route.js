import { getArchiveUrls } from "@/lib/archive-hosts";
import { getOne } from "@/lib/db";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;

// Archive domains rewrite /p/slug in proxy.js; on the app's domain the link doesn't name the newsletter.
export async function GET(request, { params }) {
	const { slug } = await params;
	if (!SLUG_PATTERN.test(slug)) return new Response("Not found", { status: 404 });

	const newsletter = await getOne(`SELECT n.slug FROM newsletters n JOIN campaigns c ON c.newsletterId = n._id
		WHERE c.archiveSlug = ? AND n.archiveEnabled = 1`, [slug]);
	if (!newsletter) return new Response("Not found", { status: 404 });

	return Response.redirect(new URL(getArchiveUrls(newsletter).post(slug), request.url), 307);
}
