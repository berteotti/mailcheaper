"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { UserRound } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MERGE_FIELDS, getMergeField } from "@/lib/merge-tags";

// Long enough that a pointer passing over a tag on its way elsewhere shows nothing.
const DELAY_MS = 400;
// How much of the tag's sentence the examples quote, in words on each side: about what fits on their line.
const WORDS_BEFORE = 2;
const WORDS_AFTER = 1;
const TAG_OR_BREAK = /\{\{[^{}]*\}\}|\n/;
const SAMPLE_READER_NAME = MERGE_FIELDS.map(({ sample }) => sample).join(" ");
const SENTENCE_END = /[.!?]\s+/;

// What a tag's pill in the issue becomes (lib/editor-merge-tags.js), once a mouse rests on it: its sentence as the
// sample reader, Jane Doe, gets it and as a reader without a name does, with where that text comes from and where to
// see a real reader's. A key, a click or scrolling closes it. Radix anchors a tooltip to an element, so an empty one
// stands over the pill's first line.
export default function TooltipMergeTag({ editor }) {
	const [tag, setTag] = useState(null);
	const [isOpen, setIsOpen] = useState(false);

	useEffect(() => {
		const { dom } = editor.view;
		let pill = null;
		let timer = null;
		function hide() {
			clearTimeout(timer);
			pill = null;
			setIsOpen(false);
		}
		function onOver(event) {
			const target = event.target instanceof Element ? event.target.closest(".merge-tag") : null;
			if (target === pill) return;
			hide();
			if (!target || event.pointerType === "touch" || event.buttons !== 0) return;
			pill = target;
			timer = setTimeout(() => {
				if (!target.isConnected || editor.isDestroyed) return;
				setTag(readPill(editor, target));
				setIsOpen(true);
			}, DELAY_MS);
		}
		dom.addEventListener("pointerover", onOver);
		dom.addEventListener("pointerleave", hide);
		dom.addEventListener("pointerdown", hide);
		dom.addEventListener("keydown", hide);
		window.addEventListener("scroll", hide, true);
		return () => {
			clearTimeout(timer);
			dom.removeEventListener("pointerover", onOver);
			dom.removeEventListener("pointerleave", hide);
			dom.removeEventListener("pointerdown", hide);
			dom.removeEventListener("keydown", hide);
			window.removeEventListener("scroll", hide, true);
		};
	}, [editor]);

	const field = tag && getMergeField(tag.key);
	return createPortal(
		<Tooltip open={isOpen && Boolean(field)} onOpenChange={(open) => !open && setIsOpen(false)}>
			<TooltipTrigger asChild>
				<span aria-hidden="true" className="pointer-events-none fixed" style={tag?.rect} />
			</TooltipTrigger>
			<TooltipContent className="flex-col items-stretch px-3 py-2.5">
				{field && <ContentMergeTag field={field} fallback={tag.fallback} before={tag.before} after={tag.after} />}
			</TooltipContent>
		</Tooltip>,
		document.body
	);
}

// The tooltip for a name's tag, its fallback (the text after its |) and the words around the tag. Without a fallback,
// the tag goes with the space before it.
export function ContentMergeTag({ field, fallback, before = "", after = "" }) {
	const name = field.label.toLowerCase();
	return (
		<div className="flex w-72 flex-col gap-2">
			<span className="flex items-center gap-1.5 font-medium">
				<UserRound aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="min-w-0 truncate">Each reader&apos;s {name}</span>
			</span>
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md bg-background/10 px-2.5 py-2">
				<dt className="text-background/60">{SAMPLE_READER_NAME} sees</dt>
				<dd>
					<Sentence before={before} after={after}>
						{field.sample}
					</Sentence>
				</dd>
				<dt className="text-background/60">No {name}</dt>
				<dd>
					<Sentence before={fallback ? before : before.trimEnd()} after={after}>
						{fallback}
					</Sentence>
				</dd>
			</dl>
			<p className="text-pretty text-background/60">
				{fallback ? (
					<>
						&ldquo;{shorten(fallback)}&rdquo; comes from after the <Code>|</Code>.
					</>
				) : (
					<>
						To print a word instead, add <Code>|</Code> and the word inside the braces.
					</>
				)}{" "}
				Pick a reader in Preview to see it for real.
			</p>
		</div>
	);
}

// The words around a tag in its sentence, up to another tag or a line break: "Hey " and "," for "Hey {{first_name}},".
export function getTagContext(text, from, to) {
	const before = text.slice(0, from).split(TAG_OR_BREAK).pop().split(SENTENCE_END).pop().replace(/\s+/g, " ");
	const after = text.slice(to).split(TAG_OR_BREAK)[0].match(/^[^.!?]*[.!?]?/)[0].replace(/\s+/g, " ");
	const wordsBefore = before.match(/\S+\s*/g) ?? [];
	const wordsAfter = after.match(/\s*\S+/g) ?? [];
	// Punctuation right after the tag goes with the next word: "Hi Jane, welcome." rather than "Hi Jane,…".
	if (wordsAfter.length > 1 && !/[\p{L}\p{N}]/u.test(wordsAfter[0])) wordsAfter.splice(0, 2, wordsAfter[0] + wordsAfter[1]);
	return {
		before: (wordsBefore.length > WORDS_BEFORE ? "…" : "") + wordsBefore.slice(-WORDS_BEFORE).join(""),
		after: wordsAfter.slice(0, WORDS_AFTER).join("") + (wordsAfter.length > WORDS_AFTER ? "…" : ""),
	};
}

// The tag's sentence with what it becomes in its place, set apart like the pill, or nothing.
function Sentence({ before, after, children }) {
	return (
		<span className="text-background/70">
			{before}
			{children && <span className="rounded-sm bg-background/15 px-1 text-background">{children}</span>}
			{after}
		</span>
	);
}

function Code({ children }) {
	return <code className="rounded-sm bg-background/15 px-1 font-mono">{children}</code>;
}

// Where the pill's first line is, in the window, with its key, its fallback and the words around it.
function readPill(editor, pill) {
	const { left, top, width, height } = pill.getClientRects()[0] ?? pill.getBoundingClientRect();
	const $pos = editor.state.doc.resolve(editor.view.posAtDOM(pill, 0));
	const block = $pos.parent;
	const text = block.textBetween(0, block.content.size, "\n", "\n");
	const context = getTagContext(text, $pos.parentOffset, $pos.parentOffset + pill.textContent.length);
	return { key: pill.dataset.key, fallback: pill.dataset.fallback ?? "", ...context, rect: { left, top, width, height } };
}

function shorten(text) {
	return text.length > 24 ? `${text.slice(0, 23)}…` : text;
}
