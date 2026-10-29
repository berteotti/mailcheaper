"use client";

import { useMemo, useState } from "react";
import { highlightHtml } from "@/lib/highlight-html";
import { cn } from "@/lib/utils";

// Past this, the rest shows without colors: every keystroke colors the code again.
const MAX_HIGHLIGHTED = 20_000;
// The field and the colored copy under it lay their text out alike, so the field's letters sit on the copy's.
const TEXT_LAYOUT = "px-4 py-3 font-mono text-[13px] leading-6 whitespace-pre-wrap break-words [tab-size:2] [font-variant-ligatures:none]";
// One Light's colors, and One Dark's in dark mode. Only colors: a weight or a size would move the letters.
const TOKEN_CLASSES = {
	punctuation: "text-zinc-400 dark:text-zinc-500",
	tag: "text-rose-600 dark:text-rose-400",
	attribute: "text-amber-700 dark:text-amber-300",
	value: "text-emerald-700 dark:text-emerald-400",
	property: "text-sky-700 dark:text-sky-300",
	comment: "text-zinc-400 italic dark:text-zinc-500",
	entity: "text-violet-600 dark:text-violet-400",
	field: "text-violet-600 dark:text-violet-400",
};

// A field for HTML, in color (lib/highlight-html.js): a textarea whose own letters are transparent, over a colored copy
// of what's typed. value: the HTML from outside, taken whenever it changes. What's typed is the field's own meanwhile,
// since what it types into can show it a moment later.
export default function InputHtml({ ref, value, onChange, className, ...props }) {
	const [code, setCode] = useState(value);
	const [given, setGiven] = useState(value);
	if (value !== given) {
		setGiven(value);
		setCode(value);
	}
	const tokens = useMemo(() => highlightHtml(code.slice(0, MAX_HIGHLIGHTED)), [code]);

	return (
		<div className={cn("relative", className)}>
			<div aria-hidden="true" className={cn(TEXT_LAYOUT, "pointer-events-none min-h-40 text-foreground")}>
				{tokens.map(({ type, text }, index) =>
					type === "text" ? (
						text
					) : (
						<span key={index} className={TOKEN_CLASSES[type]}>
							{text}
						</span>
					)
				)}
				{code.slice(MAX_HIGHLIGHTED)}
				{/* A last empty line still takes its height. */}
				{"\u200b"}
			</div>
			<textarea
				ref={ref}
				value={code}
				onChange={(event) => {
					setCode(event.target.value);
					onChange(event.target.value);
				}}
				spellCheck={false}
				autoCapitalize="off"
				autoComplete="off"
				autoCorrect="off"
				className={cn(
					TEXT_LAYOUT,
					"absolute inset-0 size-full resize-none overflow-hidden bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground selection:bg-sky-500/25 selection:text-transparent"
				)}
				{...props}
			/>
		</div>
	);
}
