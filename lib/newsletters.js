export const NEWSLETTER_SUMMARY_FIELDS = "name slug imageUrl fromEmail description";
export const MAX_DESCRIPTION_LENGTH = 200;
export const MAX_AUTHOR_BIO_LENGTH = 160;
// They share the account's plan: its emails each month and its subscribers.
export const MAX_NEWSLETTERS_PER_ACCOUNT = 3;
export const NEWSLETTER_LIMIT_MESSAGE = `An account has up to ${MAX_NEWSLETTERS_PER_ACCOUNT} newsletters`;

// The admins (ADMIN_EMAILS) run the server, so their accounts have no limit: null.
export function getNewsletterLimit({ isAdmin }) {
	return isAdmin ? null : MAX_NEWSLETTERS_PER_ACCOUNT;
}

export function isAtNewsletterLimit(count, limit) {
	return limit !== null && count >= limit;
}
// The dashboard shows one newsletter at a time, the one this cookie names (lib/selected-newsletter.js). The
// newsletter menu reads it too, so it isn't httpOnly: it's only ever checked against the account's newsletters.
export const NEWSLETTER_COOKIE = "newsletter";
// Add a newsletter is a dialog of the newsletter menu: any dashboard page with this in its URL opens it.
export const ADD_NEWSLETTER_PARAM = "new-newsletter";
export const ADD_NEWSLETTER_PATH = `/?${ADD_NEWSLETTER_PARAM}=1`;

const NEWSLETTER_SECTIONS = ["/campaigns", "/contacts", "/newsletters"];
export const DESIGN_PATH = "/newsletters/design";

export function toNewsletterOption(newsletter) {
	return { id: String(newsletter._id), name: newsletter.name, imageUrl: newsletter.imageUrl || null };
}

// The account's newsletter the cookie names, else its first.
export function pickNewsletter(newsletters, id) {
	return newsletters.find(({ _id }) => String(_id) === id) ?? newsletters[0] ?? null;
}

// A page of one newsletter from anywhere: /newsletters/<id> switches to it first.
export function getNewsletterPagePath(newsletterId, path) {
	return `/newsletters/${newsletterId}?next=${encodeURIComponent(path)}`;
}

// Switching newsletters on one of a newsletter's pages opens the same section of the other one, and Design the
// other's Design. The pages of the whole account (Domains, API keys, billing) stay: null.
export function getSwitchPath(pathname) {
	if (pathname === "/" || pathname === DESIGN_PATH) return pathname;
	return NEWSLETTER_SECTIONS.find((section) => pathname === section || pathname?.startsWith(`${section}/`)) ?? null;
}
