import { Node } from "@tiptap/core";
import { exitCode } from "@tiptap/pm/commands";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { isButtonLink, readButtonAlign } from "@/lib/buttons";
import { getThemeVariables, resolveTheme } from "@/lib/themes";

// What the website's buttons take from the newsletter's theme (app/globals.css).
const THEME_VARIABLES = ["--primary", "--primary-foreground", "--radius"];

// A button (lib/buttons.js), its text written on it like a heading's, and its link and its place in the column set from
// its toolbar (components/MenuButton.jsx). It's kept as the issue keeps it, a <div data-button> around one link, and
// it's code to the editor, so Markdown shortcuts, formatting and pasted styles stay out of its text. Enter opens its
// link while it has none, then goes on below it. newsletter: whose button colors and corners it shows. onEditLink:
// opens the toolbar's link field.
export const ButtonBlock = Node.create({
	name: "button",
	group: "block",
	content: "text*",
	marks: "",
	code: true,
	whitespace: "normal",
	defining: true,
	isolating: true,
	// Its keys come before the editor's own, where Enter in code adds a line break.
	priority: 101,

	addOptions() {
		return { newsletter: null, onEditLink: () => {} };
	},

	addAttributes() {
		return {
			href: { default: "", rendered: false, parseHTML: (element) => element.querySelector("a")?.getAttribute("href") ?? "" },
			align: { default: "center", rendered: false, parseHTML: (element) => readButtonAlign(element.getAttribute("data-align")) },
		};
	},

	parseHTML() {
		return [{ tag: "div[data-button]", priority: 60, contentElement: (element) => element.querySelector("a") ?? element }];
	},

	renderHTML({ node }) {
		const { href, align } = node.attrs;
		return ["div", { "data-button": "", ...(align !== "center" && { "data-align": align }) }, ["a", href ? { href } : {}, 0]];
	},

	// In the newsletter's colors and corners, and marked for the editor's styles while it's empty. Its text is in a
	// <span>, not the issue's <a>: Chrome types at the edge of a link outside it.
	addNodeView() {
		const style = getButtonStyle(this.options.newsletter);
		return ({ node }) => {
			const dom = document.createElement("div");
			const text = document.createElement("span");
			dom.setAttribute("data-button", "");
			for (const [name, value] of Object.entries(style)) text.style.setProperty(name, value);
			dom.append(text);
			const show = (current) => {
				setAttribute(dom, "data-align", current.attrs.align === "center" ? null : current.attrs.align);
				setAttribute(dom, "data-empty", current.content.size ? null : "");
			};
			show(node);
			return {
				dom,
				contentDOM: text,
				update: (next) => {
					if (next.type !== node.type) return false;
					show(next);
					return true;
				},
			};
		};
	},

	addKeyboardShortcuts() {
		const editLink = () => {
			if (!findButton(this.editor.state)) return false;
			this.options.onEditLink();
			return true;
		};
		return {
			Enter: () => {
				const button = findButton(this.editor.state);
				if (!button || this.editor.state.selection instanceof NodeSelection) return false;
				if (!isButtonLink(button.node.attrs.href)) return editLink();
				return this.editor.commands.command(({ state, dispatch }) => exitButton(state, dispatch));
			},
			"Mod-k": editLink,
			// After undoing a Markdown shortcut just typed, as the editor's own Backspace does first.
			Backspace: () =>
				!this.editor.can().undoInputRule() && this.editor.commands.command(({ state, dispatch }) => backspaceButton(state, dispatch)),
		};
	},

	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: new PluginKey("button"),
				props: {
					// Pasted or dropped into a button, text comes as one line.
					transformPastedText: (text, _plain, view) => (findButton(view.state) ? text.replace(/\s+/g, " ") : text),
				},
			}),
		];
	},
});

// The button holding the selection, or selected whole by its grip: its node and position, or null.
export function findButton(state) {
	const { selection } = state;
	if (selection instanceof NodeSelection) return selection.node.type.name === "button" ? { node: selection.node, pos: selection.from } : null;
	const { $from, $to } = selection;
	if ($from.parent.type.name !== "button" || !$from.sameParent($to)) return null;
	return { node: $from.parent, pos: $from.before() };
}

// Writing goes on in a paragraph after the button: the empty one already there, or a new one.
export function exitButton(state, dispatch) {
	const button = findButton(state);
	if (!button || state.selection instanceof NodeSelection) return false;
	const after = button.pos + button.node.nodeSize;
	const next = state.doc.resolve(after).nodeAfter;
	if (next?.type.name !== "paragraph" || next.content.size > 0) return exitCode(state, dispatch);
	if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, after + 1)).scrollIntoView());
	return true;
}

// An empty button becomes a paragraph again. At the start of a block right after a button, Backspace goes into the
// button's text, taking the block along when it's empty: a button never takes in the text after it.
export function backspaceButton(state, dispatch) {
	const { selection, doc } = state;
	if (!selection.empty) return false;
	const { $from } = selection;
	if ($from.parent.type.name === "button") {
		if ($from.parent.content.size > 0) return false;
		if (dispatch) dispatch(state.tr.setBlockType($from.pos, $from.pos, state.schema.nodes.paragraph));
		return true;
	}
	if ($from.parentOffset > 0 || !$from.parent.isTextblock || $from.depth === 0) return false;
	const start = $from.before();
	if (doc.resolve(start).nodeBefore?.type.name !== "button") return false;
	if (dispatch) {
		const tr = $from.parent.content.size ? state.tr : state.tr.delete(start, $from.after());
		dispatch(tr.setSelection(TextSelection.create(tr.doc, start - 1)).scrollIntoView());
	}
	return true;
}

// The newsletter's button colors and corners, as its website draws them. MailCheap's own colors set none, so they follow
// the dashboard's light or dark mode.
function getButtonStyle(newsletter) {
	const variables = getThemeVariables(resolveTheme(newsletter?.theme));
	return Object.fromEntries(THEME_VARIABLES.filter((name) => variables[name]).map((name) => [name, variables[name]]));
}

function setAttribute(element, name, value) {
	if (value === null) element.removeAttribute(name);
	else element.setAttribute(name, value);
}
