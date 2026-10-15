import { getOne } from "./db.js";

// By unique key, whatever the account: for jobs, signed email links and other callers that already hold the
// newsletter's id from a row of the same account (a campaign, a contact, a signed token). Account-facing lookups go
// through lib/actions/shared.js findNewsletter(account, reference) or lib/selected-newsletter.js.
export function findNewsletter(id) {
	return getOne("SELECT * FROM newsletters WHERE _id = lower(?)", [String(id ?? "")]);
}

export function findNewsletterBySlug(slug) {
	return getOne("SELECT * FROM newsletters WHERE slug = ?", [slug]);
}
