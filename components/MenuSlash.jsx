"use client";

import { useId, useImperativeHandle, useState } from "react";
import { flip, shift } from "@floating-ui/dom";
import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import {
	ChevronLeft,
	ChevronRight,
	CodeXml,
	Heading1,
	Heading2,
	Heading3,
	ImagePlus,
	List,
	ListOrdered,
	Minus,
	MousePointerClick,
	Pilcrow,
	RectangleHorizontal,
	TextQuote,
	UserRound,
} from "lucide-react";
import { findMergeTagMatch, matchFields } from "@/lib/editor-merge-tags";
import { SLASH_BACK, SLASH_FIELDS, fitMenu, getSlashMenu, listSlashOptions } from "@/lib/editor-slash-menu";
import { MERGE_FIELDS } from "@/lib/merge-tags";
import { cn } from "@/lib/utils";

// Between the caret and the menu.
const GAP = 4;
// The scrolling list's own padding, kept in view around the option the keys select.
const LIST_PADDING = 4;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const MENU =
	"flex max-h-[min(20rem,var(--slash-menu-height,20rem))] w-60 origin-top-left flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg animate-in duration-150 fade-in-0 zoom-in-95 in-data-[side=top]:origin-bottom-left";
const ROW = "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm";
const SELECTED = "bg-accent text-accent-foreground";
const ICON = "grid size-7 shrink-0 place-items-center rounded-md border bg-background text-muted-foreground";

// The blocks, with Contact fields under them, which swaps them for the fields (lib/editor-slash-menu.js). The editor
// keeps the focus and passes the keys on: the arrows move, Enter picks, ArrowRight opens the fields, ArrowLeft goes back
// and Escape closes the menu (@tiptap/suggestion).
export default function MenuSlash({ items, query, command, ref }) {
	const [state, setState] = useState({ view: "blocks", query, index: null });
	const menu = getSlashMenu(items, { query, view: state.view });
	const options = listSlashOptions(menu);
	const index = Math.min(state.query === query && state.index !== null ? state.index : getFirstIndex(options), options.length - 1);
	const selected = options[index];

	function select(nextIndex) {
		if (nextIndex !== index || state.query !== query) setState({ view: state.view, query, index: nextIndex });
	}

	// Into the fields on the first of them, and back out on the entry that opened them.
	function showView(view) {
		const next = listSlashOptions(getSlashMenu(items, { query, view }));
		const entry = next.indexOf(SLASH_FIELDS);
		setState({ view, query, index: entry === -1 ? getFirstIndex(next) : entry });
	}

	function pick(option) {
		if (option === SLASH_FIELDS) showView("fields");
		else if (option === SLASH_BACK) showView("blocks");
		else command(option);
	}

	useImperativeHandle(ref, () => ({
		onKeyDown({ event }) {
			if (!options.length) return false;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				const step = event.key === "ArrowDown" ? 1 : -1;
				select((index + step + options.length) % options.length);
				return true;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				pick(selected);
				return true;
			}
			if (event.key === "ArrowRight" && selected === SLASH_FIELDS) {
				showView("fields");
				return true;
			}
			if (event.key === "ArrowLeft" && state.view === "fields") {
				showView("blocks");
				return true;
			}
			return false;
		},
	}));

	if (!options.length) return null;

	function optionProps(option) {
		return { isSelected: option === selected, onPoint: () => select(options.indexOf(option)), onPick: () => pick(option) };
	}

	return (
		<div className={MENU}>
			{menu.header && (
				<div className="shrink-0 border-b p-1">
					<RowBack {...optionProps(SLASH_BACK)} />
				</div>
			)}
			<div key={state.view} data-slash-scroll className="min-h-0 overflow-y-auto overscroll-contain p-1">
				<div role="listbox" aria-label="Insert">
					{menu.groups.map((group) => (
						<GroupSlash key={group.label ?? "blocks"} label={group.label}>
							{group.items.map((item) => (
								<OptionSlash key={item.id ?? item.title} item={item} {...optionProps(item)} />
							))}
						</GroupSlash>
					))}
				</div>
				{state.view === "fields" && menu.groups.every((group) => group.items.length === 0) && (
					<p role="status" className="px-2 py-1.5 text-sm text-muted-foreground">
						No matching field
					</p>
				)}
			</div>
			{menu.footer === SLASH_FIELDS && (
				<div className="shrink-0 border-t p-1">
					<RowFields {...optionProps(SLASH_FIELDS)} />
				</div>
			)}
		</div>
	);
}

