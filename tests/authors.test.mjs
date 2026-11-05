import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_AUTHOR_NAME_LENGTH, describeAuthorPlaces, getAuthorByline, getAuthorProblem, readAuthorName } from "../lib/author-rules.js";
import { getOne } from "../lib/db.js";
import { renderEmail } from "../lib/render-email.js";
import { activate, as, callApi, catchRedirect, form, queued, signIn, startTestApp } from "./helpers/app.mjs";
import { sent } from "./stubs/ses.mjs";

// Who writes a newsletter's issues (lib/authors.js): their name and picture at the top of an issue's emails and under
// the title of its page, where they show, and their address as the issue's Reply-To, never shown. An issue without one
// goes out as before.
const PICTURE = "https://cdn.example.com/jane.webp";
const newsletter = { name: "Field notes", postalAddress: "1 Main St, Paris" };

describe("an author's fields", () => {
	test("a name is one line of plain text, 60 characters at most, with no braces or angle brackets", () => {
		assert.equal(MAX_AUTHOR_NAME_LENGTH, 60);
		assert.equal(readAuthorName("  Jane\n\tDoe​ "), "Jane Doe");
		assert.deepEqual(getAuthorProblem({ name: readAuthorName("​") }), { field: "name", message: "Add their name" });
		assert.equal(getAuthorProblem({ name: "x".repeat(60) }), null);
		assert.deepEqual(getAuthorProblem({ name: "x".repeat(61) }), { field: "name", message: "60 characters at most" });
		for (const name of ["{{unsubscribe_url}}", "Jane {FNAME}", "<b>Jane</b>", "Jane <jane@example.com>"]) {
			assert.deepEqual(getAuthorProblem({ name }), { field: "name", message: "No braces or angle brackets" }, name);
		}
		assert.equal(getAuthorProblem({ name: "Zoë O'Brien & co." }), null);
	});

	test("an address that takes email, and a picture at an https:// address that can't end an attribute", () => {
		assert.deepEqual(getAuthorProblem({ email: "not-an-email" }), { field: "email", message: "Add a valid email address" });
		assert.equal(getAuthorProblem({ email: "jane@example.com" }), null);
		for (const imageUrl of ["http://cdn.example.com/a.png", "javascript:alert(1)", 'https://cdn.example.com/a.png" onerror="x', "https://a b.example.com"]) {
			assert.deepEqual(getAuthorProblem({ imageUrl }), { field: "imageUrl", message: "Use an https:// image URL" }, imageUrl);
		}
		assert.equal(getAuthorProblem({ imageUrl: PICTURE }), null);
		assert.equal(getAuthorProblem({ imageUrl: "" }), null, "no picture");
	});

	test("readers see their name and picture where they show, never their address", () => {
		const jane = { name: "Jane", email: "jane@example.com", imageUrl: PICTURE, showInEmails: true, showOnWeb: false };
		assert.deepEqual(getAuthorByline(jane, "email"), { name: "Jane", imageUrl: PICTURE });
		assert.equal(getAuthorByline(jane, "web"), null);
		assert.deepEqual(getAuthorByline({ ...jane, imageUrl: undefined, showOnWeb: true }, "web"), { name: "Jane", imageUrl: null });
		assert.equal(getAuthorByline(null, "email"), null, "an issue without an author");

		assert.equal(describeAuthorPlaces({ showOnWeb: true, showInEmails: true }), null);
		assert.equal(describeAuthorPlaces({ showOnWeb: true, showInEmails: false }), "Shown on the web only");
		assert.equal(describeAuthorPlaces({ showOnWeb: false, showInEmails: true }), "Shown in emails only");
		assert.equal(describeAuthorPlaces({ showOnWeb: false, showInEmails: false }), "Not shown to readers");
	});
});

