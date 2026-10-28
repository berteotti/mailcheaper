import { withEngagement } from "@/lib/cleanup";
import { accountIdOf, connectDb, getAll, getOne, json, newId, statement } from "@/lib/db";
import { getEmailSuggestion } from "@/lib/email-typos";
import { getSignupEmailProblem } from "@/lib/import-checks";
import { splitLanguage } from "@/lib/languages";
import { findDomainsWithoutMail } from "@/lib/mail-domains";
import { mailboxProvider } from "@/lib/providers";
import { CONTACT_STATUSES } from "@/lib/statuses";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";

export const CONTACTS_PAGE_SIZE = 50;
// Contacts who get emails, or could again: the ones the address check looks at, and the only ones that can be deleted.
// An unsubscribed contact is what keeps a later import from adding the person back.
export const LIVE_STATUSES = ["active", "pending", "dormant"];
export const UNREACHABLE_REASONS = ["invalid", "typo", "noMail"];
// Each domain takes up to three DNS lookups, so a page of the check looks up as many as an import's chunk can.
const DOMAINS_PER_CHECK = 100;

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

// A contact's language as a tag (pt-BR), or its newsletter's while it has none.
const LANGUAGE_TAG = `CASE WHEN language IS NOT NULL THEN language || coalesce('-' || languageRegion, '')
	ELSE (SELECT n.language || coalesce('-' || n.languageRegion, '') FROM newsletters n WHERE n._id = contacts.newsletterId) END`;

