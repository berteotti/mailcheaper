import { getAppUrl } from "@/lib/config";

// Rendered when asked: APP_URL is set where the Worker runs, not where it's built, so a build-time render would
// carry the wrong address.
export const dynamic = "force-dynamic";

// The dashboard, the admin, the APIs and tracked links. / stays open: on MailCheap Cloud, signed-out visitors get
// the landing page there. Archive hosts get their own robots.txt (proxy.js).
const PRIVATE_PATHS = [
	"/account",
	"/admin",
	"/api/",
	"/api-keys",
	"/billing",
	"/campaigns",
	"/contacts",
	"/domains",
	"/mcp",
	"/newsletters",
	"/restore",
	"/c/",
	"/o/",
];

export default function robots() {
	return {
		rules: { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS },
		sitemap: `${getAppUrl()}/sitemap.xml`,
	};
}
