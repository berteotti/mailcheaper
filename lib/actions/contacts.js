import "server-only";
import { after } from "next/server";
import * as z from "zod";
import { ERROR_CODES, hasActiveSubscription } from "@/lib/account-state";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, encodeCursor, findNewsletter, newsletterFilterInput, newsletterInput, readLanguage, toIso } from "@/lib/actions/shared";
import { sendAlert } from "@/lib/alerts";
import { withEngagement } from "@/lib/cleanup";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { importContacts as importContactRows } from "@/lib/contact-import";
import {
	CONTACT_SORTS,
	DEFAULT_CONTACT_SORT,
	LIVE_STATUSES,
	UNREACHABLE_REASONS,
	checkContactAddresses,
	contactOrder,
	contactSearchFilter,
	contactsAfter,
	countContactsByStatus,
	deleteContacts as deleteContactRows,
	getSignupProblem,
	updateContacts as updateContactRows,
	upsertContact,
} from "@/lib/contacts";
import { getAll, getOne, getValue } from "@/lib/db";
import { MAX_IMPORT_ROWS_PER_REQUEST, STATUS_RANK } from "@/lib/csv-import";
import { createExportToken } from "@/lib/export-token";
import { formatNumber, formatWindow } from "@/lib/format";
import { CONSENT_TEXT, DROP_REASONS } from "@/lib/import-checks";
import { getInbox } from "@/lib/inbox-links";
import { NO_LANGUAGE, getLanguageTag, splitLanguage } from "@/lib/languages";
import { isRateLimited } from "@/lib/rate-limit";
import { queueConfirmationEmail, queueWelcomeEmail } from "@/lib/sending";
import { CONTACT_STATUSES } from "@/lib/statuses";
import { MAX_NAME_LENGTH, isObjectIdString, normalizeEmail, normalizeName } from "@/lib/validation";

const GROUP = "Contacts";
// Each signup can send a welcome email, so a leaked key or a form without its own limit must not be
// able to flood the list. Sites that pass their visitor's IP get the archive form's per-visitor limit.
const SIGNUPS_PER_KEY = { name: "api-contacts-key", limit: 600, window: "1 h" };
const SIGNUPS_PER_VISITOR = { name: "api-contacts-ip", limit: 5, window: "10 m" };
// And an account gets a key's signups across all its keys, connected apps and contacts added by hand, who get the
// welcome email too.
const SIGNUPS_PER_ACCOUNT = { ...SIGNUPS_PER_KEY, name: "account-signups" };
// Enough to add yourself and try the dashboard without a plan, not enough to build a list for free.
const TRIAL_CONTACTS = { name: "contact-trial", limit: 5, window: "1 d" };
const IP_PATTERN = /^[0-9a-f.:]{3,45}$/i;
// Contacts read per page of find_unreachable_contacts, before its cut on domains to look up.
const CHECK_PAGE_SIZE = 1000;
// IDs and addresses per call of update_contacts and delete_contacts, together.
const MAX_CONTACTS_PER_CHANGE = 100;

const contactReference = z.string().trim().min(1).max(320).describe("The contact's ID or email address");
const contactNewsletterInput = newsletterFilterInput.describe(
	"The newsletter's ID or slug, needed for an email address that is a contact of several newsletters"
);
const searchInput = z.string().trim().toLowerCase().max(254).optional().describe("Contacts whose email starts with this");
const statusInput = z.enum(CONTACT_STATUSES).optional().describe("Only contacts with this status");
const nameInput = (which) => z.string().trim().max(MAX_NAME_LENGTH).describe(`The contact's ${which} name`);
const languageFilterInput = z
	.string()
	.trim()
	.max(40)
	.optional()
	.describe(
		"Only contacts in this language, a code like fr or pt-BR. pt finds pt-BR and pt-PT too, unless exactLanguage. Contacts without one are in their newsletter's language."
	);
const exactLanguageInput = z.boolean().optional().describe("true: language finds that tag alone, so pt leaves out pt-BR and pt-PT");

// The contacts update_contacts and delete_contacts change.
const namedContactsInput = {
	ids: z.array(z.string().trim().min(1).max(100)).max(MAX_CONTACTS_PER_CHANGE).optional().describe("The contacts' IDs"),
	emails: z
		.array(z.string().trim().toLowerCase().min(1).max(320))
		.max(MAX_CONTACTS_PER_CHANGE)
		.optional()
		.describe("The contacts' email addresses"),
	newsletter: newsletterFilterInput.describe(
		"Only this newsletter's contacts: its ID or slug. Default: every newsletter's, so an address that's a contact of several changes in each."
	),
};
const notFoundOutput = z.array(z.string()).describe("The IDs and addresses given that aren't contacts");

const ContactSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	email: z.string(),
	firstName: z.string().nullable(),
	lastName: z.string().nullable(),
	status: z
		.enum(CONTACT_STATUSES)
		.describe(
			"active: gets issues. pending: hasn't confirmed yet. dormant: stopped by the list cleanup, back if they sign up again. unsubscribed, bounced, complained: final."
		),
	source: z.string().nullable(),
	language: z.string().nullable().describe("A language code like fr or pt-BR, or null while the newsletter's language applies"),
	subscribedAt: dateOutput,
	confirmedAt: dateOutput,
	unsubscribedAt: dateOutput,
	lastSentAt: dateOutput,
	lastOpenAt: dateOutput,
	lastClickAt: dateOutput,
	stats: z.object({ sent: z.number().int(), opens: z.number().int(), clicks: z.number().int() }),
	createdAt: dateOutput,
	updatedAt: dateOutput.describe("When anything about the contact last changed, opens and clicks included"),
});

function toContact(contact) {
	return {
		id: String(contact._id),
		newsletterId: String(contact.newsletterId),
		email: contact.email,
		firstName: contact.firstName ?? null,
		lastName: contact.lastName ?? null,
		status: contact.status,
		source: contact.source ?? null,
		language: getLanguageTag(contact),
		subscribedAt: toIso(contact.subscribedAt),
		confirmedAt: toIso(contact.confirmedAt),
		unsubscribedAt: toIso(contact.unsubscribedAt),
		lastSentAt: toIso(contact.lastSentAt),
		lastOpenAt: toIso(contact.lastOpenAt),
		lastClickAt: toIso(contact.lastClickAt),
		stats: { sent: contact.stats?.sent ?? 0, opens: contact.stats?.opens ?? 0, clicks: contact.stats?.clicks ?? 0 },
		createdAt: toIso(contact.createdAt),
		updatedAt: toIso(contact.updatedAt),
	};
}

// A list_contacts cursor: the last contact's sort value and ID, with the sort it's in.
function encodeContactCursor({ sort, order }, contact) {
	return Buffer.from(JSON.stringify({ sort, order, value: contact.sortValue, id: String(contact._id) })).toString("base64url");
}

// The contacts after a list_contacts cursor, which only goes on in the sort it came from. An array is encodeCursor's
// subscribedAt and ID, newest first: find_unreachable_contacts' cursors, and list_contacts' from before sorts.
function afterCursor(cursor, { sort, order }) {
	try {
		const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		const position = Array.isArray(decoded)
			? { sort: DEFAULT_CONTACT_SORT, order: "desc", value: new Date(decoded[0]).getTime(), id: decoded[1] }
			: decoded;
		const isValue = typeof position.value === "string" || Number.isFinite(position.value);
		if (position.sort === sort && position.order === order && isValue && isObjectIdString(position.id)) {
			return contactsAfter({ sort, order, value: position.value, id: position.id.toLowerCase() });
		}
	} catch {
		// Falls through to the error below.
	}
	throw actionError("validation_failed", "cursor: use the nextCursor of the previous page, with the same sort and order");
}

// By ID or by address; an address in several newsletters needs the newsletter.
async function findContact(account, reference, newsletterReference) {
	const value = reference.toLowerCase();
	const newsletter = newsletterReference ? await findNewsletter(account, newsletterReference) : null;
	const [contact, other] = await getAll(
		`SELECT * FROM contacts WHERE accountId = ? AND ${isObjectIdString(value) ? "_id" : "email"} = ?${newsletter ? " AND newsletterId = ?" : ""}
		ORDER BY createdAt, _id LIMIT 2`,
		[String(account._id), isObjectIdString(value) ? value : (normalizeEmail(value) ?? value), ...(newsletter ? [String(newsletter._id)] : [])]
	);
	if (!contact) throw actionError("not_found", "Contact not found");
	if (other) throw actionError("validation_failed", "newsletter is required: this address is a contact of several newsletters");
	return contact;
}

