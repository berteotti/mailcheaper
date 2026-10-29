import { Extension } from "@tiptap/core";
import { closeHistory, isHistoryTransaction, undoDepth } from "@tiptap/pm/history";
import { ReplaceAroundStep, ReplaceStep } from "@tiptap/pm/transform";
import { toast } from "sonner";
import { formatShortcut } from "@/lib/keyboard";

const TOAST_ID = "editor-deleted";
// Long enough to reach its Undo.
const TOAST_DURATION = 6000;
// What the toast calls each block, alone and in numbers.
const NAMES = { image: ["Image", "images"], button: ["Button", "buttons"], htmlBlock: ["HTML block", "HTML blocks"] };
// A block is cut to be pasted elsewhere, and pasting or dropping over one replaces it.
const REPLACING_EVENTS = new Set(["cut", "paste", "drop"]);

// Deleting a picture, a button or an HTML block, from its bin or from the keyboard, shows a toast whose Undo brings it
// back, as ⌘Z does: the button shows the shortcut. The toast goes when the editor closes, and once ⌘Z would take back
// something else: after the issue's next change, an undo or a redo. Text, and blocks still empty, are quick to make
// again and get none.
export const UndoDelete = Extension.create({
	name: "undoDelete",

	// depth: the undo history's, with the deletion on top, while its toast shows.
	addStorage() {
		return { depth: null };
	},

	onTransaction({ transaction }) {
		const { editor, storage } = this;
		const deleted = getDeletedBlocks(transaction);
		if (deleted.length > 0) {
			storage.depth = undoDepth(editor.state);
			showToast(editor, storage, deleted);
		} else if (storage.depth !== null && undoDepth(editor.state) !== storage.depth) {
			dismissToast(storage);
		}
	},

	onDestroy() {
		if (this.storage.depth !== null) dismissToast(this.storage);
	},
});

// A block's bin. The deletion is an undo step of its own, so undo never takes back with it what was just typed in the
// block.
export function deleteBlock(editor, pos) {
	editor
		.chain()
		.focus()
		.setNodeSelection(pos)
		.command(({ tr }) => Boolean(closeHistory(tr)))
		.deleteSelection()
		.run();
}

function showToast(editor, storage, deleted) {
	toast.message(describe(deleted), {
		id: TOAST_ID,
		duration: TOAST_DURATION,
		action: {
			label: `Undo ${formatShortcut("Z")}`,
			// Only while undo still takes back the deletion, and the editor is still open.
			onClick: () => {
				if (storage.depth !== null) editor.chain().focus().undo().run();
			},
		},
	});
}

function dismissToast(storage) {
	storage.depth = null;
	toast.dismiss(TOAST_ID);
}

// The blocks worth a toast that a change took out of the issue: whole within what its steps replaced, and not put back
// by them, as when a block moves or a picture changes (a picture or an HTML block is replaced whole). Undo, redo and
// the changes undo skips, like a picture that failed to upload, don't count.
function getDeletedBlocks(tr) {
	if (!tr.docChanged || isHistoryTransaction(tr) || tr.getMeta("addToHistory") === false) return [];
	if (REPLACING_EVENTS.has(tr.getMeta("uiEvent"))) return [];
	const removed = [];
	const added = {};
	tr.steps.forEach((step, index) => {
		const ranges = getReplacedRanges(step);
		for (const [from, to] of ranges) {
			tr.docs[index].nodesBetween(from, to, (node, pos) => {
				if (pos >= from && pos + node.nodeSize <= to && isWorkedOn(node)) removed.push(node);
			});
		}
		if (ranges.length === 0) return;
		step.slice.content.descendants((node) => {
			added[node.type.name] = (added[node.type.name] ?? 0) + 1;
		});
	});
	return removed.filter((node) => {
		const { name } = node.type;
		if (!added[name]) return true;
		added[name] -= 1;
		return false;
	});
}

// Where a step takes content out: a replace step's whole range, or what's around the content another one keeps.
function getReplacedRanges(step) {
	if (step instanceof ReplaceStep) return [[step.from, step.to]];
	if (step instanceof ReplaceAroundStep) {
		return [
			[step.from, step.gapFrom],
			[step.gapTo, step.to],
		];
	}
	return [];
}

// A picture, a button with its text or its link, or an HTML block with its HTML.
function isWorkedOn(node) {
	const { name } = node.type;
	if (name === "button") return Boolean(node.textContent.trim() || node.attrs.href);
	if (name === "htmlBlock") return Boolean(node.attrs.html.trim());
	return name === "image";
}

// "Image deleted", "2 buttons deleted", or "3 blocks deleted" when they're of different kinds.
function describe(nodes) {
	const [name, plural] = NAMES[nodes[0].type.name];
	if (nodes.length === 1) return `${name} deleted`;
	const isOneKind = nodes.every((node) => node.type === nodes[0].type);
	return `${nodes.length} ${isOneKind ? plural : "blocks"} deleted`;
}