function GroupSlash({ label, children }) {
	const id = useId();
	if (!label) return children;
	return (
		<div role="group" aria-labelledby={id}>
			<p id={id} className="px-2 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">
				{label}
			</p>
			{children}
		</div>
	);
}

// hint: what the option is, in the words the editor takes, like a field's key.
function OptionSlash({ item, hint, isSelected, onPoint, onPick }) {
	return (
		<button
			type="button"
			role="option"
			aria-selected={isSelected}
			ref={isSelected ? scrollToOption : undefined}
			onPointerMove={onPoint}
			onMouseDown={keepEditorFocus}
			onClick={onPick}
			className={cn(ROW, isSelected && SELECTED)}
		>
			<span className={ICON}>
				<item.icon className="size-4" />
			</span>
			<span className="min-w-0 flex-1 truncate">{item.title}</span>
			{hint && <span className="max-w-[45%] shrink-0 truncate font-mono text-xs text-muted-foreground">{hint}</span>}
		</button>
	);
}

function RowFields({ isSelected, onPoint, onPick }) {
	return (
		<button type="button" onPointerMove={onPoint} onMouseDown={keepEditorFocus} onClick={onPick} className={cn(ROW, isSelected && SELECTED)}>
			<span className={ICON}>
				<UserRound className="size-4" />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate">{SLASH_FIELDS.title}</span>
				<span className="block truncate text-xs text-muted-foreground">Filled in for each reader</span>
			</span>
			<ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
		</button>
	);
}

function RowBack({ isSelected, onPoint, onPick }) {
	return (
		<button
			type="button"
			onPointerMove={onPoint}
			onMouseDown={keepEditorFocus}
			onClick={onPick}
			className={cn(ROW, "gap-1.5 font-medium", isSelected && SELECTED)}
		>
			<ChevronLeft aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
			<span className="min-w-0 truncate">
				<span className="sr-only">Back from </span>
				{SLASH_FIELDS.title}
			</span>
		</button>
	);
}

// Typing "/" at the start of a line or after a space opens the menu, but not in a button's text; the text after it
// searches.
export const SlashCommand = Extension.create({
	name: "slashCommand",
	addOptions() {
		return { onPickImage: () => {} };
	},
	addProseMirrorPlugins() {
		const items = getSlashItems();
		return [
			Suggestion({
				editor: this.editor,
				char: "/",
				// Rendered before it's first placed, so it's placed at its own height.
				initialItems: items,
				items: () => items,
				allow: ({ state, range }) => state.doc.resolve(range.from).parent.type.name !== "button",
				command: ({ editor, range, props: item }) => {
					runPick(editor, range, item);
					if (item.isImage) this.options.onPickImage(editor);
				},
				...MENU_OPTIONS,
				render: () => renderMenu(MenuSlash),
			}),
		];
	},
});