// The contacts namedContactsInput names, for lib/contacts.js.
async function readNamedContacts(account, { ids = [], emails = [], newsletter }) {
	const count = ids.length + emails.length;
	if (count === 0 || count > MAX_CONTACTS_PER_CHANGE) {
		throw actionError("validation_failed", `Pass ids or emails, ${MAX_CONTACTS_PER_CHANGE} in all at most`);
	}
	const newsletterId = newsletter ? (await findNewsletter(account, newsletter, "_id"))._id : null;
	return { ids, emails, newsletterId };
}

// The key's and the visitor's limits first: a flood they stop doesn't use up the account's signups.
async function signupLimitProblem({ account, apiKey, connection, ip, via }) {
	const caller = apiKey ? String(apiKey._id) : connection && `oauth-${connection.id}`;
	if (apiKey && (await isRateLimited({ ...SIGNUPS_PER_KEY, key: caller }))) {
		await sendAlert({
			accountId: account._id,
			key: `api-signup-flood:${caller}`,
			title: "API signups paused",
			detail: `The "${apiKey.name}" key sent over ${SIGNUPS_PER_KEY.limit} signups in an hour. New ones are refused until it slows down. If that isn't your site, revoke the key.`,
			path: "/api-keys",
		});
		return "Too many signups, try again later";
	}
	if (caller && ip && (await isRateLimited({ ...SIGNUPS_PER_VISITOR, key: `${caller}:${ip}` }))) {
		return "Too many signups from this visitor, try again later";
	}
	if (!(await isRateLimited({ ...SIGNUPS_PER_ACCOUNT, key: String(account._id) }))) return null;
	if (via === "dashboard") return `You can add ${formatNumber(SIGNUPS_PER_ACCOUNT.limit)} contacts ${formatWindow(SIGNUPS_PER_ACCOUNT.window)}. Try again later.`;
	await sendAlert({
		accountId: account._id,
		key: "account-signup-flood",
		title: "Signups paused",
		detail: `Your API keys, connected apps and the dashboard added over ${SIGNUPS_PER_ACCOUNT.limit} contacts in an hour. New signups are refused until it slows down. If that isn't you, revoke the key or app on the API keys page.`,
		path: "/api-keys",
	});
	return "Too many signups on this account, try again later";
}

const listContacts = defineAction({
	name: "list_contacts",
	tryWithoutPlan: true,
	title: "List contacts",
	group: GROUP,
	description:
		"Lists contacts, newest signups first unless sorted, 50 a page. Filter by newsletter, status, language or the start of the email address; pass nextCursor back as cursor for the next page, with the same sort. counts has every status for the same filters.",
	http: { method: "GET", path: "/contacts" },
	readOnly: true,
	example: { status: "active", search: "jane" },
	input: z.object({
		newsletter: newsletterFilterInput,
		status: statusInput,
		search: searchInput,
		language: languageFilterInput,
		exactLanguage: exactLanguageInput,
		sort: z
			.enum(Object.keys(CONTACT_SORTS))
			.optional()
			.describe(
				"What to sort by. subscribedAt by default. name is the first and last name, else the address; status goes active, pending, unsubscribed, bounced, complained, dormant; language goes by its English name."
			),
		order: z
			.enum(["asc", "desc"])
			.optional()
			.describe("asc or desc. Default: desc for subscribedAt, updatedAt, opens and clicks, asc for the others"),
		limit: z.number().int().min(1).max(100).optional().describe("Contacts per page, 50 by default, 100 at most"),
		cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({
		contacts: z.array(ContactSchema),
		nextCursor: z.string().nullable().describe("null on the last page"),
		counts: z.object(Object.fromEntries(CONTACT_STATUSES.map((status) => [status, z.number().int()]))),
	}),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter) : null;
		const limit = input.limit ?? 50;
		const baseFilter = contactSearchFilter(account, {
			newsletterId: newsletter?._id,
			query: input.search,
			language: readLanguage(input.language),
			exactLanguage: input.exactLanguage,
		});
		const sort = input.sort ?? DEFAULT_CONTACT_SORT;
		const order = input.order ?? CONTACT_SORTS[sort].order;
		const cursor = input.cursor ? afterCursor(input.cursor, { sort, order }) : null;
		const [contacts, counts] = await Promise.all([
			getAll(
				`SELECT *, ${CONTACT_SORTS[sort].sql} AS sortValue FROM contacts
				WHERE ${baseFilter.where}${input.status ? " AND status = ?" : ""}${cursor ? ` AND ${cursor.sql}` : ""}
				ORDER BY ${contactOrder(sort, order)} LIMIT ?`,
				[...baseFilter.params, ...(input.status ? [input.status] : []), ...(cursor?.params ?? []), limit + 1]
			),
			countContactsByStatus(baseFilter),
		]);
		const page = contacts.slice(0, limit);
		const last = page.at(-1);
		return {
			contacts: page.map(toContact),
			nextCursor: contacts.length > limit ? encodeContactCursor({ sort, order }, last) : null,
			counts,
		};
	},
});

