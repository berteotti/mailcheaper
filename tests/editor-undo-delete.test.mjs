import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { HtmlBlock } from "../components/BlockHtml.jsx";
import { ButtonBlock, backspaceButton } from "../lib/editor-button.js";
import { Callout } from "../lib/editor-callout.js";
import { ImageAligned } from "../lib/editor-image.js";
import { moveBlock } from "../lib/editor-move-block.js";
import { UndoDelete, deleteBlock } from "../lib/editor-undo-delete.js";
import { toast } from "sonner";

// The campaign editor's blocks and undo history (components/EditorRich.jsx), without a page, and the toast a deleted
// picture, button or HTML block shows, with its Undo.
function createEditor(...content) {
	const editor = new Editor({
		element: null,
		extensions: [StarterKit, ImageAligned, Callout, ButtonBlock, HtmlBlock, UndoDelete],
		content: { type: "doc", content },
	});
	// Mounting it in a page adds its plugins, the undo history among them.
	editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
	return editor;
}

const paragraph = (text) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const image = (src = "https://cdn.example.com/garden.webp") => ({ type: "image", attrs: { src, alt: "" } });
const button = (text = "Read the full story", href = "https://example.com/story") => ({
	type: "button",
	attrs: { href },
	content: text ? [{ type: "text", text }] : [],
});
const htmlBlock = (html = '<table role="presentation"><tr><td>Sponsored by Acme</td></tr></table>') => ({
	type: "htmlBlock",
	attrs: { html },
});
const callout = (...content) => ({ type: "callout", content });

function blocks(editor) {
	const names = [];
	editor.state.doc.forEach((node) => names.push(node.type.name));
	return names;
}

// Where the nth block of a type starts, from 0.
function positionOf(editor, name, nth = 0) {
	const found = [];
	editor.state.doc.descendants((node, pos) => {
		if (node.type.name === name) found.push(pos);
	});
	return found[nth] ?? null;
}

function setPlatform(platform) {
	Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
}

const { message, dismiss } = toast;
let shown;
let dismissed;

beforeEach(() => {
	shown = [];
	dismissed = [];
	toast.message = (text, options) => {
		shown.push({ text, ...options });
		return options.id;
	};
	toast.dismiss = (id) => dismissed.push(id);
	setPlatform("MacIntel");
});

afterEach(() => {
	Object.assign(toast, { message, dismiss });
	delete navigator.platform;
});

