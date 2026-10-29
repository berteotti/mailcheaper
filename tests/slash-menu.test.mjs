import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MenuSlash, { getSlashItems } from "../components/MenuSlash.jsx";
import { fitMenu, getSlashMenu, listSlashOptions } from "../lib/editor-slash-menu.js";

// The editor's slash menu (components/MenuSlash.jsx, lib/editor-slash-menu.js): the blocks first, the names behind
// one entry, a search that reaches both, and where the menu shows.
const BLOCKS = ["Text", "Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "Image", "Quote", "Divider", "Box", "Button", "HTML"];

// What the arrows go through, in order: items by title, the menu's own rows by id (the entry to the names, and back from
// them).
function rows(query, { view = "blocks" } = {}) {
	return listSlashOptions(getSlashMenu(getSlashItems(), { query, view })).map((option) => (option.run ? option.title : option.id));
}

function render(query) {
	return renderToStaticMarkup(createElement(MenuSlash, { items: getSlashItems(), query, command: () => {} }));
}

test("the blocks come first, and the names wait behind one entry under them", () => {
	assert.deepEqual(rows(""), [...BLOCKS, "fields"]);
	const html = render("");
	assert.match(html, />Contact fields<\/span><span[^>]*>Filled in for each reader</);
	assert.ok(html.indexOf(">Box<") < html.indexOf(">Contact fields<"));
	for (const title of ["First name", "Last name"]) assert.ok(!html.includes(`>${title}<`), title);
});

test("inside the entry: back, then the first and last name", () => {
	assert.deepEqual(rows("", { view: "fields" }), ["back", "First name", "Last name"]);
	assert.deepEqual(rows("las", { view: "fields" }), ["back", "Last name"], "typing narrows them");
	assert.deepEqual(rows("zzz", { view: "fields" }), ["back"], "nothing found keeps the way back");
	const menu = getSlashMenu(getSlashItems(), { view: "fields" });
	assert.equal(menu.header.id, "back");
	assert.equal(menu.footer, null);
});

test("what's typed after the slash finds names by name or key, in a group of their own under the blocks", () => {
	assert.deepEqual(rows("first"), ["First name"]);
	assert.deepEqual(rows("LAST_N"), ["Last name"], "by key");
	assert.deepEqual(rows("field"), ["First name", "Last name"]);
	assert.deepEqual(rows("quote"), ["Quote"]);
	assert.deepEqual(rows("zzz"), []);

	const { groups, footer } = getSlashMenu(getSlashItems(), { query: "na" });
	assert.deepEqual(
		groups.map(({ label, items }) => [label, items.map(({ title }) => title)]),
		[["Contact fields", ["First name", "Last name"]]]
	);
	assert.equal(footer, null, "a search shows the names themselves, not the entry");

	const html = render("name");
	assert.match(html, /role="group" aria-labelledby="([^"]+)"><p id="\1"[^>]*>Contact fields<\/p>/);
	assert.ok(html.indexOf(">Contact fields<") < html.indexOf(">First name<"));
	assert.equal(render("zzz"), "", "nothing found, no menu");
});

test("a name inserts its tag without a fallback, and Button and HTML their blocks", () => {
	const items = getSlashItems();
	const insert = (title) => items.find((item) => item.title === title).run({ insertContent: (content) => content, setNode: (type) => type });
	assert.equal(insert("First name"), "{{first_name}}");
	assert.equal(insert("Last name"), "{{last_name}}");
	assert.equal(insert("Button"), "button");
	assert.deepEqual(insert("HTML"), { type: "htmlBlock", attrs: { isNew: true } });
});

test("the menu shows whole where it opens, and the page only moves when it fits neither below nor above the caret", () => {
	const caret = (top) => ({ top, bottom: top + 24 });
	const fit = (top, area) => fitMenu({ caret: caret(top), height: 320, area, gap: 4 });
	// A laptop's screen under the campaign's top bar.
	const area = { top: 80, bottom: 784 };
	assert.deepEqual(fit(300, area), { maxHeight: 676, scroll: 0 }, "below");
	assert.equal(fit(436, area).scroll, 0, "just fits below");
	assert.equal(fit(437, area).scroll, 0, "fits above instead");
	assert.equal(fit(736, area).scroll, 0, "at the bottom of the screen, above");

	const short = { top: 80, bottom: 544 };
	assert.equal(fit(110, short).scroll, 0, "below, on a short screen");
	assert.equal(fit(450, short).scroll, 0, "above, on a short screen");
	assert.deepEqual(fit(254, short), { maxHeight: 436, scroll: 58 }, "neither: just enough for its bottom to show");
	assert.equal(fitMenu({ caret: { top: 254, bottom: 276.4 }, height: 320, area: short, gap: 4 }).scroll, 57, "parts of a pixel count");
	assert.equal(fitMenu({ caret: { top: 60, bottom: 84 }, height: 900, area, gap: 4 }).scroll, 0, "never with the caret under the top bar");
});

test("on a short screen, like a phone's with its keyboard open, the menu shrinks to what's left next to the caret", () => {
	const area = { top: 120, bottom: 380 };
	const caret = { top: 300, bottom: 324 };
	const { maxHeight } = fitMenu({ caret, height: 320, area, gap: 4 });
	assert.equal(maxHeight, 232);
	assert.equal(fitMenu({ caret, height: maxHeight, area, gap: 4 }).scroll, 180, "the caret ends at the area's top and the menu's bottom at its bottom");
	assert.equal(fitMenu({ caret, height: 120, area: { top: 300, bottom: 360 }, gap: 4 }).maxHeight, 120, "three options at least");
});
