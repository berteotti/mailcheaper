import { findDomainsWithoutMail } from "@/lib/mail-domains";
import { accountIdOf, connectDb, getAll, getOne, statement, newId } from "./db.js";
import { insertRow, updateRows } from "./records.js";
import { MAX_IMPORT_ROWS_PER_REQUEST, STATUS_RANK, sanitizeImportRow } from "./csv-import.js";
import { CONSENT_TEXT, emptyDropped, getDropReason } from "./import-checks.js";
import { NO_LANGUAGE } from "./languages.js";
import { isObjectIdString } from "./validation.js";

// Rows go in as one JSON parameter (json_each), so a statement stays within D1's 100 bound parameters
// whatever the chunk; each batch of statements commits on its own, all or nothing.
const ROWS_PER_BATCH = 500;

// Rows that only record a past unsubscribe, bounce or complaint get no emails, so they skip the checks.
function getsEmails({ status }) {
	return STATUS_RANK[status] <= STATUS_RANK.dormant;
}

function domainOf(email) {
	return email.split("@")[1];
}

// Rows that would get emails are checked; rows that only record a past unsubscribe, bounce or complaint
// always go in, so those people stay out. languages: the ones to add (codes and NO_LANGUAGE), null for all. A row in
// another language that would get emails is left out; one that records an opt-out only reaches a contact already
// there, and its bounce or complaint still suppresses the address.
export function checkImportRows(rows, { languages = null } = {}) {
	const dropped = emptyDropped();
	const byEmail = new Map();
	for (const row of rows) {
		const contact = sanitizeImportRow(row);
		if (!contact) dropped.invalid++;
		else if (byEmail.has(contact.email)) dropped.duplicate++;
		else byEmail.set(contact.email, contact);
	}
	const contacts = [];
	for (const contact of byEmail.values()) {
		const isLeftOut = languages !== null && !languages.has(contact.language ?? NO_LANGUAGE);
		const reason = getsEmails(contact) && (isLeftOut ? "language" : getDropReason(contact.email));
		if (reason) dropped[reason]++;
		else contacts.push(isLeftOut ? { ...contact, onlyExisting: true } : contact);
	}
	return { contacts, dropped };
}

// A bounce or complaint in the file suppresses the address for the whole account; a complaint outranks a
// bounce, and both outrank an unsubscribe. The suppression triggers move the account's other contacts with it.
function suppressionStatement(db, { accountId, rows, source, now }) {
	return statement(
		db,
		`INSERT INTO suppressions (_id, accountId, email, reason, detail, createdAt, updatedAt)
		SELECT lower(hex(randomblob(12))), ?, json_extract(value, '$.email'),
			CASE json_extract(value, '$.status') WHEN 'complained' THEN 'complaint' ELSE 'bounce' END, ?, ?, ?
		FROM json_each(?) WHERE json_extract(value, '$.status') IN ('bounced', 'complained')
		ON CONFLICT(accountId, email) DO UPDATE SET
			reason = CASE WHEN excluded.reason = 'complaint' OR (excluded.reason = 'bounce' AND suppressions.reason IN ('manual', 'provider'))
				THEN excluded.reason ELSE suppressions.reason END,
			detail = CASE WHEN excluded.reason = 'complaint' OR (excluded.reason = 'bounce' AND suppressions.reason IN ('manual', 'provider'))
				THEN excluded.detail ELSE suppressions.detail END,
			updatedAt = excluded.updatedAt`,
		[accountId, source, now, now, JSON.stringify(rows)]
	);
}

// One upsert for the chunk: new contacts take the file's status, existing ones keep theirs unless the file's is
// stricter. Nothing moves a contact back to active, and pending has no rank, so a contact waiting to confirm
// stays as it is. Imported engagement merges into what the contact has, and a language in the file replaces
// theirs: an empty cell never clears one. An onlyExisting row only updates a contact already there; ?2 is the
// newsletter again, so the statement keeps its bound parameters.
function contactsStatement(db, { accountId, newsletterId, rows, source, importId, now }) {
	return statement(
		db,
		`INSERT INTO contacts (_id, accountId, newsletterId, email, status, source, importId, subscribedAt, unsubscribedAt, imported, language, createdAt, updatedAt)
		SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.email'), json_extract(value, '$.status'), ?, ?,
			coalesce(json_extract(value, '$.subscribedAt'), ?),
			CASE WHEN json_extract(value, '$.status') = 'unsubscribed' THEN ? END,
			json(json_extract(value, '$.imported')), json_extract(value, '$.language'), ?, ?
		FROM json_each(?) WHERE json_extract(value, '$.onlyExisting') IS NULL
			OR EXISTS (SELECT 1 FROM contacts c WHERE c.newsletterId = ?2 AND c.email = json_extract(value, '$.email'))
		ON CONFLICT(newsletterId, email) DO UPDATE SET
			status = CASE
				WHEN contacts.status = 'pending' OR contacts.status = 'complained' THEN contacts.status
				WHEN excluded.status = 'complained' THEN 'complained'
				WHEN contacts.status = 'bounced' THEN contacts.status
				WHEN excluded.status = 'bounced' THEN 'bounced'
				WHEN contacts.status = 'unsubscribed' THEN contacts.status
				WHEN excluded.status = 'unsubscribed' THEN 'unsubscribed'
				WHEN contacts.status = 'dormant' THEN contacts.status
				ELSE excluded.status END,
			unsubscribedAt = CASE WHEN excluded.status = 'unsubscribed' AND contacts.status IN ('active', 'dormant')
				THEN excluded.unsubscribedAt ELSE contacts.unsubscribedAt END,
			imported = json_patch(contacts.imported, excluded.imported), language = coalesce(excluded.language, contacts.language),
			updatedAt = excluded.updatedAt
		RETURNING _id`,
		[accountId, newsletterId, source, importId ?? null, now, now, now, now, JSON.stringify(rows)]
	);
}

