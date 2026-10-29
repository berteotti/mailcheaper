import assert from "node:assert/strict";
import { test } from "node:test";
import { renderIssueBody } from "../lib/archive-content.js";
import { cleanBlockHtml, cleanRichHtml, removeUnsafeElements } from "../lib/clean-html.js";
import { findContentWarnings } from "../lib/content-warnings.js";
import { highlightHtml } from "../lib/highlight-html.js";
import { markdownToHtml } from "../lib/markdown.js";
import { findButtonProblem, hasContent, htmlToText, renderEmail } from "../lib/render-email.js";
import { firstImageUrl } from "../lib/thumbnail.js";

// Bodies as large as the API and the editor accept. Before, the first two took 6 s at 192 KB and 12 s
// at 384 KB, and some Markdown shapes took minutes.
const SIZE = 500_000;
// Each body may take this many times as long as an ordinary issue of the same size, timed in the same
// run so that a slow or busy machine slows both. Linear shapes take a few times as long at most, even
// where 500 KB becomes 2 MB of HTML to sanitize; quadratic ones, 40 times or more.
const MAX_SLOWDOWN = 20;
// marked stops after a second on the shapes it's quadratic on.
const MAX_MARKED_MS = 1000;

function repeat(unit) {
	return unit.repeat(Math.floor(SIZE / unit.length));
}

function nested(depth) {
	return `${"<scr".repeat(depth)}<script>alert(1)</script>${"ipt>".repeat(depth)}`;
}