// The fields a tag being typed could be, under its "{{" as the key is typed (lib/editor-merge-tags.js): a suggestion
// only, which typing on ignores, and which a |, }} or no field matching closes. The editor keeps the focus and passes
// the keys on: the arrows move, Enter or Tab picks, and Escape closes it until the next tag (@tiptap/suggestion).
export function MenuMergeTag({ items, query, command, ref }) {
	const [state, setState] = useState({ query, index: 0 });
	const index = Math.min(state.query === query ? state.index : 0, items.length - 1);

	useImperativeHandle(ref, () => ({
		onKeyDown({ event }) {
			if (!items.length) return false;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				const step = event.key === "ArrowDown" ? 1 : -1;
				setState({ query, index: (index + step + items.length) % items.length });
				return true;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				command(items[index]);
				return true;
			}
			return false;
		},
	}));

	if (!items.length) return null;

	return (
		<div className={cn(MENU, "w-64")}>
			<p className="shrink-0 px-3 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">{SLASH_FIELDS.title}</p>
			<div data-slash-scroll className="min-h-0 overflow-y-auto overscroll-contain p-1 pt-0">
				<div role="listbox" aria-label={SLASH_FIELDS.title}>
					{items.map((item, position) => (
						<OptionSlash
							key={item.id}
							item={item}
							hint={item.key}
							isSelected={position === index}
							onPoint={() => position !== index && setState({ query, index: position })}
							onPick={() => command(item)}
						/>
					))}
				</div>
			</div>
		</div>
	);
}

// Typing "{{" opens MenuMergeTag, anywhere text goes, buttons included.
export const MergeTagSuggestion = Extension.create({
	name: "mergeTagSuggestion",
	addProseMirrorPlugins() {
		const items = getFieldItems();
		return [
			Suggestion({
				editor: this.editor,
				pluginKey: new PluginKey("mergeTagSuggestion"),
				char: "{{",
				findSuggestionMatch: findMergeTagMatch,
				initialItems: items,
				items: ({ query }) => matchFields(items, query),
				command: ({ editor, range, props: item }) => runPick(editor, range, item),
				...MENU_OPTIONS,
				render: () => renderMenu(MenuMergeTag),
			}),
		];
	},
});

export function getSlashItems() {
	return [...SLASH_ITEMS, ...getFieldItems()];
}

// The names a tag prints, each with its key. A tag goes in without a fallback: for a reader without the name, it goes
// with the space before it, and no fallback word is written in a language the newsletter may not be in.
export function getFieldItems() {
	return MERGE_FIELDS.map(({ key, label }) => ({
		id: `field:${key}`,
		key,
		title: label,
		keywords: `${key} name contact field personalize merge tag hello`,
		icon: UserRound,
		isField: true,
		run: (chain) => chain.insertContent(`{{${key}}}`),
	}));
}

// What was typed gives way to the item picked. The editor takes its focus back first: the chain's own focus waits a
// frame, and meanwhile the browser would leave the caret where the typed text was.
function runPick(editor, range, item) {
	editor.view.focus();
	item.run(editor.chain().focus().deleteRange(range)).run();
}

// Below the caret, or above it where only there it fits (lib/editor-slash-menu.js).
const MENU_OPTIONS = {
	offset: { mainAxis: GAP },
	flip: false,
	floatingUi: { middleware: [flip(getFlipOptions), shift({ padding: 8 })] },
};

// Component, hidden until it's placed with its options. The page scrolls only as they change, and only when the menu
// wouldn't show whole (lib/editor-slash-menu.js): never as the page itself scrolls. Each opening starts afresh.
function renderMenu(Component) {
	let component;
	let unmount;
	let clientRect;
	let shownHeight = 0;

	function place({ x, y, placement, strategy }) {
		const { element } = component;
		Object.assign(element.style, { position: strategy, left: `${x}px`, top: `${y}px` });
		element.dataset.side = placement.split("-")[0];
		const caret = clientRect?.();
		const height = element.offsetHeight;
		if (!caret || !height) return;
		const { maxHeight, scroll } = fitMenu({ caret, height, area: getMenuArea(), gap: GAP });
		element.style.setProperty("--slash-menu-height", `${maxHeight}px`);
		// It shrinks first, which places it again.
		if (height > maxHeight + 1) return;
		element.style.visibility = "";
		if (height === shownHeight) return;
		shownHeight = height;
		if (scroll > 0) window.scrollBy({ top: scroll, behavior: window.matchMedia(REDUCED_MOTION).matches ? "instant" : "smooth" });
	}

	return {
		onStart(props) {
			clientRect = props.clientRect;
			shownHeight = 0;
			component = new ReactRenderer(Component, { props, editor: props.editor });
			Object.assign(component.element.style, { position: "absolute", top: "0", left: "0", zIndex: "50", visibility: "hidden" });
			unmount = props.mount(component.element, { onPosition: place });
		},
		onUpdate(props) {
			clientRect = props.clientRect;
			component.updateProps(props);
		},
		onKeyDown(props) {
			return component.ref?.onKeyDown(props) ?? false;
		},
		onExit() {
			unmount?.();
			component.destroy();
		},
	};
}