const getContact = defineAction({
	name: "get_contact",
	tryWithoutPlan: true,
	title: "Get a contact",
	group: GROUP,
	description: "Gets one contact by ID or email address, with its status, dates and engagement.",
	http: { method: "GET", path: "/contacts/{id}" },
	readOnly: true,
	input: z.object({ id: contactReference, newsletter: contactNewsletterInput }),
	output: ContactSchema,
	handler: async ({ account, input }) => toContact(await findContact(account, input.id, input.newsletter)),
});

const addContact = defineAction({
	name: "add_contact",
	tryWithoutPlan: true,
	title: "Add a contact",
	group: GROUP,
	description:
		"Signs someone up, like the archive's form: they get the welcome email, or the confirmation email when the newsletter asks new subscribers to confirm. Signing up again keeps the contact as it is unless resubscribe is true. Works with signups only keys, for website forms. Signups keep coming in over the plan's limits. A misspelled domain (gmial.com) answers validation_failed with the address it was likely meant to be; spam trap addresses and domains that can't receive email answer validation_failed too.",
	http: { method: "POST", path: "/contacts", status: (output) => (output.created ? 201 : 200) },
	permission: "signups",
	openWorld: true,
	example: { email: "jane@example.com", firstName: "Jane", source: "website" },
	input: z.object({
		newsletter: newsletterInput,
		email: z.string().trim().max(320).describe("The subscriber's email address"),
		firstName: nameInput("first").optional().describe("A new contact's first name"),
		lastName: nameInput("last").optional().describe("A new contact's last name"),
		source: z.string().trim().max(100).optional().describe("Where they signed up, e.g. website. Default: api."),
		language: z
			.string()
			.trim()
			.max(40)
			.optional()
			.describe(
				"A new contact's language, a code like fr or pt-BR. A region MailCheap doesn't tell apart is dropped (pt-AO is pt). Without one, the newsletter's applies. update_contact_language changes it later."
			),
		resubscribe: z
			.boolean()
			.optional()
			.describe("Bring back a contact who unsubscribed or went dormant. Bounced and complained addresses never come back."),
		ip: z.string().trim().max(45).optional().describe("The visitor's IP address: one visitor gets 5 signups in 10 minutes"),
	}),
	// Add contact's "This person agreed to get my emails" box: added by hand, they skip the confirmation email.
	dashboardInput: z.object({ consent: z.boolean().optional() }),
	output: z.object({
		id: z.string(),
		email: z.string(),
		newsletterId: z.string(),
		status: z.enum(CONTACT_STATUSES),
		created: z.boolean().describe("False when the address was already a contact"),
		inbox: z
			.object({ name: z.string(), url: z.string() })
			.nullable()
			.describe("For pending contacts on a known webmail: a link for a \"check your inbox\" button"),
	}),
	handler: async ({ account, user, apiKey, connection, input, via }) => {
		const isByHand = via === "dashboard";
		if (isByHand && input.consent !== true) throw actionError("validation_failed", "Check that this person agreed to get your emails");
		const email = normalizeEmail(input.email);
		if (!email) throw actionError("validation_failed", "email is invalid");
		const language = readLanguage(input.language);
		const ip = input.ip && IP_PATTERN.test(input.ip) ? input.ip : null;
		const limitProblem = await signupLimitProblem({ account, apiKey, connection, ip, via });
		if (limitProblem) throw actionError("rate_limited", limitProblem);
		const emailProblem = await getSignupProblem(email);
		if (emailProblem) throw actionError("validation_failed", emailProblem);

		const newsletter = await findNewsletter(account, input.newsletter);
		if (!hasActiveSubscription(account) && (await isRateLimited({ ...TRIAL_CONTACTS, key: String(account._id) }))) {
			throw actionError(ERROR_CODES.subscriptionRequired, "Pick a plan to add more contacts");
		}
		const { contact, created } = await upsertContact({
			newsletter,
			email,
			source: isByHand ? "dashboard" : input.source || "api",
			resubscribe: input.resubscribe === true,
			consent: isByHand ? { userId: user.id, at: new Date() } : null,
			language,
			firstName: normalizeName(input.firstName),
			lastName: normalizeName(input.lastName),
		});
		// A pending contact who signs up again gets the confirmation again (throttled per address), unless it's
		// someone added by hand.
		const isPending = contact.status === "pending";
		const needsConfirmation = isPending && !isByHand;
		if (isSendingEnabled() && (needsConfirmation || (created && contact.status === "active"))) {
			const queue = needsConfirmation ? queueConfirmationEmail : queueWelcomeEmail;
			after(() =>
				queue({ newsletter, contact }).catch((error) => console.error(`[contacts] Signup email for ${contact._id} failed:`, error.message))
			);
		}
		return {
			id: String(contact._id),
			email: contact.email,
			newsletterId: String(newsletter._id),
			status: contact.status,
			created,
			inbox: isPending ? getInbox({ email: contact.email, fromEmail: newsletter.fromEmail }) : null,
		};
	},
});

