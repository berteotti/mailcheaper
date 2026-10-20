import { CLEANUP_LIMITS } from "./cleanup.js";
import { getConfirmationProblem, isDefaultConfirmation } from "./confirmation-content.js";
import { DEFAULT_LANGUAGE, getLanguageTag, normalizeLanguage, splitLanguage } from "./languages.js";
import { MAX_AUTHOR_BIO_LENGTH, MAX_DESCRIPTION_LENGTH } from "./newsletters.js";
import { isReservedSlug } from "./reserved-slugs.js";
import { getSharedAddress, isOnSharedDomain } from "./sender-rules.js";
import { parseSocialLinks } from "./social.js";

export const NEWSLETTER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IMAGE_URL_PATTERN = /^(https:\/\/[^\s"'<>]{4,490}|\/[\w\-./]{1,200})$/;

function isWithin(value, min, max) {
	return value === undefined || value === null || (Number.isInteger(value) && value >= min && value <= max);
}

// What the settings form and the API save, in the stored shape, before any check.
export function toNewsletterSettings(newsletter) {
	return {
		name: newsletter?.name ?? "",
		slug: newsletter?.slug ?? "",
		language: getLanguageTag(newsletter) ?? DEFAULT_LANGUAGE,
		imageUrl: newsletter?.imageUrl ?? "",
		fromName: newsletter?.fromName ?? "",
		fromEmail: newsletter?.fromEmail ?? "",
		replyTo: newsletter?.replyTo ?? "",
		postalAddress: newsletter?.postalAddress ?? "",
		archiveEnabled: Boolean(newsletter?.archiveEnabled),
		description: newsletter?.description ?? "",
		author: { bio: newsletter?.author?.bio ?? "", imageUrl: newsletter?.author?.imageUrl ?? "" },
		socialLinks: newsletter?.socialLinks ?? [],
		// New newsletters start with confirmed opt-in: an address typed by someone else, or by a bot, never gets issues.
		requireConfirmation: newsletter ? Boolean(newsletter.requireConfirmation) : true,
		// New newsletters start with list cleanup on; a saved newsletter that never stored it stays off.
		cleanup: {
			enabled: newsletter ? Boolean(newsletter.cleanup?.enabled) : true,
			issues: newsletter?.cleanup?.issues ?? null,
			days: newsletter?.cleanup?.days ?? null,
		},
		welcome: {
			enabled: Boolean(newsletter?.welcome?.enabled),
			subject: newsletter?.welcome?.subject ?? "",
			previewText: newsletter?.welcome?.previewText ?? "",
			markdown: newsletter?.welcome?.markdown ?? "",
		},
		confirmation: {
			subject: newsletter?.confirmation?.subject ?? "",
			previewText: newsletter?.confirmation?.previewText ?? "",
			markdown: newsletter?.confirmation?.markdown ?? "",
		},
	};
}

// Changes land on top of the saved settings; nested groups keep the fields a change leaves out. A copy of the
// built-in confirmation email would stop following the name, the description and the built-in text. The form
// may have filled it in before a rename in the same save.
export function mergeNewsletterSettings(current, changes) {
	const merged = { ...current, ...changes };
	for (const group of ["author", "cleanup", "welcome", "confirmation"]) merged[group] = { ...current[group], ...changes[group] };
	if (changes.confirmation && isDefaultConfirmation(merged.confirmation, merged, current)) {
		merged.confirmation = { subject: "", previewText: "", markdown: "" };
	}
	return merged;
}

// The shared address follows the slug, so it stays unique and always matches the archive subdomain.
export function applySharedAddress(settings, sharedDomain) {
	const isSharedOrEmpty = !settings.fromEmail || isOnSharedDomain(settings.fromEmail, sharedDomain);
	if (!sharedDomain || !NEWSLETTER_SLUG_PATTERN.test(settings.slug) || !isSharedOrEmpty) return settings;
	return { ...settings, fromEmail: getSharedAddress(settings.slug, sharedDomain) };
}

export function getNewsletterProblem(settings) {
	if (!settings.name) return "Name is required";
	if (!NEWSLETTER_SLUG_PATTERN.test(settings.slug)) return "Slug can only use lowercase letters, numbers and dashes";
	if (isReservedSlug(settings.slug)) return `${settings.slug} is reserved for MailCheap, pick another slug`;
	if (!normalizeLanguage(settings.language)) return "Language should be a code like en, fr or pt-BR";
	if (settings.imageUrl && !IMAGE_URL_PATTERN.test(settings.imageUrl)) {
		return "Image must be an https:// link or a path like /logos/name.webp";
	}
	if (!EMAIL_PATTERN.test(settings.fromEmail)) return "From email is invalid";
	if (settings.replyTo && !EMAIL_PATTERN.test(settings.replyTo)) return "Reply-to email is invalid";
	if (settings.description.length > MAX_DESCRIPTION_LENGTH) {
		return `Keep the description under ${MAX_DESCRIPTION_LENGTH} characters`;
	}
	if (settings.author.bio.length > MAX_AUTHOR_BIO_LENGTH) {
		return `Keep the author bio under ${MAX_AUTHOR_BIO_LENGTH} characters`;
	}
	if (settings.author.imageUrl && !IMAGE_URL_PATTERN.test(settings.author.imageUrl)) {
		return "Author photo must be an https:// link or a path like /authors/name.jpg";
	}
	const social = parseSocialLinks(settings.socialLinks.join("\n"));
	if (social.error) return social.error;
	const { minIssues, maxIssues, minDays, maxDays } = CLEANUP_LIMITS;
	if (!isWithin(settings.cleanup.issues, minIssues, maxIssues)) {
		return `Ignored issues should be a whole number from ${minIssues} to ${maxIssues}`;
	}
	if (!isWithin(settings.cleanup.days, minDays, maxDays)) {
		return `Quiet days should be a whole number from ${minDays} to ${maxDays}`;
	}
	if (settings.welcome.enabled && (!settings.welcome.subject || !settings.welcome.markdown.trim())) {
		return "Welcome email needs a subject and content";
	}
	// Without a confirmation email of its own, the built-in one goes out (lib/confirmation-content.js).
	const hasOwnConfirmation = Boolean(settings.confirmation.subject || settings.confirmation.markdown.trim());
	return settings.requireConfirmation && hasOwnConfirmation ? getConfirmationProblem(settings.confirmation) : null;
}

// The document to save: empty numbers fall back to the newsletter's defaults, links lose duplicates.
export function toNewsletterDocument(settings) {
	const { issues, days, ...cleanup } = settings.cleanup;
	return {
		...settings,
		...splitLanguage(normalizeLanguage(settings.language)),
		socialLinks: parseSocialLinks(settings.socialLinks.join("\n")).links,
		cleanup: { ...cleanup, ...(issues !== null && issues !== undefined && { issues }), ...(days !== null && days !== undefined && { days }) },
	};
}