describe("the byline in emails", () => {
	const email = { markdown: "Hello **readers**.", subject: "Hi", previewText: "This week", newsletter, webUrl: "https://notes.example.com/p/hi" };

	test("By and their name above the content, after their picture, in the HTML and the text", () => {
		const { html, text } = renderEmail({ ...email, author: { name: "Tom & Jerry", imageUrl: PICTURE } });
		assert.match(html, /<img src="https:\/\/cdn\.example\.com\/jane\.webp" width="24" height="24" alt=""/);
		assert.match(html, />By Tom &amp; Jerry<\/span>/);
		assert.ok(html.indexOf("By Tom") < html.indexOf("Hello"), "above the content");
		assert.match(html, /Read online/, "next to the link to its page");
		assert.match(text, /^Read online: https:\/\/notes\.example\.com\/p\/hi\n\nBy Tom & Jerry\n\nHello readers\./);

		const html5 = renderEmail({ ...email, format: "html", html: "<html><body><p>Hello</p></body></html>", author: { name: "Jane", imageUrl: null } }).html;
		assert.match(html5, /<body>.*>By Jane<\/span><\/div>.*<p>Hello<\/p>/s, "above an email designed elsewhere too");
		assert.doesNotMatch(html5, /<img/);
	});

	test("a picture that isn't at an https:// address is left out, and emails without an author are as they were", () => {
		const { html } = renderEmail({ ...email, author: { name: "Jane", imageUrl: "javascript:alert(1)" } });
		assert.doesNotMatch(html, /<img/);
		assert.match(html, />By Jane<\/span>/);

		const without = renderEmail(email);
		assert.deepEqual(renderEmail({ ...email, author: null }), without);
		assert.doesNotMatch(without.html, />By /);
		assert.doesNotMatch(renderEmail({ ...email, author: { name: "Jane" }, isWebVersion: true }).html, />By /, "its page shows its own");
	});
});

let app;
let m;
let processed = 0;

async function runJobs() {
	while (processed < queued.length) {
		const body = queued[processed++];
		await m.jobs.queue({ messages: [{ body, attempts: 1, ack() {}, retry() {} }] });
	}
}

async function api(user, method, path, body) {
	return callApi(method, `/api/v1${path}`, { key: user.key, body });
}

async function customer(email) {
	const user = await signIn(email);
	await activate(user);
	const slug = email.split("@")[0];
	const url = await as(user, () =>
		catchRedirect(
			m.newsletters.saveNewsletter(
				null,
				form({ name: `${slug} news`, slug, fromEmail: `hello@${slug}.mailcheapmail.com`, postalAddress: "1 Main St, Paris", archiveEnabled: "on" })
			)
		)
	);
	user.newsletterId = url.split("/").at(-1);
	user.slug = slug;
	await as(user, () => m.contacts.importContacts({ newsletterId: user.newsletterId, consent: true, rows: [{ email: `reader@${slug}.example.org`, status: "active" }] }));
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	return user;
}

async function draft(user, subject = "Issue") {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const id = url.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject, previewText: "This week", body: "<p>Hello</p>" }));
	return id;
}

const load = (user, id) => getOne("SELECT * FROM campaigns WHERE accountId = ? AND _id = ?", [user.accountId, id]);
const emailsTo = (to, from) => sent.slice(from).filter((email) => [email.to].flat().includes(to));

before(async () => {
	app = await startTestApp();
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		jobs: (await import("../worker/jobs.js")).default,
		archive: await import("../lib/archive-data.js"),
		seo: await import("../lib/archive-seo.js"),
		BylineAuthor: (await import("../components/BylineAuthor.jsx")).default,
	};
});

after(() => app?.stop());

