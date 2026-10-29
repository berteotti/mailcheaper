"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, CircleX } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isBeingWritten, problemsKey } from "@/lib/editor-problems";
import { cn } from "@/lib/utils";

// The blocks' grip, with its gap before the text, and its height (lib/editor-block-handle.js): a dot in the editor keeps
// clear of it, and lines up with it.
const GRIP = { space: 26, height: 24 };
// What the pointer can rest on to show a dot's message, around the dot: wide in the page's margin, narrower in the
// editor's own padding, which it shares with the grip. gap: the room it leaves before the card, or before the grip.
const TARGET = { height: 32, outside: { width: 32, gap: 2 }, inside: { width: 16, gap: 3 } };
// The message's width with its arrow: where there's less room on a dot's left, it shows under the line instead.
const MESSAGE_SPACE = 260;
// A block with many problems lists its first few.
const MAX_SHOWN = 3;
// Each dot is measured again as the issue changes, so an issue with problems everywhere shows its first ones only: the
// review step counts them all.
const MAX_DOTS = 200;

// A dot beside each block where something may look broken (lib/editor-problems.js), the way code editors mark a line:
// amber for what the review step asks to check, red for what holds the send. It sits in the page's margin, just left of
// the editor's card, or where the page has no room, as on a phone, in the editor's own left padding. Pointing at it says
// what, as the review step does, and clicking it goes to it (onReveal). gutterRef: the element around the editor's
// card, positioned, which holds the dots in the margin. pinned: the block whose dot says what it's about until the next
// key or click, once the review step brought it into view.
export default function GutterProblems({ editor, gutterRef, pinned, onUnpin, onReveal }) {
	const [layout, setLayout] = useState({ container: null, dots: [] });
	const [hovered, setHovered] = useState(null);

	useEffect(() => {
		const { view } = editor;
		let frame = null;
		let isActive = true;
		function measure() {
			frame = null;
			// A step that's hidden lays nothing out: its dots, and any message they show, go until it shows again.
			const next = view.dom.offsetParent ? readDots(view, gutterRef?.current) : null;
			if (!next) setHovered(null);
			setLayout((current) => {
				if (!next) return current.dots.length > 0 ? { ...current, dots: [] } : current;
				const isSame = current.container === next.container && JSON.stringify(current.dots) === JSON.stringify(next.dots);
				return isSame ? current : next;
			});
		}
		function schedule() {
			if (isActive) frame ??= requestAnimationFrame(measure);
		}
		measure();
		document.fonts?.ready.then(schedule);
		editor.on("transaction", schedule);
		// An HTML block open for editing hides its dot, and pictures and previews loading move the blocks below them.
		view.dom.addEventListener("focusin", schedule);
		view.dom.addEventListener("focusout", schedule);
		const observer = new ResizeObserver(schedule);
		observer.observe(view.dom);
		return () => {
			isActive = false;
			cancelAnimationFrame(frame);
			editor.off("transaction", schedule);
			view.dom.removeEventListener("focusin", schedule);
			view.dom.removeEventListener("focusout", schedule);
			observer.disconnect();
		};
	}, [editor, gutterRef]);

	useEffect(() => {
		if (pinned === null) return;
		const unpin = (event) => {
			if (!(event.target instanceof Element && event.target.closest("[data-problem-dot]"))) onUnpin();
		};
		document.addEventListener("pointerdown", unpin, true);
		document.addEventListener("keydown", onUnpin, true);
		return () => {
			document.removeEventListener("pointerdown", unpin, true);
			document.removeEventListener("keydown", onUnpin, true);
		};
	}, [pinned, onUnpin]);

	if (!layout.container) return null;
	// A pinned message stays until pointing at another dot shows that one's.
	const open = pinned ?? hovered;
	return createPortal(
		layout.dots.map((dot) => (
			<Tooltip
				key={dot.pos}
				open={open === dot.pos}
				onOpenChange={(isOpen) => {
					if (isOpen && pinned !== null && pinned !== dot.pos) onUnpin();
					setHovered((current) => (isOpen ? dot.pos : current === dot.pos ? null : current));
				}}
			>
				<TooltipTrigger asChild>
					<button
						type="button"
						data-problem-dot=""
						aria-label={describeDot(dot)}
						onClick={() => onReveal(dot)}
						style={{ width: dot.width, transform: `translate(${dot.left}px, ${dot.top}px)` }}
						className="group/dot absolute top-0 left-0 z-10 grid h-8 cursor-pointer place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<span
							className={cn(
								"size-2 rounded-full transition-transform duration-150 ease-out group-hover/dot:scale-125",
								dot.severity === "error" ? "bg-red-500" : "bg-amber-500"
							)}
						/>
					</button>
				</TooltipTrigger>
				<TooltipContent side={dot.side} align={dot.side === "left" ? "center" : "start"} className="px-2.5 py-1.5">
					<ListProblems problems={dot.problems} />
				</TooltipContent>
			</Tooltip>
		)),
		layout.container
	);
}

