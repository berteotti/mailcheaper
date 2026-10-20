import "server-only";
import * as z from "zod";
import { findUser } from "@/lib/accounts";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { assertSendingEnabled, dateOutput, findNewsletter, findTestRecipient, toIso } from "@/lib/actions/shared";
import { revalidateArchive } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { isAdmin } from "@/lib/auth";
import { cleanupTotalsQuery, getCleanupSettings } from "@/lib/cleanup";
import { getSharedDomain } from "@/lib/config";
import { getConfirmationContent, getConfirmationProblem } from "@/lib/confirmation-content";
import { listNewslettersWithActiveCounts } from "@/lib/contacts";
import { connectDb, getOne, getValue, isUniqueConstraint, newId, statement } from "@/lib/db";
import { syncArchiveHosts } from "@/lib/domains";
import { formatDate, formatWindow } from "@/lib/format";
import {
	applySharedAddress,
	getNewsletterProblem,
	mergeNewsletterSettings,
	toNewsletterDocument,
	toNewsletterSettings,
} from "@/lib/newsletter-settings";
import { NEWSLETTER_DELETIONS, deleteNewsletter, getNewsletterDeletionBlockers } from "@/lib/newsletter-deletion";
import { MAX_NEWSLETTERS_PER_ACCOUNT, NEWSLETTER_LIMIT_MESSAGE, getNewsletterLimit } from "@/lib/newsletters";
import { findFreeSlug } from "@/lib/onboarding";
import { isRateLimited } from "@/lib/rate-limit";
import { columnValue, updateOne } from "@/lib/records";
import { findAccountDomains } from "@/lib/sender";
import { getFromEmailSaveProblem, getSharedAddress } from "@/lib/sender-rules";
import { ACCOUNT_CHECK_DAYS } from "@/lib/sending-rules";
import { sendWelcomeTestEmail } from "@/lib/sending";
import { syncSharedSender } from "@/lib/shared-sender";

const GROUP = "Newsletters";
// A new slug moves the shared address: its domain at the email provider and its DNS records, out of budgets every
// account shares (the DNS helper's records a day, the provider's calls an hour).
export const SLUG_CHANGES = { name: "account-slug-changes", limit: 3, window: "1 d" };
const text = (max) => z.string().trim().max(max);
const email = z.string().trim().toLowerCase().max(254);

const settingsShape = {
	name: text(100).describe("The newsletter's name, shown in emails and on the archive"),
	slug: z
		.string()
		.trim()
		.toLowerCase()
		.max(40)
		.describe(
			"Lowercase letters, digits and dashes, not a name MailCheap keeps like www, api or mail. The shared from address (hello@<slug>.<shared domain>) and the archive subdomain follow it."
		),
	language: text(40).describe(
		"The language it's written in, a code like en, fr or pt-BR (kept as pt): the emails' and the archive's. Contacts without a language of their own are in it. Default: en."
	),
	imageUrl: text(500).describe("Square logo, 128×128 or larger: an https:// link"),
	fromName: text(100).describe("Name in the From field"),
	fromEmail: email.describe(
		"The shared address (hello@<slug>.<shared domain>, set automatically) or an address on a domain added to this account"
	),
	replyTo: email.describe("Where replies go. Empty: replies to the shared address go to the account owner."),
	postalAddress: text(500).describe("Printed in the footer of every email. Sending needs one."),
	archiveEnabled: z.boolean().describe("A public page for each sent issue, with a signup form"),
	description: text(1000).describe("One sentence under the name on the archive, 200 characters at most"),
	author: z
		.object({
			bio: text(1000).optional().describe("Under the author's name on the archive, 160 characters at most"),
			imageUrl: text(500).optional().describe("Author photo: an https:// link. The newsletter image otherwise."),
		})
		.describe("The archive's author page; the author's name is fromName"),
	socialLinks: z.array(text(300)).max(20).describe("https:// links shown on the archive, 8 at most"),
	requireConfirmation: z
		.boolean()
		.describe("Confirmed opt-in: new signups get an email with a button and only join once they click it. On for new newsletters."),
	cleanup: z
		.object({
			enabled: z.boolean().optional().describe("On for new newsletters"),
			issues: z.number().nullable().optional().describe("Ignored issues in a row before the last-chance email, 2 to 100. Default 6."),
			days: z.number().nullable().optional().describe("Days without an open, click or signup, 30 to 3650. Default 180."),
		})
		.describe(
			"List cleanup at each send: contacts who ignored several issues get a last-chance email instead, and become dormant if they don't answer"
		),
	welcome: z
		.object({
			enabled: z.boolean().optional(),
			subject: text(200).optional(),
			previewText: text(300).optional(),
			markdown: z.string().max(100_000).optional().describe("Markdown"),
		})
		.describe("Email sent to each new subscriber. Not sent while signups need confirming."),
	confirmation: z
		.object({
			subject: text(200).optional(),
			previewText: text(300).optional(),
			markdown: z
				.string()
				.max(100_000)
				.optional()
				.describe('Markdown that keeps the button: an HTML link like <a href="{{confirm_url}}">Confirm</a>'),
		})
		.describe(
			"The confirmation email for confirmed opt-in. Sent back unchanged, the built-in one stays built-in and follows the name and description."
		),
};

