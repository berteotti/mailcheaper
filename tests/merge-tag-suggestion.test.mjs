import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor, getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MenuMergeTag, getFieldItems } from "../components/MenuSlash.jsx";
import { ButtonBlock } from "../lib/editor-button.js";
import { findMergeTagMatch, matchFields } from "../lib/editor-merge-tags.js";

// Typing "{{" in the editor suggests the names a tag could be (components/MenuSlash.jsx): what the menu reads as the
// tag being typed (lib/editor-merge-tags.js), which names it shows for it, and what picking one writes.
const schema = getSchema([StarterKit, ButtonBlock]);

// The paragraph's text with the caret at its ‸, or at its end.
function typed(text, type = "paragraph") {
	const caret = text.includes("‸") ? text.indexOf("‸") : text.length;
	const content = text.replace("‸", "");
	const doc = schema.node("doc", null, [schema.node(type, null, content ? [schema.text(content)] : [])]);
	const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1 + caret) });
	const match = findMergeTagMatch({ $position: state.selection.$from });
	return match && { query: match.query, text: doc.textBetween(match.range.from, match.range.to) };
}

function titles(query) {
	return matchFields(getFieldItems(), query).map(({ title }) => title);
}

test("the tag being typed is the {{ before the caret and the start of a key", () => {
	assert.deepEqual(typed("Hi {{"), { query: "", text: "{{" });
	assert.deepEqual(typed("Hi {{fi"), { query: "fi", text: "{{fi" });
	assert.deepEqual(typed("Hi {{ fi"), { query: "fi", text: "{{ fi" });
	assert.deepEqual(typed("{{plan}} and {{po"), { query: "po", text: "{{po" }, "only the last one");
	assert.deepEqual(typed("Claim your {{po", "button"), { query: "po", text: "{{po" }, "in a button's text too");
});

test("a |, a closed tag or a space after the key ends it", () => {
	assert.equal(typed("Hi {{first_name|"), null);
	assert.equal(typed("Hi {{first_name|th"), null);
	assert.equal(typed("Hi {{first_name}}"), null);
	assert.equal(typed("Hi {{first name"), null);
	assert.equal(typed("Hi {fi"), null);
});

test("the rest of a tag already after the caret goes in what a pick replaces", () => {
	assert.deepEqual(typed("Hi {{first_‸name}},"), { query: "first_", text: "{{first_name}}" });
	assert.deepEqual(typed("Hi {{po‸ints|0}} left"), { query: "po", text: "{{points|0}}" });
	assert.deepEqual(typed("Hi {{po‸ and more"), { query: "po", text: "{{po" }, "text that isn't a tag stays");
});

test("it suggests the first and last name, by key or name, those starting with what's typed first", () => {
	assert.deepEqual(titles(""), ["First name", "Last name"]);
	assert.deepEqual(titles("la"), ["Last name"]);
	assert.deepEqual(titles("NA"), ["First name", "Last name"]);
	assert.deepEqual(titles("first_n"), ["First name"]);
	assert.deepEqual(titles("plan"), []);
});

test("its menu lists them with their keys, the first one picked, and shows nothing when none match", () => {
	const html = renderToStaticMarkup(createElement(MenuMergeTag, { items: matchFields(getFieldItems(), "name"), query: "name", command() {} }));
	assert.match(html, />Contact fields</);
	assert.match(html, /aria-selected="true"[^>]*>.*?>First name<\/span><span[^>]*>first_name<\/span>/);
	assert.match(html, /aria-selected="false"[^>]*>.*?>Last name<\/span><span[^>]*>last_name<\/span>/);
	assert.equal(renderToStaticMarkup(createElement(MenuMergeTag, { items: [], query: "plan", command() {} })), "");
});

test("picking a name writes its whole tag in place of what was typed, without a fallback", () => {
	for (const [text, title, expected] of [
		["Hi {{fi", "First name", "Hi {{first_name}}"],
		["Dear {{la‸ team", "Last name", "Dear {{last_name}} team"],
		["Hi {{first_‸name}}, welcome", "First name", "Hi {{first_name}}, welcome"],
	]) {
		const content = text.replace("‸", "");
		const editor = new Editor({
			element: null,
			extensions: [StarterKit],
			content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: content }] }] },
		});
		editor.commands.setTextSelection(1 + (text.includes("‸") ? text.indexOf("‸") : text.length));
		const { range } = findMergeTagMatch({ $position: editor.state.selection.$from });
		const tag = getFieldItems()
			.find((item) => item.title === title)
			.run({ insertContent: (inserted) => inserted });
		editor.view.dispatch(editor.state.tr.insertText(tag, range.from, range.to));
		assert.equal(editor.state.doc.textContent, expected);
		editor.destroy();
	}
});