const updateContactStatus = defineAction({
	name: "update_contact_status",
	tryWithoutPlan: true,
	title: "Unsubscribe or reactivate a contact",
	group: GROUP,
	description:
		"unsubscribed stops all emails to the contact, for good: only the person signing up again brings them back. active brings back a dormant contact; unsubscribes, bounces and complaints are final.",
	http: { method: "PATCH", path: "/contacts/{id}" },
	destructive: true,
	idempotent: true,
	example: { status: "unsubscribed" },
	input: z.object({
		id: contactReference,
		newsletter: contactNewsletterInput,
		status: z.enum(["active", "unsubscribed"]).describe("active (dormant contacts only) or unsubscribed"),
	}),
	output: ContactSchema,
	handler: async ({ account, input }) => {
		const contact = await findContact(account, input.id, input.newsletter);
		if (contact.status === input.status) return toContact(contact);
		// Reactivation starts the list cleanup over, or the next send would make them dormant again. An address
		// the account suppressed stays out (contacts_block_reactivation).
		const isReactivation = input.status === "active";
		const now = new Date();
		const engagement = withEngagement(now);
		const updated = isReactivation
			? await getOne(
					`UPDATE contacts SET status = 'active', ${engagement.sql}, updatedAt = ?
					WHERE accountId = ? AND _id = ? AND status = 'dormant'
					AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.accountId = contacts.accountId AND s.email = contacts.email) RETURNING *`,
					[...engagement.params, now, String(account._id), contact._id]
				)
			: await getOne(
					`UPDATE contacts SET status = 'unsubscribed', unsubscribedAt = ?, updatedAt = ?
					WHERE accountId = ? AND _id = ? AND status IN ('active', 'dormant', 'pending') RETURNING *`,
					[now, now, String(account._id), contact._id]
				);
		if (!updated) {
			throw actionError("conflict", isReactivation ? "Only dormant contacts can be reactivated" : "Status cannot change");
		}
		return toContact(updated);
	},
});

const updateContactLanguage = defineAction({
	name: "update_contact_language",
	tryWithoutPlan: true,
	title: "Change a contact's language",
	group: GROUP,
	description: "Sets the contact's language, whatever its status. null clears it, and the newsletter's language applies again.",
	http: { method: "PATCH", path: "/contacts/{id}/language" },
	idempotent: true,
	example: { language: "fr" },
	input: z.object({
		id: contactReference,
		newsletter: contactNewsletterInput,
		language: z.string().trim().max(40).nullable().describe("A language code like fr or pt-BR, or null"),
	}),
	output: ContactSchema,
	handler: async ({ account, input }) => {
		const language = readLanguage(input.language);
		const contact = await findContact(account, input.id, input.newsletter);
		if (getLanguageTag(contact) === language) return toContact(contact);
		const { language: baseLanguage, languageRegion } = splitLanguage(language);
		const updated = await getOne(
			"UPDATE contacts SET language = ?, languageRegion = ?, updatedAt = ? WHERE accountId = ? AND _id = ? RETURNING *",
			[baseLanguage, languageRegion, new Date(), String(account._id), contact._id]
		);
		if (!updated) throw actionError("not_found", "Contact not found");
		return toContact(updated);
	},
});