describe("deleting a picture, a button or an HTML block", () => {
	test("its bin deletes it at once, and the toast's Undo brings it back", () => {
		for (const [block, text] of [
			[image(), "Image deleted"],
			[button(), "Button deleted"],
			[htmlBlock(), "HTML block deleted"],
		]) {
			const editor = createEditor(paragraph("This week"), block, paragraph("See you"));
			const before = editor.getJSON();
			deleteBlock(editor, positionOf(editor, block.type));
			assert.deepEqual(blocks(editor), ["paragraph", "paragraph"]);
			assert.equal(shown.length, 1);
			const [deleted] = shown.splice(0);
			assert.equal(deleted.text, text);
			assert.equal(deleted.action.label, "Undo ⌘Z", "with its shortcut");
			assert.ok(deleted.duration >= 5000, "long enough to reach its Undo");

			deleted.action.onClick();
			assert.deepEqual(editor.getJSON(), before);
			assert.deepEqual(dismissed.splice(0), [deleted.id]);
			editor.destroy();
		}
	});

	test("Undo brings it back as it was, with what was just typed in it", () => {
		const editor = createEditor(paragraph("This week"), htmlBlock("<p>Sponsored</p>"), button("Read"), paragraph("See you"));
		const html = positionOf(editor, "htmlBlock");
		editor.commands.command(({ tr }) => Boolean(tr.setNodeMarkup(html, undefined, { html: "<p>Sponsored by Acme</p>" })));
		deleteBlock(editor, html);
		shown.pop().action.onClick();
		assert.equal(editor.state.doc.nodeAt(html).attrs.html, "<p>Sponsored by Acme</p>");

		const text = positionOf(editor, "button") + 5;
		editor.view.dispatch(editor.state.tr.insertText(" more", text));
		deleteBlock(editor, positionOf(editor, "button"));
		shown.pop().action.onClick();
		assert.equal(editor.state.doc.nodeAt(positionOf(editor, "button")).textContent, "Read more");
	});

	// A selected block, Backspace on the line after, typing over a block, and a selection across blocks.
	test("the keyboard's deletions show it too", () => {
		const selected = createEditor(paragraph("This week"), button(), paragraph("See you"));
		selected.chain().setNodeSelection(positionOf(selected, "button")).deleteSelection().run();
		assert.deepEqual(blocks(selected), ["paragraph", "paragraph"]);

		// The line after starts right after the block, at its position + 1, and its text 1 further.
		const after = createEditor(paragraph("This week"), htmlBlock(), paragraph("See you"));
		after
			.chain()
			.setTextSelection(positionOf(after, "htmlBlock") + 2)
			.joinBackward()
			.run();
		assert.deepEqual(blocks(after), ["paragraph", "paragraph"]);

		const typed = createEditor(paragraph("This week"), image(), paragraph("See you"));
		typed.commands.setNodeSelection(positionOf(typed, "image"));
		typed.view.dispatch(typed.state.tr.insertText("Hi"));
		assert.deepEqual(blocks(typed), ["paragraph", "paragraph", "paragraph"]);

		const across = createEditor(paragraph("This week"), image(), button(), paragraph("See you"));
		across.commands.setTextSelection({ from: 3, to: across.state.doc.content.size - 3 });
		across.commands.deleteSelection();
		assert.deepEqual(blocks(across), ["paragraph"]);

		const all = createEditor(image(), paragraph("and"), callout(image("https://cdn.example.com/beans.webp")));
		all.chain().selectAll().deleteSelection().run();
		assert.equal(positionOf(all, "image"), null);

		assert.deepEqual(
			shown.map(({ text }) => text),
			["Button deleted", "HTML block deleted", "Image deleted", "2 blocks deleted", "2 images deleted"]
		);
	});

	test("text, blocks still empty and changes that keep a block show none", () => {
		// The second button and the second HTML block have their text, link and HTML; the first ones are empty.
		const content = [paragraph("This week"), image(), button("", ""), htmlBlock(""), button("Join"), htmlBlock(), paragraph("See you")];
		const cases = {
			"deleting text": (editor) => editor.chain().setTextSelection({ from: 1, to: 6 }).deleteSelection().run(),
			"an empty button's bin": (editor) => deleteBlock(editor, positionOf(editor, "button")),
			"an empty HTML block's bin": (editor) => deleteBlock(editor, positionOf(editor, "htmlBlock")),
			"Backspace in an empty button, which makes it a paragraph": (editor) =>
				editor
					.chain()
					.setTextSelection(positionOf(editor, "button") + 1)
					.command(({ state, dispatch }) => backspaceButton(state, dispatch))
					.run(),
			"deleting a button's text": (editor) => {
				const pos = positionOf(editor, "button", 1);
				editor.chain().setTextSelection({ from: pos + 1, to: pos + 5 }).deleteSelection().run();
			},
			"clearing an HTML block's HTML": (editor) => {
				const pos = positionOf(editor, "htmlBlock", 1);
				editor.commands.command(({ tr }) => Boolean(tr.setNodeMarkup(pos, undefined, { html: "" })));
			},
			"placing and resizing a picture": (editor) =>
				editor
					.chain()
					.setNodeSelection(positionOf(editor, "image"))
					.updateAttributes("image", { align: "left", width: 300 })
					.run(),
			"moving a picture": (editor) => {
				editor.commands.setNodeSelection(positionOf(editor, "image"));
				editor.view.dispatch(moveBlock(editor.state, 1));
			},
			"undoing a picture just added": (editor) => {
				editor.commands.insertContentAt(0, image("https://cdn.example.com/beans.webp"));
				editor.commands.undo();
			},
			// Its upload failed (components/EditorRich.jsx).
			"a picture going without undo": (editor) => {
				const pos = positionOf(editor, "image");
				editor.view.dispatch(editor.state.tr.delete(pos, pos + 1).setMeta("addToHistory", false));
			},
		};
		for (const event of ["cut", "paste", "drop"]) {
			cases[`a ${event} over a picture`] = (editor) => {
				const { state } = editor;
				const selected = state.tr.setSelection(NodeSelection.create(state.doc, positionOf(editor, "image")));
				editor.view.dispatch(selected.deleteSelection().setMeta("uiEvent", event));
			};
		}

		for (const [name, change] of Object.entries(cases)) {
			const editor = createEditor(...content);
			let changes = 0;
			editor.on("update", () => changes++);
			change(editor);
			assert.ok(changes > 0, `${name} changes the issue`);
			assert.deepEqual(shown, [], name);
			editor.destroy();
		}
	});
});

