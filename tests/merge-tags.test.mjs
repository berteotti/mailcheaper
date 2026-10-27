import assert from "node:assert/strict";
import { test } from "node:test";
import { renderIssueBody } from "../lib/archive-content.js";
import { fillMergeTags } from "../lib/merge-tags.js";
import { UNSUBSCRIBE_PLACEHOLDER, escapeHtml, renderEmail } from "../lib/render-email.js";

const newsletter = { name: "Field notes", postalAddress: "1 Main St, Paris" };
const jane = { firstName: "Jane", lastName: "Doe" };

test("merge tags take the contact's name, else their fallback, else nothing", () => {
	assert.equal(fillMergeTags("Hi {{first_name|there}} {{last_name}}", jane), "Hi Jane Doe");
	assert.equal(fillMergeTags("Hi {{first_name|there}} {{last_name}}!", { firstName: "", lastName: null }), "Hi there!");
	assert.equal(fillMergeTags("Hi {{ First_Name | dear reader }}"), "Hi dear reader");
	assert.equal(fillMergeTags("{{first_name}}{{last_name|}}", {}), "");
	assert.equal(fillMergeTags("{{nickname}} {{unsubscribe_url}} {first_name} {{first_name|a{b}}", jane), "{{nickname}} {{unsubscribe_url}} {first_name} {{first_name|a{b}}");
	assert.equal(fillMergeTags(null, jane), null);
	assert.equal(fillMergeTags("{{first_name|<b>you</b>}} {{last_name}}", { lastName: "<i>" }, escapeHtml), "<b>you</b> &lt;i&gt;", "only the name is escaped");
});

test("a tag without a fallback goes with the spaces before it, and the elements it opens keep their place", () => {
	assert.equal(fillMergeTags("Hi {{first_name}}, welcome"), "Hi, welcome");
	assert.equal(fillMergeTags("Hi \t{{first_name|}}! {{last_name| }}"), "Hi!");
	assert.equal(fillMergeTags("Dear {{first_name}} {{last_name}}.", { lastName: "Doe" }), "Dear Doe.");
	assert.equal(fillMergeTags("Dear {{first_name}} {{last_name}}.", { firstName: "Jane" }), "Dear Jane.");
	assert.equal(fillMergeTags("Hi <strong><em>{{first_name}}</em></strong>,"), "Hi<strong><em></em></strong>,");
	assert.equal(fillMergeTags("Hi <strong><em>{{first_name}}</em></strong>,", jane), "Hi <strong><em>Jane</em></strong>,");
	assert.equal(fillMergeTags("Hello.\n\n{{first_name}}"), "Hello.\n\n", "never a line break");
	assert.equal(fillMergeTags('<img alt="{{first_name}}">'), '<img alt="">');

	const spaces = " ".repeat(200_000);
	const openings = "<b>".repeat(100_000);
	const started = Date.now();
	assert.equal(fillMergeTags(`a${spaces}b {{first_name}}`), `a${spaces}b`);
	assert.equal(fillMergeTags(` ${openings}x ${openings}{{first_name}}`), ` ${openings}x${openings}`);
	assert.ok(Date.now() - started < 1000, "long runs are read once");

	for (const content of [
		{ format: "markdown", markdown: "Hi **{{first_name}}**, welcome." },
		{ format: "rich", html: "<p>Hi <strong>{{first_name}}</strong>, welcome.</p>" },
		{ format: "html", html: "<html><head><title>{{subject}}</title></head><body><p>Hi <strong>{{first_name}}</strong>, welcome.</p></body></html>" },
	]) {
		const { html, text } = renderEmail({ ...content, subject: "Hi {{first_name}}, news", newsletter });
		assert.ok(html.includes("<p>Hi<strong></strong>, welcome.</p>"), content.format);
		assert.ok(html.includes("<title>Hi, news</title>"), content.format);
		assert.match(text, /^Hi, welcome\./, content.format);
		assert.match(renderEmail({ ...content, subject: "Hi {{first_name}}, news", newsletter, contact: jane }).text, /^Hi Jane, welcome\./, content.format);
	}
});

