import { withEngagement } from "@/lib/cleanup";
import { accountIdOf, connectDb, getAll, getOne, json, newId, statement } from "@/lib/db";
import { getSignupEmailProblem } from "@/lib/import-checks";
import { findDomainsWithoutMail } from "@/lib/mail-domains";
import { CONTACT_STATUSES } from "@/lib/statuses";

export const CONTACTS_PAGE_SIZE = 50;

// Signup forms, add_contact and MCP, for one normalized address: what to tell the person typing it, or null.
export async function getSignupProblem(email) {
	const problem = getSignupEmailProblem(email);
	if (problem) return problem;
	const withoutMail = await findDomainsWithoutMail([email.split("@")[1]]);
	return withoutMail.size > 0 ? "This email's domain can't receive email" : null;
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

// An account's newsletters in creation order with their active contacts, counted from the index in the
// same round trip. fields: the columns to read ("name slug"), all of them by default.
export function listNewslettersWithActiveCounts(account, fields) {
	const names = fields ? ["_id", ...fields.split(" ").filter((field) => FIELD.test(field) && field !== "_id")] : null;
	const columns = names ? names.map((name) => `n.${name}`).join(", ") : "n.*";
	return getAll(
		`SELECT ${columns}, (SELECT count(*) FROM contacts c WHERE c.accountId = n.accountId AND c.newsletterId = n._id AND c.status = 'active') AS activeCount
		FROM newsletters n WHERE n.accountId = ? ORDER BY n.createdAt, n._id`,
		[accountIdOf(account)]
	);
}

// The contacts list's filters: a newsletter, the start of an email address and a language, as a WHERE condition on
// contacts. Addresses are lowercase ASCII mostly; a range on the index finds every one that starts with the query.
// A contact without a language is in its newsletter's.
export function contactSearchFilter(account, { newsletterId, query, language }) {
	const clauses = ["accountId = ?"];
	const params = [accountIdOf(account)];
	if (newsletterId) {
		clauses.push("newsletterId = ?");
		params.push(String(newsletterId).toLowerCase());
	}
	if (query) {
		clauses.push("email >= ? AND email < ?");
		params.push(query, `${query}￿`);
	}
	if (language) {
		clauses.push("coalesce(language, (SELECT n.language FROM newsletters n WHERE n._id = contacts.newsletterId)) = ?");
		params.push(language);
	}
	return { where: clauses.join(" AND "), params };
}

// Every status, counted for a contactSearchFilter in one pass over the index.
export async function countContactsByStatus({ where, params }) {
	const rows = await getAll(`SELECT status, count(*) AS count FROM contacts WHERE ${where} GROUP BY status`, params);
	return Object.fromEntries(CONTACT_STATUSES.map((key) => [key, rows.find((row) => row.status === key)?.count ?? 0]));
}

// One page of the contacts list, newest first, with every status counted for the same filters.
export async function findContactsPage(account, { newsletterId, status, query, language, page = 1 }) {
	const filter = contactSearchFilter(account, { newsletterId, query, language });
	const [counts, contacts] = await Promise.all([
		countContactsByStatus(filter),
		getAll(
			`SELECT * FROM contacts WHERE ${filter.where}${status ? " AND status = ?" : ""}
			ORDER BY subscribedAt DESC, _id DESC LIMIT ? OFFSET ?`,
			[...filter.params, ...(status ? [status] : []), CONTACTS_PAGE_SIZE, (page - 1) * CONTACTS_PAGE_SIZE]
		),
	]);
	const totalAll = Object.values(counts).reduce((sum, count) => sum + count, 0);
	return { contacts, counts, totalAll, total: status ? counts[status] || 0 : totalAll };
}

const NOT_SUPPRESSED = "NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.accountId = contacts.accountId AND s.email = contacts.email)";

// consent: a dashboard user's word that the person agreed, which stands in for the confirmation email.
// A suppressed address goes in with the suppression's status (contacts_insert_suppressed trigger), and only an
// explicit resubscribe reverses an opt-out; bounces and complaints never reverse.
// language: a new contact's, or null for the newsletter's.
export async function upsertContact({ newsletter, email, source, resubscribe, consent, language = null }) {
	const accountId = accountIdOf(newsletter);
	const joinStatus = newsletter.requireConfirmation && !consent ? "pending" : "active";
	const now = new Date();
	const inserted = await getOne(
		`INSERT INTO contacts (_id, accountId, newsletterId, email, status, source, consent, language, subscribedAt, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(newsletterId, email) DO NOTHING RETURNING _id`,
		[newId(), accountId, newsletter._id, email, joinStatus, source?.trim() || null, consent ? json(consent) : null, language, now, now, now]
	);
	const created = Boolean(inserted);
	if (!created && resubscribe) {
		// Signing up again is a sign of life, and brings back a contact who left or went dormant.
		const engagement = withEngagement(now);
		await getOne(
			`UPDATE contacts SET ${engagement.sql},
			status = CASE WHEN status = 'active' THEN status ELSE ? END,
			subscribedAt = CASE WHEN status = 'active' THEN subscribedAt ELSE ? END,
			unsubscribedAt = NULL, updatedAt = ?
			WHERE accountId = ? AND newsletterId = ? AND email = ? AND status IN ('active', 'unsubscribed', 'dormant')
			AND ${NOT_SUPPRESSED} RETURNING _id`,
			[...engagement.params, joinStatus, now, now, accountId, newsletter._id, email]
		);
	}
	const contact = await getOne("SELECT * FROM contacts WHERE accountId = ? AND newsletterId = ? AND email = ?", [
		accountId,
		newsletter._id,
		email,
	]);
	return { contact, created };
}

// The click on the confirmation link. A contact that already confirmed stays as it is.
export async function confirmContact({ accountId, contactId, newsletterId }) {
	const now = new Date();
	const engagement = withEngagement(now);
	const confirmed = await getOne(
		`UPDATE contacts SET status = 'active', confirmedAt = ?, ${engagement.sql}, updatedAt = ?
		WHERE accountId = ? AND _id = ? AND newsletterId = ? AND status = 'pending' AND ${NOT_SUPPRESSED} RETURNING *`,
		[now, ...engagement.params, now, accountIdOf(accountId), contactId, newsletterId]
	);
	if (confirmed) return { contact: confirmed, confirmed: true };
	const contact = await getOne("SELECT * FROM contacts WHERE accountId = ? AND _id = ? AND newsletterId = ?", [
		accountIdOf(accountId),
		contactId,
		newsletterId,
	]);
	return { contact, confirmed: false };
}

// The "Yes, keep sending it" click in the last-chance email. It also brings back a contact who went
// dormant; unsubscribes, bounces and complaints stay as they are.
export async function keepContact({ accountId, contactId, newsletterId }) {
	const now = new Date();
	const engagement = withEngagement(now);
	return getOne(
		`UPDATE contacts SET status = 'active', ${engagement.sql}, updatedAt = ?
		WHERE accountId = ? AND _id = ? AND newsletterId = ? AND status IN ('active', 'dormant') AND ${NOT_SUPPRESSED} RETURNING *`,
		[...engagement.params, now, accountIdOf(accountId), contactId, newsletterId]
	);
}

// Bounced and complained contacts stay as they are: those statuses also block sending.
const SUBSCRIBED_STATUSES_SQL = "('active', 'dormant')";
const RECENT_CAMPAIGNS = 5;

// The unsubscribe link's signed token names the contact, so it's found whatever the account; unsubscribing
// always works, even for an account that canceled. Links don't carry the campaign, so the unsubscribe counts
// for the latest of the newsletter's recent campaigns sent to them. The counter and the opt-out commit
// together, and retrying an opted-out contact credits nothing. Returns whether the contact unsubscribed now.
export async function unsubscribeContact({ contactId, newsletterId }) {
	const db = await connectDb();
	const now = new Date();
	const [, result] = await db.batch([
		statement(
			db,
			`UPDATE campaigns SET stats = json_set(stats, '$.unsubscribed', coalesce(json_extract(stats, '$.unsubscribed'), 0) + 1), updatedAt = ?
			WHERE _id = (SELECT c._id FROM (SELECT _id, startedAt FROM campaigns
					WHERE accountId = (SELECT accountId FROM contacts WHERE _id = ?) AND newsletterId = ? AND startedAt IS NOT NULL
					ORDER BY startedAt DESC LIMIT ${RECENT_CAMPAIGNS}) c
				JOIN messages m ON m.campaignId = c._id
				WHERE m.contactId = ? AND m.kind = 'campaign' AND m.sentAt IS NOT NULL ORDER BY c.startedAt DESC LIMIT 1)
			AND EXISTS (SELECT 1 FROM contacts WHERE _id = ? AND newsletterId = ? AND status IN ${SUBSCRIBED_STATUSES_SQL})`,
			[now, contactId, newsletterId, contactId, contactId, newsletterId]
		),
		statement(
			db,
			`UPDATE contacts SET status = 'unsubscribed', unsubscribedAt = ?, updatedAt = ?
			WHERE _id = ? AND newsletterId = ? AND status IN ${SUBSCRIBED_STATUSES_SQL}`,
			[now, now, contactId, newsletterId]
		),
	]);
	const unsubscribed = (result?.meta?.changes ?? 0) > 0;
	if (unsubscribed) console.log(`[unsubscribe] Contact ${contactId} unsubscribed from newsletter ${newsletterId}`);
	return unsubscribed;
}