// Where the dots' targets start across the window, x, and how wide they are: in the page's margin, just left of the
// editor's card, when the page leaves room for them (isOutside), else in the editor's own left padding, clear of the
// blocks' grip. editorLeft: the editor's left edge, the card's. pageLeft: the page's, past the sidebar.
export function placeDots({ editorLeft, paddingLeft, pageLeft, hasGutter = true }) {
	const { outside, inside } = TARGET;
	const x = editorLeft - outside.gap - outside.width;
	if (hasGutter && x >= pageLeft) return { x, width: outside.width, isOutside: true };
	return { x: editorLeft + Math.max(2, paddingLeft - GRIP.space - inside.width - inside.gap), width: inside.width, isOutside: false };
}

// What a screen reader says for a dot: the same first few problems as its message.
function describeDot({ severity, problems }) {
	const messages = problems.slice(0, MAX_SHOWN).map(({ message }) => message);
	const more = problems.length > MAX_SHOWN ? `, and ${problems.length - MAX_SHOWN} more` : "";
	return `${severity === "error" ? "To fix" : "To check"}: ${messages.join(". ")}${more}`;
}

// What each problem says, with the review step's icon for it (components/ListChecks.jsx).
function ListProblems({ problems }) {
	return (
		<ul className="flex max-w-56 flex-col gap-1.5">
			{problems.slice(0, MAX_SHOWN).map((problem, index) => {
				const isError = problem.severity === "error";
				const Icon = isError ? CircleX : CircleAlert;
				return (
					<li key={index} className="flex gap-1.5">
						<Icon aria-hidden="true" className={cn("mt-0.5 size-3 shrink-0", isError ? "text-red-400" : "text-amber-400")} />
						<span className="text-pretty">{problem.message}</span>
					</li>
				);
			})}
			{problems.length > MAX_SHOWN && <li className="pl-4.5 text-background/60">{problems.length - MAX_SHOWN} more</li>}
		</ul>
	);
}

// Each block's dot, where its first line is, or the top of an HTML block, as the grip is, in the element that holds them.
function readDots(view, gutter) {
	const { blocks } = problemsKey.getState(view.state) ?? { blocks: [] };
	const paddingLeft = Number.parseFloat(getComputedStyle(view.dom).paddingLeft) || 0;
	const pageLeft = (view.dom.closest("main") ?? document.body).getBoundingClientRect().left;
	const { x, width, isOutside } = placeDots({ editorLeft: view.dom.getBoundingClientRect().left, paddingLeft, pageLeft, hasGutter: Boolean(gutter) });
	const container = isOutside ? gutter : view.dom.parentElement;
	const origin = container.getBoundingClientRect();
	const side = x - MESSAGE_SPACE >= pageLeft ? "left" : "bottom";
	const { activeElement } = document;
	const dots = blocks.slice(0, MAX_DOTS).flatMap(({ pos, problems }) => {
		const node = view.state.doc.nodeAt(pos);
		const element = view.nodeDOM(pos);
		if (!node || !(element instanceof HTMLElement) || isBeingWritten(view.state, pos)) return [];
		// An HTML block open for editing says what's wrong under its HTML (components/BlockHtml.jsx).
		if (activeElement instanceof HTMLTextAreaElement && element.contains(activeElement)) return [];
		const center = getLineCenter(view, node, pos, element);
		return [
			{
				pos,
				problems,
				severity: problems.some(({ severity }) => severity === "error") ? "error" : "warning",
				side,
				left: Math.round(x - origin.left),
				top: Math.round(center - origin.top - TARGET.height / 2),
				width,
			},
		];
	});
	return { container, dots };
}

function getLineCenter(view, node, pos, element) {
	if (node.isAtom) {
		const rect = element.getBoundingClientRect();
		return rect.height < GRIP.height * 2 ? rect.top + rect.height / 2 : rect.top + 4 + GRIP.height / 2;
	}
	const line = view.coordsAtPos(pos + 1);
	return (line.top + line.bottom) / 2;
}