const NewsletterSchema = z.object({
	id: z.string(),
	name: z.string(),
	slug: z.string(),
	language: z.string(),
	imageUrl: z.string(),
	fromName: z.string(),
	fromEmail: z.string(),
	replyTo: z.string(),
	postalAddress: z.string(),
	sharedAddress: z.string().nullable().describe("The shared from address for this slug, when the server has a shared domain"),
	archiveEnabled: z.boolean(),
	archiveUrl: z.string().nullable(),
	description: z.string(),
	author: z.object({ bio: z.string(), imageUrl: z.string() }),
	socialLinks: z.array(z.string()),
	requireConfirmation: z.boolean(),
	welcome: z.object({ enabled: z.boolean(), subject: z.string(), previewText: z.string(), markdown: z.string() }),
	confirmation: z.object({
		subject: z.string(),
		previewText: z.string(),
		markdown: z.string(),
		isCustom: z.boolean().describe("False while the built-in confirmation email goes out"),
	}),
	cleanup: z.object({
		enabled: z.boolean(),
		issues: z.number().int(),
		days: z.number().int(),
		waiting: z.number().int().describe("Got the last-chance email and haven't answered yet"),
		kept: z.number().int().describe("Answered the last-chance email"),
		dormant: z.number().int(),
	}),
	activeContacts: z.number().int(),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});

async function toNewsletter(newsletter, activeContacts) {
	const { sql, params } = cleanupTotalsQuery({ accountId: newsletter.accountId, newsletterId: newsletter._id });
	const totals = await getOne(sql, params);
	const settings = toNewsletterSettings(newsletter);
	const confirmation = getConfirmationContent(newsletter);
	return {
		id: String(newsletter._id),
		...settings,
		sharedAddress: getSharedAddress(newsletter.slug),
		archiveUrl: newsletter.archiveEnabled ? getArchiveUrls(newsletter).siteIndex : null,
		confirmation: {
			subject: confirmation.subject,
			previewText: confirmation.previewText,
			markdown: confirmation.markdown,
			isCustom: Boolean(newsletter.confirmation?.subject) && !getConfirmationProblem(newsletter.confirmation),
		},
		cleanup: { ...getCleanupSettings(newsletter), waiting: totals?.waiting ?? 0, kept: totals?.kept ?? 0, dormant: totals?.dormant ?? 0 },
		activeContacts:
			activeContacts ??
			(await getValue("SELECT count(*) FROM contacts WHERE accountId = ? AND newsletterId = ? AND status = 'active'", [
				newsletter.accountId,
				newsletter._id,
			])),
		createdAt: toIso(newsletter.createdAt),
		updatedAt: toIso(newsletter.updatedAt),
	};
}

// A slug another newsletter has is refused before it counts.
async function countSlugChange(account, slug) {
	// Slugs are unique across accounts, so this looks at every account.
	if (await getOne("SELECT 1 AS found FROM newsletters WHERE slug = ?", [slug])) throw actionError("conflict", "This slug is already used");
	if (await isRateLimited({ ...SLUG_CHANGES, key: String(account._id) })) {
		throw actionError("rate_limited", `You can change slugs ${SLUG_CHANGES.limit} times ${formatWindow(SLUG_CHANGES.window)}. Try again later.`);
	}
}