describe("the API", () => {
	test("adds, lists, changes and removes a newsletter's authors: the first is the default one, which new drafts start with", async () => {
		const user = await customer("authors-api@example.com");
		assert.deepEqual((await api(user, "GET", "/authors")).body, { authors: [] });
		const { body: noAuthor } = await api(user, "POST", "/campaigns", { subject: "Before" });
		assert.equal(noAuthor.authorId, null, "without authors, a draft has none");

		const created = await api(user, "POST", "/authors", { name: "  Jane\nDoe ", email: "Jane@Example.com", imageUrl: PICTURE });
		assert.equal(created.status, 201, JSON.stringify(created.body));
		const jane = created.body;
		assert.deepEqual([jane.name, jane.email, jane.imageUrl, jane.showOnWeb, jane.showInEmails, jane.isDefault], ["Jane Doe", "jane@example.com", PICTURE, true, true, true]);
		const sam = (await api(user, "POST", "/authors", { name: "Sam", email: "sam@example.com", showOnWeb: false })).body;
		assert.equal(sam.isDefault, false);
		assert.deepEqual((await api(user, "GET", "/authors")).body.authors.map(({ name }) => name), ["Jane Doe", "Sam"]);

		assert.equal((await api(user, "POST", "/campaigns", { subject: "Next" })).body.authorId, jane.id, "new drafts start with the default author");
		assert.equal((await api(user, "PATCH", `/authors/${sam.id}`, { isDefault: true })).body.isDefault, true);
		const { body: bySam } = await api(user, "POST", "/campaigns", { subject: "Sam's" });
		assert.equal(bySam.authorId, sam.id);
		assert.equal((await api(user, "PATCH", `/campaigns/${bySam.id}`, { author: jane.id })).body.authorId, jane.id);
		assert.equal((await api(user, "PATCH", `/campaigns/${bySam.id}`, { author: null })).body.authorId, null, "null takes the author off");
		assert.equal((await api(user, "POST", "/campaigns", { subject: "None", author: null })).body.authorId, null);

		assert.equal((await api(user, "PATCH", `/authors/${jane.id}`, { imageUrl: "" })).body.imageUrl, null, "an empty picture removes it");
		assert.equal((await api(user, "PATCH", `/authors/${jane.id}`, { name: "Jane {x}" })).body.error.code, "validation_failed");
		assert.equal((await api(user, "POST", "/authors", { name: "Bad", email: "nope" })).body.error.code, "validation_failed");

		assert.deepEqual((await api(user, "DELETE", `/authors/${sam.id}`)).body, { id: sam.id, deleted: true });
		const after = (await api(user, "GET", "/authors")).body.authors;
		assert.deepEqual(after.map(({ name, isDefault }) => [name, isDefault]), [["Jane Doe", true]], "the default author's place goes to the first of the others");
		assert.equal((await getOne("SELECT deletedAt FROM authors WHERE _id = ?", [sam.id])).deletedAt instanceof Date, true, "kept, with deletedAt");
		assert.equal((await api(user, "DELETE", `/authors/${sam.id}`)).status, 404);
	});

	test("an author writes for their own newsletter, in their own account", async () => {
		const user = await customer("authors-own@example.com");
		const stranger = await customer("authors-stranger@example.com");
		const theirs = (await api(stranger, "POST", "/authors", { name: "Not yours", email: "x@example.com" })).body;
		const { body: issue } = await api(user, "POST", "/campaigns", { subject: "Mine" });
		assert.equal((await api(user, "PATCH", `/campaigns/${issue.id}`, { author: theirs.id })).body.error.code, "not_found");
		assert.equal((await api(user, "PATCH", `/authors/${theirs.id}`, { name: "Mine now" })).status, 404);
		assert.equal((await api(user, "DELETE", `/authors/${theirs.id}`)).status, 404);
		assert.equal((await getOne("SELECT name FROM authors WHERE _id = ?", [theirs.id])).name, "Not yours");
	});
});