function seededRandom(seed) {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

const PIECES = ["<", ">", "</", "<!--", "-->", "<script", "</script>", "<scr", "ipt>", "<style>", "<svg", "<link ", "<title>",
	"<head ", "<body ", "<div ", '<div id="web-header">', "</div>", "<a ", '<a href="', "</a>", "<img ", ' src="https://x.test/a.png"',
	"<p>", "</p>", " data-email-only", " data-preheader", "=", '"', "'", " ", "\n", "x", "*a", "_", "[", "](", "`", "> ", ":::box\n"];

function tagSoup(seed) {
	const random = seededRandom(seed);
	const pieces = [];
	for (let length = 0; length < SIZE; length += pieces.at(-1).length) pieces.push(PIECES[Math.floor(random() * PIECES.length)]);
	return pieces.join("");
}

const ORDINARY_ISSUE = repeat(
	'<h2>This week</h2><p>Hello <strong>there</strong>, read <a href="https://example.com/post">the post</a>.</p><ul><li>One</li><li>Two</li></ul><p><img src="https://example.com/a.png" alt="Chart"></p>'
);

const SHAPES = {
	"nested <scr<script>ipt>": nested(Math.floor(SIZE / 8)),
	"unclosed <script ": repeat("<script "),
	"unclosed <style>": repeat("<style>"),
	"unclosed comments": repeat("<!-- >"),
	"unclosed <link ": repeat("<link "),
	"unclosed <a ": repeat("<a "),
	"a run of <": repeat("<"),
	"a run of < ending in >": `${repeat("<")}>`,
	"unclosed <div ": repeat("<div "),
	"unclosed <body ": repeat("<body "),
	"unclosed <title>": repeat("<title>"),
	"unclosed <head ": repeat("<head "),
	"unclosed email-only parts": repeat("<a data-email-only>"),
	"tag soup 1": tagSoup(1),
	"tag soup 2": tagSoup(2),
	"tag soup 3": tagSoup(3),
};

const MARKDOWN_SHAPES = {
	"nested <scr<script>ipt>": SHAPES["nested <scr<script>ipt>"],
	"unclosed <script ": SHAPES["unclosed <script "],
	"a run of *a": repeat("*a"),
	"a run of *a and spaces": repeat("*a "),
	"unclosed boxes": repeat(":::box\n"),
	"nested quotes": repeat("> "),
	"a run of [a](": repeat("[a]("),
	"a run of <": SHAPES["a run of <"],
	"tag soup 1": SHAPES["tag soup 1"],
};

// The fastest of up to three runs, stopping at the first one under maxMs: a busy machine only adds time,
// and a slow algorithm is slow on every run.
function fastest(run, maxMs = 0) {
	let best = { ms: Infinity };
	for (let attempt = 0; attempt < 3 && best.ms >= maxMs; attempt += 1) {
		const startedAt = performance.now();
		const result = run();
		const ms = performance.now() - startedAt;
		if (ms < best.ms) best = { result, ms };
	}
	return best;
}

function assertNoUnsafeTags(html, label) {
	assert.doesNotMatch(html, /<\/?(script|style|svg|iframe|form|button|noscript|link)\b|<!--/i, label);
}

let maxMs;

test.before(() => {
	// Warms up the regex engine and marked, which the first call would otherwise pay for.
	renderIssueBody({ format: "rich", html: tagSoup(9).slice(0, 20_000) });
	renderIssueBody({ format: "markdown", markdown: tagSoup(9).slice(0, 20_000) });
	maxMs = MAX_SLOWDOWN * fastest(() => renderIssueBody({ format: "rich", html: ORDINARY_ISSUE })).ms;
});

for (const [label, html] of Object.entries(SHAPES)) {
	test(`archive pages render "${label}" (500 KB) in linear time`, () => {
		for (const campaign of [
			{ format: "rich", html },
			{ format: "html", html, subject: "Hi", source: "api" },
		]) {
			const { result, ms } = fastest(() => renderIssueBody(campaign), maxMs);
			assert.ok(ms < maxMs, `${label}, ${campaign.format}: ${Math.round(ms)} ms, over ${Math.round(maxMs)} ms`);
			if (result.kind === "article") assertNoUnsafeTags(result.html, label);
		}
	});

	test(`sending and saving read "${label}" (500 KB) in linear time`, () => {
		for (const run of [
			() => htmlToText(html),
			() => firstImageUrl({ format: "html", html }),
			() => removeUnsafeElements(html),
			() => findContentWarnings(html),
			() => findContentWarnings(html, { isDesigned: true }),
		]) {
			const { ms } = fastest(run, maxMs);
			assert.ok(ms < maxMs, `${label}: ${Math.round(ms)} ms, over ${Math.round(maxMs)} ms`);
		}
	});
}

// An editor's HTML block holding each shape, and shapes of its own: its inline styles and the block's marker.
const BLOCK_SHAPES = {
	...SHAPES,
	"a long inline style": `<p style="${repeat("color:red;")}">x</p>`,
	"a style of unclosed functions": `<p style="background:${repeat("linear-gradient(rgb(")}">x</p>`,
	"a style of short unclosed functions": `<p style="${repeat("color:rgb(1,;")}">x</p>`,
	"a link of unclosed merge tags": `<a href="https://x.test/${repeat("{{a")}">x</a>`,
	"a run of entities": `<p title="${repeat("&#x")}">${repeat("&a")}</p>`,
};

function escapeText(html) {
	return html.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

for (const [label, source] of Object.entries(BLOCK_SHAPES)) {
	test(`an HTML block of "${label}" (500 KB) renders in linear time`, () => {
		const html = `<div data-html-block="">${escapeText(source)}</div>`;
		// The email's own <style> is in its head, so only the page and the cleaned block are read for unsafe tags.
		for (const [run, read] of [
			[() => renderIssueBody({ format: "rich", html }), (result) => result.html],
			[() => cleanBlockHtml(source), (result) => result],
			[() => renderEmail({ format: "rich", html, subject: "Hi" })],
			[() => hasContent(html)],
			[() => highlightHtml(source)],
			[() => findContentWarnings(html)],
		]) {
			const { result, ms } = fastest(run, maxMs);
			assert.ok(ms < maxMs, `${label}: ${Math.round(ms)} ms, over ${Math.round(maxMs)} ms`);
			if (read) assertNoUnsafeTags(read(result), label);
		}
	});
}

// The editor's buttons (lib/buttons.js): each <div data-button> is read for one link, so its end and its link are looked
// up once whatever surrounds them.
const BUTTON_SHAPES = {
	"a run of button starts": repeat('<div data-button="">'),
	"buttons left open": repeat('<div data-button=""><a href="https://x.test">x'),
	"buttons with no link end": repeat('<div data-button=""><a href="https://x.test">x</div>'),
	"one button around everything": `<div data-button=""><a href="https://x.test">${repeat("</a> ")}</div>`,
	"a button of unclosed links": `<div data-button="">${repeat("<a ")}</div>`,
	"buttons with long links": repeat(`<div data-button=""><a href="https://x.test/${"a".repeat(2000)}">x</a></div>`),
};

for (const [label, html] of Object.entries(BUTTON_SHAPES)) {
	test(`an issue of "${label}" (500 KB) renders and is checked in linear time`, () => {
		for (const run of [
			() => renderIssueBody({ format: "rich", html }),
			() => renderEmail({ format: "rich", html, subject: "Hi" }),
			() => findButtonProblem(html),
			() => findContentWarnings(html),
		]) {
			const { ms } = fastest(run, maxMs);
			assert.ok(ms < maxMs, `${label}: ${Math.round(ms)} ms, over ${Math.round(maxMs)} ms`);
		}
	});
}

// The review step's warnings (lib/content-warnings.js) read each link, each HTML block's tags and the issue's text once,
// whatever their shape.
const WARNING_SHAPES = {
	"a link to a long host": `<a href="https://${repeat("a")}">x</a>`,
	"a link to a long dotted host": `<a href="https://${repeat("a.")}com">x</a>`,
	"a link of long dotted text": `<a href="https://x.test">${repeat("co.")}x</a>`,
	"a link of long text and slashes": `<a href="https://x.test">a.com${repeat("/a.com")} x</a>`,
	"a run of empty links": repeat('<a href="#"></a>'),
	"a run of mailto links": repeat('<a href="mailto:a@b">x</a>'),
	"a block of open tags": `<div data-html-block="">${repeat("&lt;div&gt;")}</div>`,
	"a block of open quotes": `<div data-html-block="">${repeat("&lt;a href=&quot;")}</div>`,
	"a block of open scripts": `<div data-html-block="">${repeat("&lt;script&gt;")}</div>`,
	"a block of open comments": `<div data-html-block="">${repeat("&lt;!--")}</div>`,
	"a block of images": `<div data-html-block="">${repeat("&lt;img src=x&gt;")}</div>`,
	"a run of brackets": `<p>${repeat("[your ")}</p>`,
	"a run of asterisks": `<p>${repeat("**a")}</p>`,
	"a run of Markdown links": `<p>${repeat("[a](https://")}</p>`,
	"a run of tags as text": `<p>${repeat("&lt;b ")}</p>`,
	"lines of #": repeat("<p># </p>"),
};

for (const [label, html] of Object.entries(WARNING_SHAPES)) {
	test(`the review step's warnings read "${label}" (500 KB) in linear time`, () => {
		const { ms } = fastest(() => findContentWarnings(html), maxMs);
		assert.ok(ms < maxMs, `${label}: ${Math.round(ms)} ms, over ${Math.round(maxMs)} ms`);
	});
}

test(`a run of HTML block markers (500 KB) renders in linear time`, () => {
	for (const html of [repeat('<div data-html-block="">'), repeat('<div data-html-block="">x'), `<div data-html-block="">${repeat("x")}`]) {
		for (const run of [() => renderIssueBody({ format: "rich", html }), () => renderEmail({ format: "rich", html, subject: "Hi" }), () => hasContent(html)]) {
			const { ms } = fastest(run, maxMs);
			assert.ok(ms < maxMs, `${Math.round(ms)} ms, over ${Math.round(maxMs)} ms`);
		}
	}
});

for (const [label, markdown] of Object.entries(MARKDOWN_SHAPES)) {
	test(`Markdown "${label}" (500 KB) renders in linear time`, (t) => {
		t.mock.method(console, "error", () => {});
		const maxMarkdownMs = MAX_MARKED_MS + maxMs;
		const { result, ms } = fastest(() => renderIssueBody({ format: "markdown", markdown }), maxMarkdownMs);
		assert.ok(ms < maxMarkdownMs, `${label}: ${Math.round(ms)} ms, over ${Math.round(maxMarkdownMs)} ms`);
		assertNoUnsafeTags(result.html, label);
		assert.ok(fastest(() => firstImageUrl({ format: "markdown", markdown }), maxMs).ms < maxMs, label);
	});
}

test("nesting deeper than the cleaner's passes still can't open a script", () => {
	for (const depth of [1, 7, 8, 9, 50]) {
		assert.doesNotMatch(removeUnsafeElements(nested(depth)), /<script/i, `depth ${depth}`);
		assert.doesNotMatch(cleanRichHtml(nested(depth)), /<|alert/, `depth ${depth}`);
	}
	assert.equal(removeUnsafeElements(nested(8)), "");
});

test("Markdown that marked can't parse in time shows as plain text", (t) => {
	t.mock.method(console, "error", () => {});
	assert.match(markdownToHtml(`${"> ".repeat(50_000)}<b>deep</b>`), /^<p>(&gt; )+&lt;b&gt;deep&lt;\/b&gt;<\/p>\n$/);
	assert.equal(markdownToHtml("Hello **world**"), "<p>Hello <strong>world</strong></p>\n");
});

test("a short Markdown email still renders on a slow, cold server", (t) => {
	let now = 0;
	t.mock.method(performance, "now", () => (now += 20));
	assert.equal(
		markdownToHtml("Welcome! **Reply** to [this](https://x.test).\n\n- One\n- Two"),
		'<p>Welcome! <strong>Reply</strong> to <a href="https://x.test">this</a>.</p>\n<ul>\n<li>One</li>\n<li>Two</li>\n</ul>\n'
	);
});

test("a box still ends the paragraph right above it", () => {
	assert.equal(markdownToHtml("Intro\n:::box\nInside\n:::\nOutro"), '<p>Intro</p>\n<div data-callout=""><p>Inside</p>\n</div>\n<p>Outro</p>\n');
});