const updateContactName = defineAction({
	name: "update_contact_name",
	tryWithoutPlan: true,
	title: "Change a contact's name",
	group: GROUP,
	description: "Sets the contact's first and last name, whatever its status. A name left out stays as it is; null or an empty string clears it.",
	http: { method: "PATCH", path: "/contacts/{id}/name" },
	idempotent: true,
	example: { firstName: "Jane", lastName: "Doe" },
	input: z.object({
		id: contactReference,
		newsletter: contactNewsletterInput,
		firstName: nameInput("first").nullable().optional().describe("The contact's first name, or null to clear it"),
		lastName: nameInput("last").nullable().optional().describe("The contact's last name, or null to clear it"),
	}),
	output: ContactSchema,
	handler: async ({ account, input }) => {
		const contact = await findContact(account, input.id, input.newsletter);
		const names = {
			firstName: input.firstName === undefined ? (contact.firstName ?? null) : normalizeName(input.firstName),
			lastName: input.lastName === undefined ? (contact.lastName ?? null) : normalizeName(input.lastName),
		};
		if (names.firstName === (contact.firstName ?? null) && names.lastName === (contact.lastName ?? null)) return toContact(contact);
		const updated = await getOne("UPDATE contacts SET firstName = ?, lastName = ?, updatedAt = ? WHERE accountId = ? AND _id = ? RETURNING *", [
			names.firstName,
			names.lastName,
			new Date(),
			String(account._id),
			contact._id,
		]);
		if (!updated) throw actionError("not_found", "Contact not found");
		return toContact(updated);
	},
});

const importContacts = defineAction({
	name: "import_contacts",
	title: "Import contacts",
	group: GROUP,
	description: `Adds up to ${MAX_IMPORT_ROWS_PER_REQUEST} contacts per call, with the same checks as the dashboard's CSV import: invalid, misspelled (gmial.com…), spam trap, role (info@, support@…), throwaway, duplicate and suppressed addresses, and addresses on domains that can't receive email, are left out and counted. consent must be true: "${CONSENT_TEXT}". Existing contacts keep their status unless a row gives a stricter one (unsubscribed, bounced, complained), which is final. No welcome emails go out. For more rows, send the next chunk with the importId of the first.`,
	http: { method: "POST", path: "/contacts/import" },
	destructive: true,
	idempotent: true,
	rateLimit: { limit: 120, window: "1 h" },
	// A file is one import: the dashboard sends it in chunks, and only the first counts.
	limitDashboard: (input) => !input.importId,
	example: {
		consent: true,
		contacts: [
			{ email: "jane@example.com", firstName: "Jane", subscribedAt: "2025-03-01T00:00:00Z" },
			{ email: "sam@example.com", status: "unsubscribed" },
		],
	},
	input: z.object({
		newsletter: newsletterInput,
		consent: z.boolean().describe(`Must be true: ${CONSENT_TEXT}. Bought or scraped lists aren't allowed.`),
		contacts: z
			.array(
				z.object({
					email: z.string().max(1000).describe("Invalid addresses are left out and counted"),
					firstName: z.string().max(1000).optional().describe("Replaces an existing contact's; an empty one leaves it as it is"),
					lastName: z.string().max(1000).optional().describe("Replaces an existing contact's; an empty one leaves it as it is"),
					status: z
						.enum(Object.keys(STATUS_RANK))
						.optional()
						.describe("active (default), dormant, unsubscribed, bounced or complained"),
					subscribedAt: z.string().max(40).optional().describe("When they signed up, ISO 8601"),
					emailsReceived: z.number().min(0).optional().describe("Emails they got on the previous platform"),
					openRate: z.number().min(0).optional().describe("0 to 1, from the previous platform: sends reach the most engaged first"),
					clickRate: z.number().min(0).optional().describe("0 to 1, from the previous platform"),
					language: z
						.string()
						.max(100)
						.optional()
						.describe(
							"A code like fr or pt-BR, or a name like French. Replaces an existing contact's; one MailCheap doesn't know leaves it as it is."
						),
				})
			)
			.max(MAX_IMPORT_ROWS_PER_REQUEST)
			.describe(`The rows, ${MAX_IMPORT_ROWS_PER_REQUEST} at most`),
		languages: z
			.array(z.string().trim().max(40))
			.min(1)
			.max(100)
			.optional()
			.describe(
				`Only add contacts in these languages: codes like fr or pt-BR, as the rows have them (pt keeps no pt-BR row), and ${NO_LANGUAGE} for rows without one. Other rows are left out and counted, but their unsubscribes, bounces and complaints still reach contacts already there. Send the same list with every chunk.`
			),
		importId: z.string().max(100).optional().describe("The importId of the first chunk, to add rows to the same import"),
		duplicates: z.number().int().min(0).optional().describe("Duplicates you removed before sending, counted in the import's report"),
	}),
	output: z.object({
		importId: z.string(),
		created: z.number().int(),
		existing: z.number().int().describe("Already contacts: their status stays unless a row gave a stricter one"),
		dropped: z.object(Object.fromEntries(Object.keys(DROP_REASONS).map((reason) => [reason, z.number().int()]))),
	}),
	handler: async ({ account, user, apiKey, input, via }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		const result = await importContactRows({
			account,
			userId: user?.id,
			apiKeyId: apiKey?._id ? String(apiKey._id) : undefined,
			newsletterId: String(newsletter._id),
			rows: input.contacts.map((row) => ({ ...row, status: row.status ?? "active" })),
			consent: input.consent,
			importId: input.importId,
			duplicates: input.duplicates,
			source: via === "dashboard" ? "dashboard" : "api",
			languages: input.languages
				? new Set(input.languages.map((language) => (language.toLowerCase() === NO_LANGUAGE ? NO_LANGUAGE : readLanguage(language))))
				: null,
		});
		if (result.error) {
			throw actionError(result.error === "Import not found" ? "not_found" : "validation_failed", result.error);
		}
		return result;
	},
});