// The contacts list's filters: a newsletter, the start of an email address and a language, as a WHERE condition on
// contacts. Addresses are lowercase ASCII mostly; a range on the index finds every one that starts with the query.
// A language without a region finds its regional variants too: pt finds pt-BR.
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
		const isBase = !splitLanguage(language).languageRegion;
		clauses.push(isBase ? `(${LANGUAGE_TAG} = ? OR ${LANGUAGE_TAG} LIKE ?)` : `${LANGUAGE_TAG} = ?`);
		params.push(language, ...(isBase ? [`${language}-%`] : []));
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
// language: a new contact's, or null for the newsletter's. firstName and lastName: a new contact's, normalized.
export async function upsertContact({ newsletter, email, source, resubscribe, consent, language = null, firstName = null, lastName = null }) {
	const accountId = accountIdOf(newsletter);
	const joinStatus = newsletter.requireConfirmation && !consent ? "pending" : "active";
	const { language: baseLanguage, languageRegion } = splitLanguage(language);
	const now = new Date();
	const inserted = await getOne(
		`INSERT INTO contacts (_id, accountId, newsletterId, email, status, source, consent, firstName, lastName, language, languageRegion, subscribedAt, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(newsletterId, email) DO NOTHING RETURNING _id`,
		[
			newId(),
			accountId,
			newsletter._id,
			email,
			joinStatus,
			source?.trim() || null,
			consent ? json(consent) : null,
			firstName,
			lastName,
			baseLanguage,
			languageRegion,
			now,
			now,
			now,
		]
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

// Contacts in the list's order, cut where looking up their domains would pass DOMAINS_PER_CHECK: the ones checked,
// and each of those whose address can't get email, with why. Big mailbox providers are never looked up, so a page
// usually checks every contact it's given.
export async function checkContactAddresses(contacts) {
	const domains = new Set();
	let end = 0;
	for (; end < contacts.length; end++) {
		const domain = contacts[end].email.split("@")[1];
		if (domains.has(domain) || mailboxProvider(contacts[end].email) !== "other") continue;
		if (domains.size === DOMAINS_PER_CHECK) break;
		domains.add(domain);
	}
	const checked = contacts.slice(0, end);
	const withoutMail = await findDomainsWithoutMail([...domains]);
	const unreachable = [];
	for (const contact of checked) {
		const isValid = Boolean(normalizeEmail(contact.email));
		const suggestion = isValid ? getEmailSuggestion(contact.email) : null;
		const reason = !isValid ? "invalid" : suggestion ? "typo" : withoutMail.has(contact.email.split("@")[1]) ? "noMail" : null;
		if (reason) unreachable.push({ contact, reason, suggestion });
	}
	return { checked, unreachable };
}

// An email still going out, or a bounce or complaint the account's sending rates count (lib/account-health.js),
// keeps its contact: deleting it would take its emails along.
const KEEPS_CONTACT = `EXISTS (SELECT 1 FROM messages m WHERE m.accountId = contacts.accountId AND m.contactId = contacts._id
	AND (m.status IN ('held', 'queued', 'sending', 'ambiguous') OR m.bouncedAt IS NOT NULL OR m.complainedAt IS NOT NULL))`;

const LIVE_STATUSES_SQL = LIVE_STATUSES.map((status) => `'${status}'`).join(", ");

// The account's contacts that ids or emails name, in one newsletter or in any: a WHERE condition on contacts. An
// address that's a contact of several newsletters names each.
function namedContactsFilter(account, { ids = [], emails = [], newsletterId }) {
	const clauses = ["accountId = ?", "(_id IN (SELECT value FROM json_each(?)) OR email IN (SELECT value FROM json_each(?)))"];
	const params = [
		accountIdOf(account),
		JSON.stringify([...new Set(ids.map((id) => String(id).toLowerCase()).filter(isObjectIdString))]),
		JSON.stringify([...new Set(emails.map((email) => String(email).trim().toLowerCase()))]),
	];
	if (newsletterId) {
		clauses.push("newsletterId = ?");
		params.push(String(newsletterId).toLowerCase());
	}
	return { where: clauses.join(" AND "), params };
}

// The IDs and addresses that named none of the contacts found.
function findUnnamed({ ids = [], emails = [] }, found) {
	const foundIds = new Set(found.map(({ _id }) => String(_id)));
	const foundEmails = new Set(found.map(({ email }) => email));
	return [
		...new Set([
			...ids.filter((id) => !foundIds.has(String(id).toLowerCase())),
			...emails.map((email) => String(email).trim().toLowerCase()).filter((email) => !foundEmails.has(email)),
		]),
	];
}

// For good, with their emails and those emails' events, in one transaction (D1's foreign keys restrict deletes, so
// children go first). Of the contacts that ids or emails name (namedContactsFilter): those deleted, those kept (see
// LIVE_STATUSES and KEEPS_CONTACT), and the IDs and addresses that aren't contacts.
export async function deleteContacts(account, { ids, emails, newsletterId } = {}) {
	const accountId = accountIdOf(account);
	const named = namedContactsFilter(account, { ids, emails, newsletterId });
	const deletable = `SELECT _id FROM contacts WHERE ${named.where} AND status IN (${LIVE_STATUSES_SQL}) AND NOT ${KEEPS_CONTACT}`;
	const db = await connectDb();
	const [found, , , deleted] = await db.batch([
		statement(db, `SELECT _id, email FROM contacts WHERE ${named.where}`, named.params),
		statement(
			db,
			`DELETE FROM events WHERE accountId = ? AND messageId IN (SELECT _id FROM messages WHERE accountId = ? AND contactId IN (${deletable}))`,
			[accountId, accountId, ...named.params]
		),
		statement(db, `DELETE FROM messages WHERE accountId = ? AND contactId IN (${deletable})`, [accountId, ...named.params]),
		// A contact kept still has the emails that kept it.
		statement(
			db,
			`DELETE FROM contacts WHERE ${named.where} AND status IN (${LIVE_STATUSES_SQL})
			AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.accountId = contacts.accountId AND m.contactId = contacts._id) RETURNING _id`,
			named.params
		),
	]);
	const deletedIds = new Set((deleted.results ?? []).map(({ _id }) => String(_id)));
	return {
		deleted: [...deletedIds],
		kept: (found.results ?? []).map(({ _id }) => String(_id)).filter((id) => !deletedIds.has(id)),
		notFound: findUnnamed({ ids, emails }, found.results ?? []),
	};
}

// What a status change needs of a contact, for a contact to take it: the one it has already, or one it can leave
// for it. Bounced and complained contacts never change, and a suppressed address is never reactivated.
const CAN_TAKE_STATUS = {
	unsubscribed: `status IN (${LIVE_STATUSES_SQL}, 'unsubscribed')`,
	active: `(status = 'active' OR (status = 'dormant' AND ${NOT_SUPPRESSED}))`,
};

// The contacts that ids or emails name, unsubscribed or reactivated (status, as update_contact_status changes one)
// and given a language (a tag, null for the newsletter's, undefined to leave it), in one transaction. A contact takes
// every change or none: one whose status can't change is skipped, language too.
export async function updateContacts(account, { ids, emails, newsletterId } = {}, { status, language }) {
	const named = namedContactsFilter(account, { ids, emails, newsletterId });
	const canTake = CAN_TAKE_STATUS[status] ?? "1";
	const now = new Date();
	const db = await connectDb();
	const statements = [statement(db, `SELECT _id, email, ${canTake} AS canTake FROM contacts WHERE ${named.where}`, named.params)];
	if (language !== undefined) {
		const { language: baseLanguage, languageRegion } = splitLanguage(language);
		statements.push(
			statement(
				db,
				`UPDATE contacts SET language = ?, languageRegion = ?, updatedAt = ?
				WHERE ${named.where} AND ${canTake} AND (language IS NOT ? OR languageRegion IS NOT ?) RETURNING _id`,
				[baseLanguage, languageRegion, now, ...named.params, baseLanguage, languageRegion]
			)
		);
	}
	if (status === "unsubscribed") {
		statements.push(
			statement(
				db,
				`UPDATE contacts SET status = 'unsubscribed', unsubscribedAt = ?, updatedAt = ? WHERE ${named.where} AND status IN (${LIVE_STATUSES_SQL}) RETURNING _id`,
				[now, now, ...named.params]
			)
		);
	} else if (status === "active") {
		// Reactivation starts the list cleanup over, or the next send would make them dormant again.
		const engagement = withEngagement(now);
		statements.push(
			statement(
				db,
				`UPDATE contacts SET status = 'active', ${engagement.sql}, updatedAt = ?
				WHERE ${named.where} AND status = 'dormant' AND ${NOT_SUPPRESSED} RETURNING _id`,
				[...engagement.params, now, ...named.params]
			)
		);
	}
	const [found, ...changes] = await db.batch(statements);
	const rows = found.results ?? [];
	const updated = new Set(changes.flatMap(({ results }) => (results ?? []).map(({ _id }) => String(_id))));
	return {
		updated: [...updated],
		unchanged: rows.filter((row) => row.canTake && !updated.has(String(row._id))).map(({ _id }) => String(_id)),
		skipped: rows.filter((row) => !row.canTake).map(({ _id }) => String(_id)),
		notFound: findUnnamed({ ids, emails }, rows),
	};
}
