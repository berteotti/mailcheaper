import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getLinkKey } from "../lib/link-stats.js";

const { default: CampaignReport } = await import("../components/CampaignReport.jsx");
const { TooltipProvider } = await import("../components/ui/tooltip.jsx");

const ID = "6ad87a2affc219b3be2cc72c";
const STATS = { recipients: 1000, sent: 1000, delivered: 990, opened: 462, clicked: 70, bounced: 10, complained: 1, unsubscribed: 4 };
const NEWSLETTER = { _id: "6ad87a2affc219b3be2cc72d", name: "Weekly", fromName: "Weekly", fromEmail: "hi@example.com" };

// The header's buttons have tooltips, which need the dashboard's provider.
function renderReport(props = {}) {
	return renderToStaticMarkup(
		createElement(
			TooltipProvider,
			null,
			createElement(CampaignReport, {
				campaign: { _id: ID, subject: "Hello", status: "sent", format: "markdown", markdown: "Hi", stats: STATS },
				newsletter: NEWSLETTER,
				providers: [],
				links: null,
				comparison: { isSettled: true, issues: 3, delta: { opened: 0.042, clicked: -0.004 }, average: { opened: 0.42, clicked: 0.074 } },
				timeZone: "UTC",
				...props,
			})
		)
	);
}

const card = (label) => `>${label}</span>`;

test("the report's cards are delivered, opened, clicked, bounced and unsubscribed, with complaints by inbox", () => {
	const html = renderReport({ providers: [{ provider: "gmail", sent: 1000, delivered: 990, opened: 462, clicked: 70, bounced: 10, complained: 1 }] });
	const cards = ["Delivered", "Opened", "Clicked", "Bounced", "Unsubscribed"].map((label) => html.indexOf(card(label)));
	assert.ok(cards.every((index, position) => index > (cards[position - 1] ?? -1)), "all five, in that order");
	assert.ok(!html.includes(card("Complaints")), "no complaints card");
	assert.match(html, />Complaints<\/th>/, "complaints by inbox");
});

test("the Delivered card says how many emails weren't delivered, when bounces don't explain them all", () => {
	const stats = { recipients: 22, sent: 22, delivered: 20, opened: 7, clicked: 0, bounced: 1, complained: 0, unsubscribed: 0 };
	const html = renderReport({ campaign: { _id: ID, subject: "Hello", status: "sent", format: "markdown", markdown: "Hi", stats } });
	assert.ok(html.includes(">20 · 1 not delivered</span>"), "one still on its way or refused for now, on top of the bounce");
	assert.ok(!renderReport().includes("not delivered"), "every email delivered or bounced");
});

// Each tab's label and whether it's the open one, in order.
function tabsOf(html) {
	return [...html.matchAll(/<button([^>]*role="tab"[^>]*)>([\s\S]*?)<\/button>/g)].map(([, attributes, inner]) => [
		inner.replace(/<[^>]*>/g, ""),
		attributes.includes('aria-selected="true"'),
	]);
}

// What a tab's panel holds, up to the next one.
function panelOf(html, value) {
	const start = html.search(new RegExp(`id="[^"]*-content-${value}"`));
	if (start < 0) return "";
	const end = html.indexOf('role="tabpanel"', start);
	return html.slice(start, end < 0 ? undefined : end);
}

