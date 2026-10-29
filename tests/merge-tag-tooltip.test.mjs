import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContentMergeTag, getTagContext } from "../components/TooltipMergeTag.jsx";
import { MergeTags } from "../lib/editor-merge-tags.js";
import { getMergeField } from "../lib/merge-tags.js";

// A tag's pill in the editor (lib/editor-merge-tags.js) and the tooltip pointing at it shows
// (components/TooltipMergeTag.jsx): its sentence as Jane Doe gets it and as a reader without the name does, where that
// text comes from, and Preview.
const FIRST_NAME = getMergeField("first_name");
const LAST_NAME = getMergeField("last_name");

function renderTooltip(props) {
	return renderToStaticMarkup(createElement(ContentMergeTag, props));
}

// Its words as read: a space between its lines, none within a sentence.
function readTooltip(props) {
	return renderTooltip(props)
		.replace(/<\/?(dl|dt|dd|p|div)\b[^>]*>/g, " ")
		.replace(/<[^>]+>/g, "")
		.replaceAll("&#x27;", "'")
		.replace(/\s+/g, " ")
		.trim();
}

test("each pill carries its tag's key and fallback, and other tags get none", () => {
	const editor = new Editor({
		element: null,
		extensions: [StarterKit, MergeTags],
		content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi {{first_name|there}}, {{ last_name }} {{nope}}" }] }] },
	});
	// Mounting it in a page adds its plugins.
	editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
	const plugin = editor.state.plugins.find((candidate) => candidate.key.startsWith("mergeTags$"));
	const pills = plugin.getState(editor.state).find();
	assert.deepEqual(
		pills.map(({ from, to, type }) => [editor.state.doc.textBetween(from, to), type.attrs]),
		[
			["{{first_name|there}}", { class: "merge-tag", "data-key": "first_name", "data-fallback": "there" }],
			["{{ last_name }}", { class: "merge-tag", "data-key": "last_name", "data-fallback": "" }],
		]
	);
	editor.destroy();
});

test("the tooltip reads the tag's sentence as Jane Doe gets it and as a reader without the name does", () => {
	assert.equal(
		readTooltip({ field: FIRST_NAME, fallback: "there", before: "Hey ", after: "," }),
		"Each reader's first name Jane Doe sees Hey Jane, No first name Hey there, “there” comes from after the |. Pick a reader in Preview to see it for real."
	);
	assert.equal(
		readTooltip({ field: LAST_NAME, fallback: "", before: "Dear Ms. ", after: "," }),
		"Each reader's last name Jane Doe sees Dear Ms. Doe, No last name Dear Ms., To print a word instead, add | and the word inside the braces. Pick a reader in Preview to see it for real."
	);
});

test("without a fallback, the tag goes with the space before it, and nothing stands in its place", () => {
	const html = renderTooltip({ field: FIRST_NAME, fallback: "", before: "Hi ", after: ", welcome…" });
	assert.match(html, /<dd><span[^>]*>Hi, welcome…<\/span><\/dd>/);
	assert.match(readTooltip({ field: FIRST_NAME, fallback: "a very long way to say hello to you" }), /“a very long way to say …” comes from/);
});

test("the examples quote a few words of the tag's sentence, up to another tag or a line break", () => {
	const quote = (text, tag) => getTagContext(text, text.indexOf(tag), text.indexOf(tag) + tag.length);
	assert.deepEqual(quote("Hey {{first_name|there}},", "{{first_name|there}}"), { before: "Hey ", after: "," });
	assert.deepEqual(quote("Hi {{first_name}}, welcome to the list.", "{{first_name}}"), { before: "Hi ", after: ", welcome…" });
	assert.deepEqual(quote("This week the whole crew at {{last_name}} gets early access.", "{{last_name}}"), { before: "…crew at ", after: " gets…" });
	assert.deepEqual(quote("Hey {{first_name}} {{last_name}} again", "{{first_name}}"), { before: "Hey ", after: "" });
	assert.deepEqual(quote("Thanks\n{{first_name}}", "{{first_name}}"), { before: "", after: "" });
	assert.deepEqual(quote("{{first_name}}", "{{first_name}}"), { before: "", after: "" });
});