describe("the toast", () => {
	test("stays while ⌘Z would bring the block back, and goes once it would take back something else", () => {
		const editor = createEditor(paragraph("This week"), image(), paragraph("See you"));
		deleteBlock(editor, positionOf(editor, "image"));
		editor.commands.setTextSelection(3);
		editor.view.dispatch(editor.state.tr.insertText("!", 10).setMeta("addToHistory", false));
		assert.deepEqual(dismissed, [], "a click elsewhere, or a change undo skips, keeps it");

		editor.view.dispatch(editor.state.tr.insertText("Hi ", 1));
		assert.deepEqual(dismissed, [shown[0].id], "the next change of the issue takes it");
		shown[0].action.onClick();
		assert.equal(editor.state.doc.textContent, "Hi This week!See you", "its Undo does nothing then");
	});

	test("stays through what ⌘Z takes back along with the deletion, like a Backspace right after, and goes with ⌘Z", () => {
		const editor = createEditor(paragraph("This week"), image(), paragraph("See you"));
		editor
			.chain()
			.setTextSelection(positionOf(editor, "image") + 2)
			.joinBackward()
			.run();
		editor.commands.joinBackward();
		assert.deepEqual(blocks(editor), ["paragraph"]);
		assert.deepEqual(dismissed, []);

		editor.commands.undo();
		assert.deepEqual(blocks(editor), ["paragraph", "image", "paragraph"]);
		assert.deepEqual(dismissed, [shown[0].id]);
		editor.commands.redo();
		assert.equal(shown.length, 1, "redoing the deletion shows none");
	});

	test("a second deletion takes the first one's place, and leaving the editor takes it away", () => {
		const editor = createEditor(image(), button(), paragraph("See you"));
		deleteBlock(editor, positionOf(editor, "image"));
		deleteBlock(editor, positionOf(editor, "button"));
		assert.deepEqual(
			shown.map(({ id, text }) => ({ id, text })),
			[
				{ id: shown[0].id, text: "Image deleted" },
				{ id: shown[0].id, text: "Button deleted" },
			]
		);
		assert.deepEqual(dismissed, []);

		editor.destroy();
		assert.deepEqual(dismissed, [shown[0].id]);
		shown[1].action.onClick();
	});

	test("Undo shows the keyboard's own shortcut", () => {
		for (const [platform, shortcut] of [
			["MacIntel", "⌘Z"],
			["iPhone", "⌘Z"],
			["Win32", "Ctrl Z"],
			["Linux x86_64", "Ctrl Z"],
		]) {
			setPlatform(platform);
			const editor = createEditor(image(), paragraph("See you"));
			deleteBlock(editor, 0);
			assert.equal(shown.pop().action.label, `Undo ${shortcut}`, platform);
			editor.destroy();
		}
	});
});
