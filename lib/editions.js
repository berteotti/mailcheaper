import { DEFAULT_LANGUAGE, getLanguageTag, matchLanguage, splitLanguage } from "./languages.js";

// A campaign in several languages: its own subject and content in its language, and an edition for each other one
// (campaign_editions). It goes out as one send: each contact gets the one in their language (matchLanguage), and a
// contact it has nothing for the one in their newsletter's, the default. Contacts without a language read the
// newsletter's. Only a campaign with nothing in the newsletter's language leaves anyone out: one in Portuguese alone
// goes to Portuguese readers alone.
export const MAX_EDITIONS = 20;
export const EDITION_FIELDS = ["subject", "previewText", "format", "markdown", "html"];

// The language of the campaign's own content: its newsletter's until it has one.
export function getCampaignLanguage(campaign, newsletter) {
	return getLanguageTag(campaign) ?? getLanguageTag(newsletter) ?? DEFAULT_LANGUAGE;
}

// What a reader of an edition gets: the campaign, with the edition's language, subject, preview text and content.
export function getEditionContent(campaign, edition) {
	return {
		...campaign,
		...Object.fromEntries(EDITION_FIELDS.map((field) => [field, edition[field]])),
		language: edition.language,
		languageRegion: edition.languageRegion,
		editionId: edition._id,
	};
}

// Who reads what. match: the language a reader of a tag gets, theirs or else the newsletter's, null for none (a
// contact without one reads the newsletter's). pick: the edition a contacts row gets, null for the campaign's own
// content, undefined for nothing. languages: the base languages it has something in, which find its audience, or
// null when everyone gets something.
export function getEditionMatcher({ campaign, newsletter, editions = [] }) {
	const own = getCampaignLanguage(campaign, newsletter);
	const newsletterLanguage = getLanguageTag(newsletter) ?? DEFAULT_LANGUAGE;
	const idsByTag = new Map(editions.map((edition) => [getLanguageTag(edition), edition._id]));
	const tags = [own, ...idsByTag.keys()];
	const fallback = matchLanguage(newsletterLanguage, tags);
	const match = (tag) => (tag && matchLanguage(tag, tags)) || fallback;
	return {
		own,
		languages: fallback ? null : [...new Set(tags.map((tag) => splitLanguage(tag).language))],
		match,
		pick(contact) {
			const tag = match(getLanguageTag(contact));
			if (!tag) return undefined;
			return tag === own ? null : idsByTag.get(tag);
		},
	};
}

// Contacts by language (countActiveByLanguage) with the language each gets: theirs, the newsletter's when the campaign
// has nothing in theirs, or null when it has nothing in either and the send leaves them out.
export function describeAudience(matcher, counts) {
	return counts.map(({ language, contacts }) => ({ language, contacts, edition: matcher.match(language) }));
}

// The contacts' languages (describeAudience) the campaign has no content of its own in, most read first: what the
// dashboard offers to add. A variant counts on its own, so pt-BR's readers can get theirs while they read pt-PT's.
export function getAddableLanguages(audience, tags) {
	return audience.filter(({ language }) => !tags.includes(language));
}
