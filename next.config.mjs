// No script-src: Next.js's inline scripts would need per-request nonces, which archive pages can't have
// while they're cached (ISR). script-src-attr still blocks inline event handlers everywhere.
const CONTENT_SECURITY_POLICY = [
	"frame-ancestors 'none'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"script-src-attr 'none'",
].join("; ");

// Also set by the App Worker on every response (worker/index.ts), which imports them from here: this file is
// bundled into the Worker, so it reads no files and no build-time environment.
export const SECURITY_HEADERS = [
	{ key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
	{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
	{ key: "X-Frame-Options", value: "DENY" },
	{ key: "X-Content-Type-Options", value: "nosniff" },
	// The origin only, MailCheap's own pages included: a URL like a contacts search can hold a subscriber's email,
	// and the page it leads to can send its referrer to analytics.
	{ key: "Referrer-Policy", value: "strict-origin" },
];

// Uploads load from the R2 asset domain as they are (lib/thumbnail.js), so there are no remote image patterns.
// MailCheap Cloud's marketing modules (@/lib/site-extensions, @/components/SiteExtensions) would be aliased in
// vite.config.js; the open source has none, so the defaults resolve as they are.
/** @type {import('next').NextConfig} */
const nextConfig = {
	poweredByHeader: false,
	async headers() {
		return [{ source: "/:path*", headers: SECURITY_HEADERS }];
	},
};

export default nextConfig;