// Never deletes and never moves a contact back to a weaker status: an unsubscribe, bounce or complaint always
// wins. contacts are sanitized rows (sanitizeImportRow), one per address. An onlyExisting row that isn't a contact
// yet counts in neither created nor existing.
export async function writeContacts({ accountId, newsletterId, contacts, source = "import", importId, db }) {
	if (contacts.length === 0) return { created: 0, existing: 0 };
	db ??= await connectDb();
	accountId = accountIdOf(accountId);
	let created = 0;
	let written = 0;
	for (let offset = 0; offset < contacts.length; offset += ROWS_PER_BATCH) {
		const now = Date.now();
		const rows = contacts.slice(offset, offset + ROWS_PER_BATCH).map(({ email, status, subscribedAt, emailsReceived, openRate, clickRate, language, onlyExisting }) => ({
			id: newId(),
			email,
			status,
			subscribedAt: subscribedAt ? new Date(subscribedAt).getTime() : undefined,
			imported: Object.fromEntries(Object.entries({ emailsReceived, openRate, clickRate }).filter(([, value]) => value !== undefined)),
			language,
			onlyExisting: onlyExisting || undefined,
		}));
		const statements = [contactsStatement(db, { accountId, newsletterId, rows, source: source.trim(), importId, now })];
		if (rows.some(({ status }) => status === "bounced" || status === "complained")) {
			statements.unshift(suppressionStatement(db, { accountId, rows, source: source.trim(), now }));
		}
		const results = await db.batch(statements);
		const newIds = new Set(rows.map(({ id }) => id));
		const upserted = results.at(-1).results ?? [];
		created += upserted.filter(({ _id }) => newIds.has(_id)).length;
		written += upserted.length;
	}
	return { created, existing: written - created };
}

// Rows straight from a file or a backup, without the import checks: invalid rows and repeated addresses are
// left out and counted.
export async function importContactRows({ accountId, newsletterId, rows, source = "import", importId, db }) {
	const contacts = [...new Map(rows.map(sanitizeImportRow).filter(Boolean).map((row) => [row.email, row])).values()];
	const written = await writeContacts({ accountId, newsletterId, contacts, source, importId, db });
	return { ...written, invalid: rows.length - contacts.length };
}

// One call per chunk of a file: the first creates the import, later ones pass its importId. The dashboard
// counts duplicates across the whole file and sends them with the first chunk. Same checks for every source.
// languages: checkImportRows's.
export async function importContacts({ account, userId, apiKeyId, newsletterId, rows, consent, importId, duplicates = 0, source = "dashboard", languages = null }) {
	if (!isObjectIdString(newsletterId)) return { error: "Newsletter not found" };
	if (!Array.isArray(rows) || rows.length > MAX_IMPORT_ROWS_PER_REQUEST) return { error: "Too many rows" };
	const accountId = accountIdOf(account);
	const newsletter = await getOne("SELECT _id FROM newsletters WHERE accountId = ? AND _id = ?", [accountId, newsletterId.toLowerCase()]);
	if (!newsletter) return { error: "Newsletter not found" };
	if (consent !== true) return { error: "Confirm that these people agreed to receive your emails" };

	let contactImport;
	if (importId) {
		contactImport = isObjectIdString(importId)
			? await getOne("SELECT _id FROM contact_imports WHERE accountId = ? AND _id = ? AND newsletterId = ?", [
					accountId,
					String(importId).toLowerCase(),
					newsletter._id,
				])
			: null;
		if (!contactImport) return { error: "Import not found" };
	} else {
		contactImport = await insertRow("contact_imports", {
			accountId,
			newsletterId: newsletter._id,
			userId: userId ?? undefined,
			apiKeyId: apiKeyId ? String(apiKeyId) : undefined,
			source,
			consent: true,
			consentText: CONSENT_TEXT,
			consentAt: new Date(),
		});
	}

	const checked = checkImportRows(rows, { languages });
	const dropped = { ...checked.dropped, duplicate: checked.dropped.duplicate + Math.max(0, Math.floor(Number(duplicates) || 0)) };
	const suppressedEmails = new Set(
		(
			await getAll("SELECT email FROM suppressions WHERE accountId = ? AND email IN (SELECT value FROM json_each(?))", [
				accountId,
				JSON.stringify(checked.contacts.filter(getsEmails).map(({ email }) => email)),
			])
		).map(({ email }) => email)
	);
	const unsuppressed = checked.contacts.filter((contact) => !getsEmails(contact) || !suppressedEmails.has(contact.email));
	dropped.suppressed += checked.contacts.length - unsuppressed.length;
	// Every email to a domain without a mail server bounces, and bounces count against the account.
	const domainsWithoutMail = await findDomainsWithoutMail(unsuppressed.filter(getsEmails).map(({ email }) => domainOf(email)));
	const contacts = unsuppressed.filter((contact) => !getsEmails(contact) || !domainsWithoutMail.has(domainOf(contact.email)));
	dropped.noMail += unsuppressed.length - contacts.length;

	const written = await writeContacts({ accountId, newsletterId: newsletter._id, contacts, source: "import", importId: contactImport._id });
	dropped.language += contacts.length - written.created - written.existing;
	await updateRows(
		"contact_imports",
		{ where: "accountId = ? AND _id = ?", params: [accountId, contactImport._id] },
		{
			inc: {
				rows: rows.length,
				created: written.created,
				existing: written.existing,
				...Object.fromEntries(Object.entries(dropped).map(([reason, count]) => [`dropped.${reason}`, count])),
			},
		}
	);
	return { importId: String(contactImport._id), ...written, dropped };
}
