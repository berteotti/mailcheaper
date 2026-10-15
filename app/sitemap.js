import { getAppUrl, isCloud } from "@/lib/config";
import { DOC_PAGES } from "@/lib/docs/llms";
import { siteExtensions } from "@/lib/site-extensions";

// Rendered when asked: APP_URL is set where the Worker runs, not where it's built, so a build-time render would
// carry the wrong address.
export const dynamic = "force-dynamic";

// The app domain's pages: the docs, and on MailCheap Cloud its marketing site's. Archive hosts get their own
// sitemap.xml (proxy.js).
export default function sitemap() {
	const appUrl = getAppUrl();
	return [...(isCloud() ? siteExtensions.publicPages : []), ...DOC_PAGES.map(({ href }) => href)].map((path) => ({
		url: path === "/" ? appUrl : `${appUrl}${path}`,
	}));
}