// The same checks as the settings form: the shared address follows the slug, and a from address is the
// shared one or on a domain the account added.
async function saveNewsletter({ account, existing, changes }) {
	const settings = applySharedAddress(mergeNewsletterSettings(toNewsletterSettings(existing), changes), getSharedDomain());
	const problem = getNewsletterProblem(settings);
	if (problem) throw actionError("validation_failed", problem);
	const fromProblem = getFromEmailSaveProblem({ ...settings, domains: await findAccountDomains(account._id) });
	if (fromProblem) throw actionError("sender_not_allowed", fromProblem);
	if (existing && settings.slug !== existing.slug) await countSlugChange(account, settings.slug);

	const document = toNewsletterDocument(settings);
	let id = existing?._id;
	try {
		if (existing) {
			const updated = await updateOne("newsletters", { where: "accountId = ? AND _id = ?", params: [account._id, id] }, { set: document });
			if (!updated) throw actionError("not_found", "Newsletter not found");
		} else {
			id = await insertNewsletter(account, document);
			if (!id) throw actionError("conflict", NEWSLETTER_LIMIT_MESSAGE);
		}
	} catch (error) {
		if (isUniqueConstraint(error)) throw actionError("conflict", "This slug is already used");
		throw error;
	}

	await syncArchiveHosts(account._id);
	await syncSharedSender({ account, newsletter: await findAccountNewsletter(account, id) });
	revalidateArchive();
	return toNewsletter(await findAccountNewsletter(account, id));
}

function findAccountNewsletter(account, id) {
	return getOne("SELECT * FROM newsletters WHERE accountId = ? AND _id = ?", [account._id, id]);
}

// The account's limit is checked in the insert itself, so two creates at once can't both pass it. Null at the limit.
// The owner's account is the admin's, whoever calls: an API key has no user.
async function insertNewsletter(account, document) {
	const now = Date.now();
	const row = { _id: newId(), accountId: account._id, ...document, createdAt: now, updatedAt: now };
	const names = Object.keys(row).filter((name) => row[name] !== undefined);
	const limit = getNewsletterLimit({ isAdmin: isAdmin(await findUser(account.ownerId)) });
	const inserted = await statement(
		await connectDb(),
		`INSERT INTO newsletters (${names.join(", ")}) SELECT ${names.map(() => "?").join(", ")}
		WHERE ${limit === null ? "true" : "(SELECT count(*) FROM newsletters WHERE accountId = ?) < ?"} RETURNING _id`,
		[...names.map((name) => columnValue(row[name])), ...(limit === null ? [] : [account._id, limit])]
	).first();
	return inserted?._id ?? null;
}

