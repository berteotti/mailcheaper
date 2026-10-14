import assert from "node:assert/strict";
import { test } from "node:test";
import { renderIssueBody } from "../lib/archive-content.js";
import { cleanRichHtml, removeUnsafeElements } from "../lib/clean-html.js";
import { markdownToHtml } from "../lib/markdown.js";
import { htmlToText } from "../lib/render-email.js";
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
		for (const run of [() => htmlToText(html), () => firstImageUrl({ format: "html", html }), () => removeUnsafeElements(html)]) {
			const { ms } = fastest(run, maxMs);
			assert.ok(ms < maxMs, `${label}: ${Math.round(ms)} ms, over ${Math.round(maxMs)} ms`);
		}
	});
}

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