test("markdown, rich and HTML emails greet each contact by name in the content, subject and preview text", () => {
	const fields = { subject: "News for {{first_name|you}}", previewText: "{{first_name|Hey}}, this week", newsletter };
	for (const content of [
		{ format: "markdown", markdown: "Hi **{{first_name|there}} {{last_name}}**." },
		{ format: "rich", html: "<p>Hi <strong>{{first_name|there}} {{last_name}}</strong>.</p>" },
		{ format: "html", html: "<html><head><title>{{subject}}</title></head><body><p>{{preview_text}}</p><p>Hi {{first_name|there}} {{last_name}}.</p></body></html>" },
	]) {
		const named = renderEmail({ ...fields, ...content, contact: jane });
		assert.ok(!/{{(first|last)_name/.test(named.html + named.text), content.format);
		assert.match(named.html, /Hi (<strong>)?Jane Doe/, content.format);
		assert.match(named.text, /Hi Jane Doe\./, content.format);
		assert.ok(named.html.includes("<title>News for Jane</title>"), content.format);
		assert.ok(named.html.includes("Jane, this week"), content.format);
		assert.equal(named.bytes, Buffer.byteLength(named.html));

		const unnamed = renderEmail({ ...fields, ...content, contact: { firstName: null } });
		assert.match(unnamed.html, /Hi (<strong>)?there(<\/strong>)?\./, content.format);
		assert.ok(unnamed.html.includes("<title>News for you</title>"), content.format);
		assert.ok(unnamed.html.includes("Hey, this week"), content.format);
		assert.deepEqual(renderEmail({ ...fields, ...content }), unnamed, "no contact: the fallbacks");
	}
});

test("names are escaped in HTML and kept as they are in the text", () => {
	const contact = { firstName: `<img src=x onerror=alert(1)> & "Co"`, lastName: "{{first_name}} {{unsubscribe_url}}" };
	for (const content of [
		{ format: "markdown", markdown: "Hi {{first_name}} {{last_name}}" },
		{ format: "rich", html: "<p>Hi {{first_name}} {{last_name}}</p>" },
		{
			format: "html",
			html: '<html><head><title>{{subject}}</title></head><body><p title="{{first_name}}">Hi {{first_name}} {{last_name}}</p></body></html>',
		},
	]) {
		const { html, text } = renderEmail({ ...content, subject: "For {{first_name}}", newsletter, contact });
		assert.ok(!html.includes("<img src=x"), content.format);
		assert.ok(html.includes("Hi &lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;"), content.format);
		assert.ok(html.includes("<title>For &lt;img src=x"), "the subject too");
		assert.ok(text.includes(`Hi <img src=x onerror=alert(1)> & "Co" {{first_name}} ${UNSUBSCRIBE_PLACEHOLDER}`), "a name isn't filled in again");
	}
});

test("a fallback keeps its own characters in HTML and text", () => {
	const { html, text } = renderEmail({ markdown: "Hi {{first_name|y'all & friends}}", subject: "{{first_name|Tom & Jerry}}", newsletter });
	assert.ok(html.includes("Hi y&#39;all &amp; friends"));
	assert.ok(html.includes("<title>Tom &amp; Jerry</title>"));
	assert.ok(text.startsWith("Hi y'all & friends"));
});

test("archive pages show the fallback, never a tag or anyone's name", () => {
	const markdown = renderIssueBody({ format: "markdown", markdown: "Hi {{first_name|there}}{{last_name}}." });
	assert.ok(markdown.html.includes("<p>Hi there.</p>"));
	const rich = renderIssueBody({ format: "rich", html: "<p>Hi <b>{{first_name|reader}}</b></p>" });
	assert.ok(rich.html.includes("<p>Hi <b>reader</b></p>"));
	const html = renderIssueBody({
		format: "html",
		subject: "For {{first_name|you}}",
		html: "<html><head><title>{{subject}}</title></head><body><p>Hi {{first_name|there}}</p></body></html>",
	});
	assert.ok(html.html.includes("<title>For you</title>"));
	assert.ok(html.html.includes("<p>Hi there</p>"));
	for (const page of [markdown, rich, html]) assert.ok(!page.html.includes("{{"));
});