const UnreachableContactSchema = ContactSchema.extend({
	reason: z
		.enum(UNREACHABLE_REASONS)
		.describe("invalid: not a valid address. typo: a misspelled domain (gmial.com). noMail: the domain can't receive email."),
	suggestion: z.string().nullable().describe("For a typo, the address it was likely meant to be"),
});

const findUnreachableContacts = defineAction({
	name: "find_unreachable_contacts",
	tryWithoutPlan: true,
	title: "Find unreachable contacts",
	group: GROUP,
	description: `Checks the addresses of a newsletter's ${LIVE_STATUSES.join(", ")} contacts, newest signups first, and lists the ones that can't get email: invalid addresses, misspelled domains (gmial.com…) and domains whose DNS says they take no email. It can't tell whether a mailbox exists on a domain that takes email: that shows when an email is sent to it, and a hard bounce, or SES Auto Validation's refusal to send, marks the contact bounced and keeps the address out. Each call checks a page; pass nextCursor back as cursor until it's null. delete_contacts deletes the ones not worth keeping: emails to them bounce, and bounces count against the account.`,
	http: { method: "GET", path: "/contacts/unreachable" },
	readOnly: true,
	openWorld: true,
	rateLimit: { limit: 1000, window: "1 h" },
	// The dashboard checks a list in pages, and only the first counts.
	limitDashboard: (input) => !input.cursor,
	input: z.object({
		newsletter: newsletterInput,
		cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({
		contacts: z.array(UnreachableContactSchema),
		checked: z.number().int().describe("Contacts this page checked"),
		nextCursor: z.string().nullable().describe("null once every contact is checked"),
	}),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, "_id");
		const cursor = input.cursor ? afterCursor(input.cursor, { sort: DEFAULT_CONTACT_SORT, order: "desc" }) : null;
		const contacts = await getAll(
			`SELECT * FROM contacts WHERE accountId = ? AND newsletterId = ? AND status IN (SELECT value FROM json_each(?))${cursor ? ` AND ${cursor.sql}` : ""}
			ORDER BY subscribedAt DESC, _id DESC LIMIT ?`,
			[String(account._id), String(newsletter._id), JSON.stringify(LIVE_STATUSES), ...(cursor?.params ?? []), CHECK_PAGE_SIZE + 1]
		);
		const { checked, unreachable } = await checkContactAddresses(contacts.slice(0, CHECK_PAGE_SIZE));
		const last = checked.at(-1);
		return {
			contacts: unreachable.map(({ contact, reason, suggestion }) => ({ ...toContact(contact), reason, suggestion })),
			checked: checked.length,
			nextCursor: checked.length < contacts.length ? encodeCursor(last.subscribedAt, last._id) : null,
		};
	},
});

