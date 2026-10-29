import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { CONFIRM_URL_PLACEHOLDER } from "../lib/confirmation-content.js";
import { getEditionMatcher } from "../lib/editions.js";
import { KEEP_URL_PLACEHOLDER } from "../lib/last-chance-content.js";
import { SAMPLE_READER, fillForReader } from "../lib/merge-tags.js";
import { getEditionNote, previewForReader, toPreviewFrame } from "../lib/preview-reader.js";
import { insertRow } from "../lib/records.js";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail } from "../lib/render-email.js";
import { buildRecipientEmail } from "../lib/sending-rules.js";
import { activate, as, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";

process.env.BETTER_AUTH_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.APP_URL = "https://mail.example.com";

const NEWSLETTER = { _id: "74f1a2b3c4d5e6f7a8b9c0d2", name: "Field notes", fromEmail: "jane@example.net", postalAddress: "1 Main St, Paris" };
const CAMPAIGN = {
	format: "rich",
	subject: "{{first_name|Friend}}, issue 12",
	previewText: "For {{ first_name | you }} {{last_name}}",
	html: "<p>Hi {{first_name|there}} {{last_name}}, {{FIRST_NAME}}!</p><p>Tom &amp; {{first_name|Jerry &amp; co}}</p>",
};
// As the campaign editor hands it to the preview, from the draft.
const CONTENT = { ...CAMPAIGN, newsletter: NEWSLETTER };

function bodyOf(html) {
	return /<td class="body">([\s\S]*?)<\/td><\/tr>/.exec(html)?.[1];
}

function preheaderOf(html) {
	return /<div [^>]*data-preheader>([\s\S]*?)<\/div>/.exec(html)?.[1];
}

describe("the preview's reader", () => {
	test("a reader's preview is their own copy of the email: the subject, the preview text and the content", () => {
		const readers = [
			{ firstName: "Jo & Co", lastName: "Doe" },
			{ firstName: '<img src=x onerror="alert(1)">', lastName: null },
			{ firstName: "Zoë" },
			{ firstName: "", lastName: "Solo" },
			{ firstName: "   " },
			{},
			SAMPLE_READER,
		];
		for (const reader of readers) {
			const contact = { _id: "64f1a2b3c4d5e6f7a8b9c0d1", email: "jo@example.com", ...reader };
			const sent = buildRecipientEmail({ campaign: CAMPAIGN, newsletter: NEWSLETTER, contact });
			const shown = previewForReader(CONTENT, reader);
			const label = JSON.stringify(reader);
			assert.ok(bodyOf(shown.html) && preheaderOf(shown.html), label);
			assert.equal(shown.subject, sent.subject, label);
			assert.equal(bodyOf(shown.html), bodyOf(sent.html), label);
			assert.equal(preheaderOf(shown.html), preheaderOf(sent.html), label);
			assert.ok(!/\{\{\s*(first|last)_name/i.test(shown.html + shown.subject + shown.previewText), label);
		}
	});

	test("names are escaped in the email and kept as text in the subject, and readers without a name get the fallbacks", () => {
		const hostile = previewForReader(CONTENT, { firstName: '<img src=x onerror="alert(1)">', lastName: "<b>" });
		assert.ok(bodyOf(hostile.html).startsWith("<p>Hi &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &lt;b&gt;,"), bodyOf(hostile.html));
		assert.ok(!hostile.html.includes("<img src=x"));
		assert.equal(hostile.subject, '<img src=x onerror="alert(1)">, issue 12', "the subject is text, which the preview prints as text");

		const nameless = previewForReader(CONTENT, { firstName: null, lastName: null });
		assert.equal(nameless.subject, "Friend, issue 12");
		assert.equal(nameless.previewText, "For you");
		assert.equal(bodyOf(nameless.html), "<p>Hi there,!</p><p>Tom &amp; Jerry &amp; co</p>");

		const sample = previewForReader(CONTENT, SAMPLE_READER);
		assert.deepEqual([sample.subject, sample.previewText], ["Jane, issue 12", "For Jane Doe"]);
		assert.equal(bodyOf(sample.html), "<p>Hi Jane Doe, Jane!</p><p>Tom &amp; Jane</p>");
		assert.deepEqual(fillForReader({ subject: CAMPAIGN.subject, previewText: CAMPAIGN.previewText }, SAMPLE_READER), {
			subject: "Jane, issue 12",
			previewText: "For Jane Doe",
		});
		assert.throws(() => (SAMPLE_READER.firstName = "Mallory"), TypeError, "one sample reader for every preview");
	});

	test("a contact the send gives another language's email, or nothing, is told so above the one on screen", () => {
		const english = { name: "Field notes", language: "en", languageRegion: null };
		// An English campaign with a Brazilian Portuguese edition, previewed in English, then in Portuguese.
		const matcher = getEditionMatcher({ campaign: { language: "en" }, newsletter: english, editions: [{ language: "pt", languageRegion: "BR" }] });
		const note = (contact, shown = "en") => getEditionNote({ matcher, shown, contact });
		assert.equal(note({ email: "ana@example.com", firstName: "Ana", language: "pt-PT" }), "Ana gets the Portuguese (Brazil) email");
		assert.equal(note({ email: "ana@example.com", firstName: "Ana", language: "pt-PT" }, "pt-BR"), null);
		assert.equal(note({ email: "bo@example.com", language: null }), null, "without a language, the newsletter's");
		assert.equal(note({ email: "bo@example.com", language: "de" }), null, "nothing in German: the newsletter's English");
		assert.equal(note({ email: "bo@example.com", language: "de" }, "pt-BR"), "bo@example.com gets the English email");

		const portugueseOnly = getEditionMatcher({ campaign: { language: "pt" }, newsletter: english });
		assert.equal(
			getEditionNote({ matcher: portugueseOnly, shown: "pt", contact: { email: "bo@example.com", firstName: "Bo", language: "de" } }),
			"Bo is left out: nothing in their language or the newsletter's"
		);
	});

	test("a preview's links to unsubscribe, confirm or stay go nowhere, and its pictures fit the frame", () => {
		const html = renderEmail({ markdown: `[Confirm](${CONFIRM_URL_PLACEHOLDER}) [Keep](${KEEP_URL_PLACEHOLDER})`, newsletter: NEWSLETTER }).html;
		assert.ok(html.includes(UNSUBSCRIBE_PLACEHOLDER));
		const frame = toPreviewFrame(html);
		for (const placeholder of [UNSUBSCRIBE_PLACEHOLDER, CONFIRM_URL_PLACEHOLDER, KEEP_URL_PLACEHOLDER]) assert.ok(!frame.includes(placeholder), placeholder);
		assert.ok(frame.includes('href="#"'));
		assert.ok(frame.includes("<style>img{max-width:100%;height:auto}</style>"));
	});
});

describe("picking a contact to preview as", () => {
	let app;
	let m;
	let user;
	let otherNewsletterId;

	async function newsletter(owner, slug) {
		const url = await as(owner, () =>
			catchRedirect(
				m.newsletters.saveNewsletter(null, form({ name: slug, slug, fromName: "Field notes", fromEmail: `hello@${slug}.mailcheapmail.com`, postalAddress: "1 Main St, Paris" }))
			)
		);
		return url.split("/").at(-1);
	}

	function find(query, newsletterId = user.newsletterId) {
		return as(user, () => m.campaigns.findPreviewContacts(newsletterId, query));
	}

	async function emails(query) {
		const result = await find(query);
		assert.ok(result.contacts, JSON.stringify(result));
		return result.contacts.map(({ email }) => email);
	}

	before(async () => {
		app = await startTestApp();
		m = {
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			campaigns: await import("../app/(app)/campaigns/actions.js"),
		};
		user = await signIn("preview-reader@example.com");
		await activate(user);
		user.newsletterId = await newsletter(user, "preview-reader");
		otherNewsletterId = await newsletter(user, "preview-reader-two");

		const daysAgo = (days) => new Date(Date.now() - days * 86_400_000);
		const contact = (fields) => insertRow("contacts", { accountId: user.accountId, newsletterId: user.newsletterId, status: "active", ...fields });
		await contact({ email: "jo@example.com", firstName: "Jo", subscribedAt: daysAgo(5) });
		await contact({ email: "joanna@example.com", firstName: "Joanna", lastName: "Silva", language: "pt", languageRegion: "BR", subscribedAt: daysAgo(1) });
		await contact({ email: "jose@example.com", subscribedAt: daysAgo(2) });
		await contact({ email: "a.b@example.com", subscribedAt: daysAgo(3) });
		await contact({ email: "a_b@example.com", subscribedAt: daysAgo(4) });
		await contact({ email: "a%b@example.com", subscribedAt: daysAgo(6) });
		await contact({ email: "html@example.com", firstName: "<b>Bo</b> & co", subscribedAt: daysAgo(7) });
		for (const day of [8, 9, 10]) await contact({ email: `old${day}@example.com`, subscribedAt: daysAgo(day) });
		await contact({ email: "johnny@example.com", status: "unsubscribed", subscribedAt: daysAgo(0) });
		await contact({ email: "jon@example.com", status: "bounced", subscribedAt: daysAgo(0) });
		await contact({ email: "jody@example.com", status: "pending", subscribedAt: daysAgo(0) });
		await contact({ email: "jolene@example.com", newsletterId: otherNewsletterId, subscribedAt: daysAgo(0) });
	});

	after(() => app?.stop());

	test("the picker offers the newsletter's newest active contacts, or finds them by the start of their address", async () => {
		assert.deepEqual(await emails(""), [
			"joanna@example.com",
			"jose@example.com",
			"a.b@example.com",
			"a_b@example.com",
			"jo@example.com",
			"a%b@example.com",
			"html@example.com",
			"old8@example.com",
		], "the 8 newest");
		assert.deepEqual(await emails("jo"), ["joanna@example.com", "jose@example.com", "jo@example.com"]);
		assert.deepEqual(await emails("  JO@ "), ["jo@example.com"], "in any case, around spaces");
		assert.deepEqual(await emails("anna"), [], "only the start");
		assert.deepEqual(await emails("silva"), [], "not by name");
		const [joanna] = (await find("joanna")).contacts;
		assert.deepEqual(
			joanna,
			{ id: joanna.id, email: "joanna@example.com", firstName: "Joanna", lastName: "Silva", language: "pt-BR" },
			"only what the preview needs: the name its tags take, and the language its edition follows"
		);
		assert.match(joanna.id, /^[0-9a-f]{24}$/);
		const [jose] = (await find("jose")).contacts;
		assert.deepEqual(jose, { id: jose.id, email: "jose@example.com", firstName: null, lastName: null, language: null });
	});

	test("unsubscribed, bounced, unconfirmed and another newsletter's contacts aren't offered, and a newsletter is needed", async () => {
		assert.deepEqual(await emails("johnny"), []);
		assert.deepEqual(await emails("jon@"), []);
		assert.deepEqual(await emails("jody"), []);
		assert.deepEqual(await emails("jolene"), []);
		assert.deepEqual((await find("jolene", otherNewsletterId)).contacts.map(({ email }) => email), ["jolene@example.com"]);
		for (const missing of ["", "  ", null, undefined, "000000000000000000000000"]) {
			const result = await as(user, () => m.campaigns.findPreviewContacts(missing, "jo"));
			assert.deepEqual(result, { error: "Newsletter not found" }, `${missing}: never every newsletter's contacts`);
		}
	});

	test("what's typed is only ever text: never a pattern or an operator", async () => {
		assert.deepEqual(await emails("a.b"), ["a.b@example.com"], "a dot is a dot");
		assert.deepEqual(await emails("a_"), ["a_b@example.com"], "an underscore is an underscore");
		assert.deepEqual(await emails("a%"), ["a%b@example.com"]);
		for (const query of ["%", "_", "*", ".*", "' OR 1=1 --", "[a-z]", "\\"]) {
			assert.deepEqual(await emails(query), [], query);
		}
		assert.deepEqual((await find({ $gt: "" })).contacts, [], "an object is read as text");
		assert.deepEqual((await find("x".repeat(500))).contacts, [], "a long text is cut, not refused");
	});

	test("the preview fills a picked contact's name the way their email gets it", async () => {
		const [bo] = (await find("html@")).contacts;
		const shown = previewForReader(CONTENT, bo);
		assert.equal(shown.subject, "<b>Bo</b> & co, issue 12");
		assert.ok(bodyOf(shown.html).startsWith("<p>Hi &lt;b&gt;Bo&lt;/b&gt; &amp; co,"), "a contact's name is text in the email");
		const [jose] = (await find("jose")).contacts;
		assert.equal(previewForReader(CONTENT, jose).subject, "Friend, issue 12", "without a name, the fallback");
	});
});
