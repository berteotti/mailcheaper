import { getAppUrl, getSharedDomain } from "./config.js";

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function toHostname(host) {
	return String(host ?? "")
		.toLowerCase()
		.split(":")[0];
}

// A newsletter's archive and the links in its emails (tracking, unsubscribe, confirmation) live on the
// account's verified archive subdomain, else on <slug>.<shared domain>. Without SHARED_DOMAIN (local
// development) they stay on APP_URL.
export function getNewsletterHost(newsletter, sharedDomain = getSharedDomain()) {
	if (newsletter?.archiveHost) return newsletter.archiveHost;
	return sharedDomain && newsletter?.slug ? `${newsletter.slug}.${sharedDomain}` : null;
}

export function getLinkBaseUrl(newsletter, { sharedDomain = getSharedDomain(), appUrl = getAppUrl() } = {}) {
	const host = getNewsletterHost(newsletter, sharedDomain);
	return host ? `https://${host}` : appUrl;
}

// weekly.mailcheap.ai -> weekly. Only one label deep: a.b.mailcheap.ai is nobody's.
export function getSlugForSharedHost(host, sharedDomain = getSharedDomain()) {
	const hostname = toHostname(host);
	if (!sharedDomain || !hostname.endsWith(`.${sharedDomain}`)) return null;
	const label = hostname.slice(0, -sharedDomain.length - 1);
	return LABEL_PATTERN.test(label) ? label : null;
}

const ARCHIVE_PATH_PATTERN = /^\/archive\/([^/]+)(\/.*)?$/;
const HOST_PATHS = { "/sitemap": "/sitemap.xml", "/robots": "/robots.txt" };

// Where an app-domain /archive path lives on the newsletter's shared subdomain, or null without SHARED_DOMAIN.
export function getArchiveHostUrl(pathname, search = "", sharedDomain = getSharedDomain()) {
	const match = ARCHIVE_PATH_PATTERN.exec(pathname);
	const host = match && getNewsletterHost({ slug: match[1] }, sharedDomain);
	if (!host) return null;
	const path = match[2] ?? "/";
	return `https://${host}${HOST_PATHS[path] ?? path}${search}`;
}

// Archive pages are cached once for every host, so their links can't depend on the request. Without a
// host, the archive lives at APP_URL/archive/<slug>.
export function getArchiveUrls(newsletter, { sharedDomain = getSharedDomain(), appUrl = getAppUrl() } = {}) {
	const host = getNewsletterHost(newsletter, sharedDomain);
	const base = host ? `https://${host}` : `/archive/${newsletter.slug}`;
	const absoluteBase = host ? base : `${appUrl}${base}`;
	return {
		host,
		index: host ? `${base}/` : base,
		post: (postSlug) => `${base}/p/${postSlug}`,
		author: (authorSlug) => `${base}/authors/${authorSlug}`,
		siteIndex: host ? `${base}/` : absoluteBase,
		absolutePost: (postSlug) => `${absoluteBase}/p/${postSlug}`,
		absoluteAuthor: (authorSlug) => `${absoluteBase}/authors/${authorSlug}`,
	};
}