describe("writing and sending", () => {
	test("replies go to the author, and the emails say who wrote them where the author shows, never with their address", async () => {
		const user = await customer("author-replies@example.com");
		await api(user, "POST", "/authors", { name: "Jane Doe", email: "jane@example.com", imageUrl: PICTURE });
		const id = await draft(user);
		const before = sent.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		await runJobs();
		const tested = emailsTo("author-replies@example.com", before)[0];
		const issued = emailsTo("reader@author-replies.example.org", before)[0];
		for (const email of [tested, issued]) {
			assert.equal(email.replyTo, "jane@example.com");
			assert.match(email.html, />By Jane Doe<\/span>/);
			assert.ok(email.html.includes(`src="${PICTURE}"`));
			assert.match(email.text, /By Jane Doe/);
			assert.ok(!`${email.html}${email.text}`.includes("jane@example.com"), "their address is only where replies go");
		}

		const { body } = await api(user, "GET", "/authors");
		await api(user, "PATCH", `/authors/${body.authors[0].id}`, { showInEmails: false });
		const quiet = await draft(user, "Quiet issue");
		const from = sent.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(quiet)), { ok: true });
		const [email] = emailsTo("author-replies@example.com", from);
		assert.doesNotMatch(email.html, />By /, "not shown in emails");
		assert.equal(email.replyTo, "jane@example.com", "replies still reach them");
	});

	test("an issue without an author goes out as before: no byline, replies to the newsletter's reply-to", async () => {
		const user = await customer("author-none@example.com");
		const id = await draft(user);
		const before = sent.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		await runJobs();
		const [email] = emailsTo("reader@author-none.example.org", before);
		assert.doesNotMatch(email.html, />By /);
		assert.equal(email.replyTo, "author-none@example.com", "the shared address's replies go to the owner");
		assert.equal((await load(user, id)).sentAuthor, null);
	});

	test("a send keeps the author it started with, and the issue's page shows them as they are now, where they show", async () => {
		const user = await customer("author-page@example.com");
		const jane = (await api(user, "POST", "/authors", { name: "Jane Doe", email: "jane@example.com" })).body;
		const id = await draft(user);
		const before = sent.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		assert.deepEqual((await load(user, id)).sentAuthor, { name: "Jane Doe", email: "jane@example.com", showInEmails: true });

		const renamed = await as(user, () => m.campaigns.editAuthor(jane.id, { name: "Jane Smith", email: "smith@example.com", imageUrl: PICTURE }));
		assert.deepEqual([renamed.author.name, renamed.author.email, renamed.author.imageUrl], ["Jane Smith", "smith@example.com", PICTURE]);
		await runJobs();
		const [email] = emailsTo("reader@author-page.example.org", before);
		assert.match(email.html, />By Jane Doe<\/span>/, "its emails on their way stay as they were");
		assert.equal(email.replyTo, "jane@example.com");

		const shown = await getOne("SELECT * FROM newsletters WHERE accountId = ? AND _id = ?", [user.accountId, user.newsletterId]);
		const { archiveSlug } = await load(user, id);
		const issue = await m.archive.getArchiveIssue(shown, archiveSlug);
		assert.deepEqual(issue.author, { name: "Jane Smith", imageUrl: PICTURE });
		const jsonLd = JSON.stringify(m.seo.getIssueSeo(shown, issue));
		assert.match(jsonLd, /"@type":"Person","name":"Jane Smith"/);
		assert.ok(!jsonLd.includes("smith@example.com"), "never their address");
		const byline = renderToStaticMarkup(createElement(m.BylineAuthor, { author: issue.author }));
		assert.match(byline, /By <span[^>]*>Jane Smith<\/span>/);
		assert.match(byline, /<img[^>]+src="https:\/\/cdn\.example\.com\/jane\.webp"/);

		await as(user, () => m.campaigns.editAuthor(jane.id, { name: "Jane Smith", email: "smith@example.com", showOnWeb: false }));
		assert.equal((await m.archive.getArchiveIssue(shown, archiveSlug)).author, null, "not shown on the web: the newsletter's own byline instead");
	});

	test("removing an author waits for their scheduled issues, and their drafts then go out without a byline", async () => {
		const user = await customer("author-removed@example.com");
		const jane = (await api(user, "POST", "/authors", { name: "Jane Doe", email: "jane@example.com" })).body;
		const id = await draft(user);
		const at = new Date(Date.now() + 86_400_000).toISOString();
		assert.equal((await api(user, "POST", `/campaigns/${id}/schedule`, { scheduledAt: at })).status, 200);
		assert.equal((await api(user, "DELETE", `/authors/${jane.id}`)).body.error.code, "conflict");
		assert.equal((await api(user, "POST", `/campaigns/${id}/unschedule`)).status, 200);
		assert.deepEqual((await api(user, "DELETE", `/authors/${jane.id}`)).body, { id: jane.id, deleted: true });

		const before = sent.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
		const [email] = emailsTo("author-removed@example.com", before);
		assert.doesNotMatch(email.html, />By /);
		assert.equal(email.replyTo, "author-removed@example.com");
		assert.equal((await api(user, "POST", "/campaigns", { subject: "After" })).body.authorId, null, "no default author left");
	});

	test("a copy keeps its issue's author while they're still one", async () => {
		const user = await customer("author-copy@example.com");
		const jane = (await api(user, "POST", "/authors", { name: "Jane Doe", email: "jane@example.com" })).body;
		const id = await draft(user);
		const url = await as(user, () => catchRedirect(m.campaigns.duplicateCampaign(id)));
		assert.equal((await load(user, url.split("/").at(-1))).authorId, jane.id);
		await api(user, "DELETE", `/authors/${jane.id}`);
		const again = await as(user, () => catchRedirect(m.campaigns.duplicateCampaign(id)));
		assert.equal((await load(user, again.split("/").at(-1))).authorId, null);
	});
});
