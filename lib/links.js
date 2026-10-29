// Links as people type them in the editor's link fields, and as the dashboard shows them. Nothing here is server-only,
// so the editor's toolbars use it too.

// What's typed: a web address as it is, an email address as a link that opens an email to it, and anything else as a
// web address.
export function normalizeUrl(value) {
	const url = String(value ?? "").trim();
	if (!url || /^(https?:|mailto:)/i.test(url)) return url;
	if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(url)) return `mailto:${url}`;
	return `https://${url}`;
}

// "example.com/post?id=2" for a list: no scheme, no lone trailing slash.
export function formatLinkUrl(url) {
	return String(url).replace(/^https?:\/\//, "").replace(/^([^/?#]+)\/(?=$|[?#])/, "$1");
}
