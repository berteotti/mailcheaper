import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAudience, getEditionContent, getEditionMatcher } from "../lib/editions.js";
import { getCampaignSendProblem, getIssueWebUrl } from "../lib/sending-rules.js";

process.env.BETTER_AUTH_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.APP_URL = "https://mail.example.com";

const newsletter = {
	_id: "74f1a2b3c4d5e6f7a8b9c0d2",
	name: "Field notes",
	slug: "weekly",
	fromEmail: "jane@example.net",
	postalAddress: "1 Main St, Paris",
	language: "en",
	languageRegion: null,
};
const campaign = { _id: "84f1a2b3c4d5e6f7a8b9c0d3", format: "markdown", subject: "Issue 12", markdown: "Hello", archiveSlug: "issue-12" };
const brazilian = { _id: "e0000000000000000000000a", language: "pt", languageRegion: "BR", subject: "Edição 12", format: "markdown", markdown: "Olá" };

test("each contact gets the edition in their language, else the one in the newsletter's, else nothing", () => {
	const matcher = getEditionMatcher({ campaign, newsletter, editions: [brazilian] });
	assert.equal(matcher.languages, null, "everyone gets something");
	assert.equal(matcher.pick({ language: null }), null, "without a language, the newsletter's");
	assert.equal(matcher.pick({ language: "en", languageRegion: "US" }), null);
	assert.equal(matcher.pick({ language: "pt", languageRegion: "PT" }), brazilian._id);
	assert.equal(matcher.pick({ language: "de" }), null, "the newsletter's English");
	assert.deepEqual(describeAudience(matcher, [{ language: "en", contacts: 5 }, { language: "pt", contacts: 2 }, { language: "de", contacts: 1 }]), [
		{ language: "en", contacts: 5, edition: "en" },
		{ language: "pt", contacts: 2, edition: "pt-BR" },
		{ language: "de", contacts: 1, edition: "en" },
	]);

	const portuguese = getEditionMatcher({ campaign: { ...campaign, language: "pt" }, newsletter: { ...newsletter, languageRegion: "US" } });
	assert.equal(portuguese.own, "pt");
	assert.deepEqual(portuguese.languages, ["pt"]);
	assert.equal(portuguese.pick({ language: "pt", languageRegion: "BR" }), null);
	assert.equal(portuguese.pick({ language: null }), undefined, "nothing in the newsletter's English: its readers get nothing");
	assert.equal(portuguese.pick({ language: "de" }), undefined);

	const british = getEditionMatcher({ campaign: { ...campaign, language: "en", languageRegion: "GB" }, newsletter: { ...newsletter, languageRegion: "US" } });
	assert.equal(british.pick({ language: "de" }), null, "the newsletter's en-US reads en-GB");
});

test("editions are checked like the campaign, can't share its language, and don't link to its archive page", () => {
	assert.equal(getCampaignSendProblem({ campaign, editions: [brazilian], newsletter }), null);
	assert.equal(
		getCampaignSendProblem({ campaign, editions: [{ ...brazilian, subject: " " }], newsletter }),
		"Portuguese (Brazil) edition: add a subject"
	);
	assert.equal(
		getCampaignSendProblem({ campaign: { ...campaign, language: "pt", languageRegion: "BR" }, editions: [brazilian], newsletter }),
		"The Portuguese (Brazil) edition is in the campaign's own language: delete it or change the campaign's"
	);

	const archived = { ...newsletter, archiveEnabled: true };
	assert.equal(getIssueWebUrl({ campaign, newsletter: archived }), "https://mail.example.com/archive/weekly/p/issue-12");
	const edition = getEditionContent(campaign, brazilian);
	assert.deepEqual([edition.subject, edition.markdown, edition.archiveSlug], ["Edição 12", "Olá", "issue-12"]);
	assert.equal(getIssueWebUrl({ campaign: edition, newsletter: archived }), null);
});