const deleteContacts = defineAction({
	name: "delete_contacts",
	tryWithoutPlan: true,
	title: "Delete contacts",
	group: GROUP,
	description: `Deletes contacts for good, by ID or email address, up to ${MAX_CONTACTS_PER_CHANGE} per call, with the emails MailCheap sent them. Only ${LIVE_STATUSES.join(", ")} contacts go: unsubscribed, bounced and complained ones stay, as the record that keeps the address out, and so do contacts with an email still going out or a bounce or complaint on record, which the account's sending rates count. To stop emails to someone, update_contacts unsubscribes them instead.`,
	http: { method: "POST", path: "/contacts/delete" },
	destructive: true,
	idempotent: true,
	example: { ids: ["6650f1c2e9b1d4a012345678"] },
	input: z.object(namedContactsInput),
	output: z.object({
		deleted: z.array(z.string()).describe("IDs of the contacts deleted"),
		kept: z.array(z.string()).describe("IDs of the contacts that stay"),
		notFound: notFoundOutput,
	}),
	handler: async ({ account, input }) => deleteContactRows(account, await readNamedContacts(account, input)),
});

const updateContacts = defineAction({
	name: "update_contacts",
	tryWithoutPlan: true,
	title: "Update contacts",
	group: GROUP,
	description: `Unsubscribes or reactivates contacts, or changes their language, by ID or email address, up to ${MAX_CONTACTS_PER_CHANGE} per call. status and language work as in update_contact_status and update_contact_language, and can go together: a contact whose status can't change keeps its language too, and is listed in skipped.`,
	http: { method: "POST", path: "/contacts/update" },
	destructive: true,
	idempotent: true,
	example: { emails: ["jane@example.com", "sam@example.com"], status: "unsubscribed" },
	input: z.object({
		...namedContactsInput,
		status: z
			.enum(["active", "unsubscribed"])
			.optional()
			.describe("unsubscribed stops all emails to them, for good. active brings back dormant contacts."),
		language: z.string().trim().max(40).nullable().optional().describe("A language code like fr or pt-BR, or null for the newsletter's"),
	}),
	output: z.object({
		updated: z.array(z.string()).describe("IDs of the contacts changed"),
		unchanged: z.array(z.string()).describe("IDs of the contacts that already had it"),
		skipped: z
			.array(z.string())
			.describe("IDs of the contacts whose status can't change: bounced and complained ones, and for active, any that isn't dormant"),
		notFound: notFoundOutput,
	}),
	handler: async ({ account, input }) => {
		if (input.status === undefined && input.language === undefined) throw actionError("validation_failed", "Pass status, language or both");
		const language = input.language === undefined ? undefined : readLanguage(input.language);
		return updateContactRows(account, await readNamedContacts(account, input), { status: input.status, language });
	},
});

const exportContacts = defineAction({
	name: "export_contacts",
	title: "Export contacts",
	group: GROUP,
	description:
		"Makes a CSV download link for the contacts matching the filters, valid for an hour, no API key needed to open it. The columns go back in through the import as they are.",
	http: { method: "GET", path: "/contacts/export" },
	readOnly: true,
	rateLimit: { limit: 30, window: "1 h" },
	example: { status: "active" },
	input: z.object({
		newsletter: newsletterFilterInput,
		status: statusInput,
		search: searchInput,
		language: languageFilterInput,
		exactLanguage: exactLanguageInput,
	}),
	output: z.object({
		url: z.string().describe("The CSV file. Anyone with the link can download it until it expires."),
		expiresAt: z.string(),
		count: z.number().int().describe("Contacts in the file"),
	}),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter) : null;
		const filters = {
			newsletterId: newsletter?._id,
			status: input.status,
			query: input.search,
			language: readLanguage(input.language),
			exactLanguage: input.exactLanguage,
		};
		const { where, params } = contactSearchFilter(account, filters);
		const count = await getValue(`SELECT count(*) FROM contacts WHERE ${where}${input.status ? " AND status = ?" : ""}`, [
			...params,
			...(input.status ? [input.status] : []),
		]);
		const { token, expiresAt } = createExportToken({ accountId: account._id, ...filters });
		return { url: `${getAppUrl()}/api/v1/contacts/export.csv?token=${token}`, expiresAt: expiresAt.toISOString(), count };
	},
});

export const contactActions = [
	listContacts,
	getContact,
	addContact,
	updateContactStatus,
	updateContactLanguage,
	updateContactName,
	importContacts,
	findUnreachableContacts,
	updateContacts,
	deleteContacts,
	exportContacts,
];