export const newsletterActions = [
	defineAction({
		name: "list_newsletters",
		tryWithoutPlan: true,
		title: "List newsletters",
		group: GROUP,
		description: `Lists the account's newsletters, ${MAX_NEWSLETTERS_PER_ACCOUNT} at most unless it's an admin's, first created first, with their settings and active contacts. Actions that take a newsletter use the first one when it's left out.`,
		http: { method: "GET", path: "/newsletters" },
		readOnly: true,
		output: z.object({ newsletters: z.array(NewsletterSchema) }),
		handler: async ({ account }) => {
			const newsletters = await listNewslettersWithActiveCounts(account);
			return { newsletters: await Promise.all(newsletters.map((newsletter) => toNewsletter(newsletter, newsletter.activeCount))) };
		},
	}),
	defineAction({
		name: "get_newsletter",
		tryWithoutPlan: true,
		title: "Get a newsletter",
		group: GROUP,
		description:
			"Gets a newsletter's settings: sender, postal address, welcome and confirmation emails, list cleanup and archive.",
		http: { method: "GET", path: "/newsletters/{id}" },
		readOnly: true,
		input: z.object({ id: z.string().trim().min(1).max(100).describe("The newsletter's ID or slug") }),
		output: NewsletterSchema,
		handler: async ({ account, input }) => toNewsletter(await findNewsletter(account, input.id)),
	}),
	defineAction({
		name: "create_newsletter",
		tryWithoutPlan: true,
		title: "Create a newsletter",
		group: GROUP,
		description:
			`Creates a newsletter. An account has up to ${MAX_NEWSLETTERS_PER_ACCOUNT}, sharing its plan's emails and subscribers; one more answers conflict. The server's admins have no limit. Without a fromEmail it sends from the shared address hello@<slug>.<shared domain>, which MailCheap sets up in a few minutes. List cleanup is on unless cleanup.enabled is false. Add a postal address before sending.`,
		http: { method: "POST", path: "/newsletters", status: 201 },
		example: { name: "Field notes", postalAddress: "Field Notes Ltd, 1 Main St, Paris, France" },
		input: z.object({
			...Object.fromEntries(Object.entries(settingsShape).map(([key, schema]) => [key, schema.optional()])),
			name: settingsShape.name.min(1),
			slug: settingsShape.slug
				.optional()
				.describe("Lowercase letters, digits and dashes. Default: made from the name, numbered when another newsletter has it."),
		}),
		output: NewsletterSchema,
		handler: async ({ account, input }) =>
			saveNewsletter({ account, existing: null, changes: { ...input, slug: input.slug || (await findFreeSlug(input.name)) } }),
	}),
	defineAction({
		name: "update_newsletter",
		tryWithoutPlan: true,
		title: "Update a newsletter",
		group: GROUP,
		description: `Changes a newsletter's settings. Send only the fields to change; nested groups (welcome, confirmation, cleanup, author) keep the fields you leave out. An account changes slugs ${SLUG_CHANGES.limit} times ${formatWindow(SLUG_CHANGES.window)} at most: one more answers rate_limited.`,
		http: { method: "PATCH", path: "/newsletters/{id}" },
		idempotent: true,
		example: { replyTo: "jane@example.com", requireConfirmation: true },
		input: z.object({
			id: z.string().trim().min(1).max(100).describe("The newsletter's ID or slug"),
			...Object.fromEntries(Object.entries(settingsShape).map(([key, schema]) => [key, schema.optional()])),
		}),
		output: NewsletterSchema,
		handler: async ({ account, input: { id, ...changes } }) =>
			saveNewsletter({ account, existing: await findNewsletter(account, id), changes }),
	}),
	defineAction({
		name: "delete_newsletter",
		tryWithoutPlan: true,
		title: "Delete a newsletter",
		group: GROUP,
		description: `Deletes a newsletter for good: its contacts, campaigns, archive, stats and shared address. Addresses the account suppressed stay suppressed. Its campaigns can't be sending or scheduled, and on MailCheap Cloud it can't have sent emails in the last ${ACCOUNT_CHECK_DAYS} days, which still count toward the account's bounce and complaint rates. An account deletes ${NEWSLETTER_DELETIONS.limit} newsletters ${formatWindow(NEWSLETTER_DELETIONS.window)} at most.`,
		http: { method: "DELETE", path: "/newsletters/{id}" },
		destructive: true,
		input: z.object({ id: z.string().trim().min(1).max(100).describe("The newsletter's ID or slug") }),
		// Delete newsletter's dialog: the name its user typed.
		dashboardInput: z.object({ confirmName: z.string().max(200).optional() }),
		output: z.object({ id: z.string(), deleted: z.literal(true) }),
		handler: async ({ account, input, via }) => {
			const newsletter = await findNewsletter(account, input.id);
			if (via === "dashboard" && input.confirmName?.trim() !== newsletter.name) {
				throw actionError("validation_failed", "Type the newsletter's name to delete it");
			}
			const blockers = await getNewsletterDeletionBlockers(account, newsletter);
			if (blockers?.campaigns.length > 0) {
				const subjects = blockers.campaigns.map(({ subject }) => subject || "Untitled").join(", ");
				throw actionError("conflict", `Pause or unschedule its campaigns first: ${subjects}`);
			}
			if (blockers?.availableAt) {
				throw actionError(
					"conflict",
					`It sent emails in the last ${ACCOUNT_CHECK_DAYS} days, which still count toward your bounce and complaint rates. You can delete it from ${formatDate(blockers.availableAt)}.`
				);
			}
			if (await isRateLimited({ ...NEWSLETTER_DELETIONS, key: String(account._id) })) {
				throw actionError(
					"rate_limited",
					`You can delete ${NEWSLETTER_DELETIONS.limit} newsletters ${formatWindow(NEWSLETTER_DELETIONS.window)}. Try again later.`
				);
			}
			await deleteNewsletter(account, newsletter);
			return { id: String(newsletter._id), deleted: true };
		},
	}),
	defineAction({
		name: "send_welcome_test_email",
		title: "Send a test of the welcome email",
		group: GROUP,
		description: "Sends the saved welcome email to the account owner's address, switched on or not. It counts toward the plan's emails.",
		http: { method: "POST", path: "/newsletters/{id}/welcome-test" },
		openWorld: true,
		rateLimit: { limit: 20, window: "1 h" },
		input: z.object({ id: z.string().trim().min(1).max(100).describe("The newsletter's ID or slug") }),
		output: z.object({ sentTo: z.string(), messageId: z.string() }),
		handler: async ({ account, user, input }) => {
			assertSendingEnabled();
			const newsletter = await findNewsletter(account, input.id, { _id: 1 });
			const to = await findTestRecipient({ account, user });
			const { messageId } = await sendWelcomeTestEmail({ accountId: account._id, newsletterId: newsletter._id, to });
			return { sentTo: to, messageId };
		},
	}),
];