test("the report's numbers stay on top, and its details are in tabs: Timeline open, then Links, Inboxes, Languages and Archive", () => {
	const html = renderReport({
		campaign: { _id: ID, subject: "Hello", status: "sent", format: "markdown", markdown: "Read [the post](https://example.com/post).", stats: STATS, archiveSlug: "hello", webViews: 1204 },
		newsletter: { ...NEWSLETTER, slug: "weekly", archiveEnabled: true },
		providers: [{ provider: "gmail", sent: 600, delivered: 595, opened: 300, clicked: 50, bounced: 5, complained: 0 }],
		languages: [
			{ language: "en", sent: 700, delivered: 695, opened: 350, clicked: 50, bounced: 5, complained: 0 },
			{ language: "pt-BR", sent: 300, delivered: 295, opened: 112, clicked: 20, bounced: 5, complained: 1 },
		],
		links: { links: [{ key: "post", url: "https://example.com/post", clickers: 40, clicks: 50 }], clickers: 40, isComplete: true },
		timeline: { hours: [{ at: new Date(), opens: 3, clicks: 1 }], later: { opens: 0, clicks: 0 } },
	});
	assert.deepEqual(tabsOf(html), [
		["Timeline", true],
		["Links", false],
		["Inboxes", false],
		["Languages", false],
		["Archive", false],
	]);
	assert.ok(html.indexOf(card("Unsubscribed")) < html.indexOf('role="tablist"'), "the numbers come first, whatever tab is open");
	assert.match(panelOf(html, "timeline"), />After sending</);
	const links = panelOf(html, "links");
	assert.match(links, /40 contacts clicked a link/);
	assert.match(links, />Link<\/th>/);
	assert.match(links, />https:\/\/example.com\/post<|>example.com\/post</);
	assert.match(panelOf(html, "inboxes"), />Inbox<\/th>/);
	assert.match(panelOf(html, "languages"), />Portuguese \(Brazil\)<|>Brazilian Portuguese</);
	assert.match(panelOf(html, "archive"), />1,204</, "the page's views");
	assert.match(panelOf(html, "archive"), /value="hello"/, "and its address, to change");

	const quiet = renderReport({ campaign: { _id: ID, subject: "Hello", status: "sent", format: "markdown", markdown: "Hi", stats: STATS } });
	assert.deepEqual(
		tabsOf(quiet).map(([label]) => label),
		["Timeline", "Links", "Inboxes"],
		"no Languages tab for an issue in one language, and no Archive tab for an issue off the archive"
	);
	assert.match(panelOf(quiet, "links"), /No clicks yet/);
	const unsent = renderReport({ campaign: { _id: ID, subject: "Hello", status: "paused", format: "markdown", markdown: "Hi", stats: { recipients: 0, sent: 0 } } });
	assert.doesNotMatch(unsent, /role="tablist"/, "nothing to break down before an email goes out");
});

test("a link shows what the email shows for it, in the campaign or in an edition", () => {
	const link = (url, clickers) => ({ key: getLinkKey(url), url, clickers, clicks: clickers });
	const html = renderReport({
		campaign: { _id: ID, subject: "Hello", status: "sent", format: "markdown", markdown: "Read [the post](https://example.com/post?utm_source=x).", stats: STATS },
		editions: [{ language: "pt", format: "markdown", subject: "Olá", previewText: "", markdown: "Veja [a loja](https://example.com/loja)." }],
		links: {
			links: [link("https://example.com/post", 2), link("https://example.com/loja", 1), link("javascript:alert(1)", 1)],
			clickers: 3,
			isComplete: false,
			countedSince: "2026-10-01T10:00:00.000Z",
		},
	});
	const links = panelOf(html, "links");
	assert.match(links, />the post<\/span>[\s\S]*>example.com\/post<\/a>/, "its text, over its address");
	assert.match(links, />a loja<\/span>/, "an edition's link, as the edition shows it");
	assert.ok(links.indexOf("example.com/post") < links.indexOf("example.com/loja"), "most clicked first");
	assert.ok(!links.includes('href="javascript:'), "a stored javascript: address never becomes a link");
	assert.ok(links.includes("javascript:alert(1)"), "it still shows, as text");
	assert.match(links, /Counted since Oct 1, 2026/, "an issue sent before clicks were counted per link says since when");
});

test("the report compares opens and clicks with the average in percent, never in points", () => {
	const html = renderReport();
	assert.ok(html.includes("+4.2%"));
	assert.ok(html.includes("−0.4%"));
	assert.ok(!/\bpts\b/.test(html));
	assert.ok(!renderReport({ comparison: { isSettled: false, issues: 3, delta: { opened: 0.042, clicked: 0 }, average: { opened: 0.4, clicked: 0 } } }).includes("vs avg"), "not while its opens still come in");
});