// Above the caret only where there's room there and none below, between the page's own bars.
function getFlipOptions() {
	const screen = getScreen();
	const area = getMenuArea();
	return {
		padding: { top: area.top - screen.top, bottom: screen.bottom - area.bottom },
		crossAxis: false,
		fallbackStrategy: "initialPlacement",
	};
}

// What the page's sticky bars leave of the screen, as html's scroll-padding says (app/globals.css): on a phone with its
// keyboard open, the part above the keyboard, where the bar behind it no longer counts.
function getMenuArea() {
	const style = getComputedStyle(document.documentElement);
	const screen = getScreen();
	return {
		top: Math.max(screen.top, parseFloat(style.scrollPaddingTop) || 0),
		bottom: Math.min(screen.bottom, document.documentElement.clientHeight - (parseFloat(style.scrollPaddingBottom) || 0)),
	};
}

function getScreen() {
	const viewport = window.visualViewport;
	const top = viewport?.offsetTop ?? 0;
	return { top, bottom: top + (viewport?.height ?? window.innerHeight) };
}

function getFirstIndex(options) {
	return Math.max(0, options.findIndex((option) => option.run));
}

// The list scrolls to the option the keys select; Element.scrollIntoView would scroll the page too.
function scrollToOption(option) {
	const list = option?.closest("[data-slash-scroll]");
	if (!list) return;
	const { top, bottom } = option.getBoundingClientRect();
	const box = list.getBoundingClientRect();
	if (top < box.top) list.scrollTop -= box.top - top + LIST_PADDING;
	else if (bottom > box.bottom) list.scrollTop += bottom - box.bottom + LIST_PADDING;
}

function keepEditorFocus(event) {
	event.preventDefault();
}

const SLASH_ITEMS = [
	{ title: "Text", keywords: "paragraph", icon: Pilcrow, run: (chain) => chain.setParagraph() },
	{ title: "Heading 1", keywords: "title h1 big", icon: Heading1, run: (chain) => chain.setHeading({ level: 1 }) },
	{ title: "Heading 2", keywords: "subtitle h2", icon: Heading2, run: (chain) => chain.setHeading({ level: 2 }) },
	{ title: "Heading 3", keywords: "h3 small", icon: Heading3, run: (chain) => chain.setHeading({ level: 3 }) },
	{ title: "Bulleted list", keywords: "ul unordered", icon: List, run: (chain) => chain.toggleBulletList() },
	{ title: "Numbered list", keywords: "ol ordered", icon: ListOrdered, run: (chain) => chain.toggleOrderedList() },
	{ title: "Image", keywords: "picture photo upload library", icon: ImagePlus, run: (chain) => chain, isImage: true },
	{ title: "Quote", keywords: "blockquote", icon: TextQuote, run: (chain) => chain.setBlockquote() },
	{ title: "Divider", keywords: "hr separator line", icon: Minus, run: (chain) => chain.setHorizontalRule() },
	{
		title: "Box",
		keywords: "callout container update promo",
		icon: RectangleHorizontal,
		run: (chain) => chain.wrapIn("callout"),
	},
	{
		title: "Button",
		keywords: "cta call to action link",
		icon: MousePointerClick,
		run: (chain) => chain.setNode("button"),
	},
	{
		title: "HTML",
		keywords: "code embed snippet custom raw markup",
		icon: CodeXml,
		run: (chain) => chain.insertContent({ type: "htmlBlock", attrs: { isNew: true } }),
	},
];
