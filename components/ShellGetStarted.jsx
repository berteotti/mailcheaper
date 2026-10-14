"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, useTransition } from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { dismissGetStarted } from "@/app/welcome/actions";
import { Button } from "@/components/ui/button";
import { readStoredNumber, storeValue } from "@/lib/storage";
import { useIsClient } from "@/lib/use-is-client";
import { cn } from "@/lib/utils";

// The get-started panel at the bottom right of every dashboard page, open or folded into a pill, around the
// steps PanelGetStarted renders on the server. Closing it hides it for good, on every device.
export default function ShellGetStarted({ done, total, isFinished, children }) {
	const isClient = useIsClient();
	if (!isClient) return null;
	return (
		<Dock done={done} total={total} isFinished={isFinished}>
			{children}
		</Dock>
	);
}

function Dock({ done, total, isFinished, children }) {
	const pathname = usePathname();
	const router = useRouter();
	const [view, setView] = useState(() => (isFinished ? "closed" : getStartView(pathname)));
	const [shownPathname, setShownPathname] = useState(pathname);
	const [, startTransition] = useTransition();
	const panelRef = useRef(null);
	const pillRef = useRef(null);
	const panelId = useId();
	const isOpen = view === "open";
	const isMinimized = view === "minimized";
	const isClosed = view === "closed";

	if (pathname !== shownPathname) {
		setShownPathname(pathname);
		if (!isClosed) setView(getStartView(pathname));
	}
	if (isFinished && !isClosed) setView("closed");

	useLayoutEffect(() => {
		const shown = isOpen ? panelRef.current : isMinimized ? pillRef.current : null;
		if (!shown) return;
		const { style } = document.documentElement;
		const update = () => style.setProperty(HEIGHT_PROPERTY, `${shown.offsetHeight}px`);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(shown);
		return () => {
			observer.disconnect();
			style.removeProperty(HEIGHT_PROPERTY);
		};
	}, [isOpen, isMinimized]);

	// The layout doesn't render again on navigation, and steps also get done elsewhere: by an AI agent, by an
	// app connected with OAuth, in the docs' tab. Coming back to the window brings them up to date.
	useEffect(() => {
		if (isClosed) return;
		const refresh = () => router.refresh();
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [isClosed, router]);

	function open() {
		storeValue(MINIMIZED_KEY, 0);
		flushSync(() => setView("open"));
		panelRef.current.focus();
	}

	function minimize() {
		storeValue(MINIMIZED_KEY, 1);
		flushSync(() => setView("minimized"));
		pillRef.current.focus();
	}

	function close() {
		setView("closed");
		startTransition(() => dismissGetStarted());
	}

	return (
		<div className="pointer-events-none fixed inset-x-4 bottom-4 z-40 mb-(--save-bar-height) flex justify-end sm:inset-x-auto sm:right-6 sm:bottom-6">
			<button
				ref={pillRef}
				type="button"
				onClick={open}
				inert={!isMinimized}
				aria-expanded={isOpen}
				aria-controls={panelId}
				aria-label={`Get started, ${done} of ${total} done`}
				className={cn(
					"flex h-10 items-center gap-1.5 rounded-full bg-card pr-3 pl-4 text-sm font-medium shadow-float transition-[opacity,scale,background-color] hover:bg-muted active:scale-[0.96]",
					MOTION,
					isMinimized ? SHOWN : HIDDEN
				)}
			>
				Get started
				<span className="text-muted-foreground tabular-nums">
					· {done}/{total}
				</span>
				<ChevronUp className="size-4 text-muted-foreground" />
			</button>
			<section
				ref={panelRef}
				id={panelId}
				tabIndex={-1}
				inert={!isOpen}
				aria-labelledby="get-started-title"
				onKeyDown={(event) => event.key === "Escape" && minimize()}
				className={cn(
					"absolute right-0 bottom-0 left-0 max-h-[calc(100dvh-var(--plan-bar-height)-10rem)] overflow-y-auto overscroll-contain rounded-2xl bg-card p-2 shadow-float outline-none transition-[opacity,scale] sm:left-auto sm:w-89",
					MOTION,
					isOpen ? SHOWN : HIDDEN
				)}
			>
				{children}
				<div className="absolute top-4 right-3 flex gap-1">
					<Button variant="ghost" size="icon-sm" onClick={minimize} aria-label="Minimize" title="Minimize" className={CONTROL}>
						<ChevronDown />
					</Button>
					<Button variant="ghost" size="icon-sm" onClick={close} aria-label="Hide for good" title="Hide for good" className={CONTROL}>
						<X />
					</Button>
				</div>
			</section>
		</div>
	);
}

// The campaign page's editor and preview reach the bottom of the screen, and a phone has no room for the open
// panel next to the page: it starts as the pill there, whatever was picked last.
function getStartView(pathname) {
	const isCovering = EDITOR_PATH.test(pathname) || window.matchMedia(SMALL_SCREEN).matches;
	return isCovering || readStoredNumber(MINIMIZED_KEY) === 1 ? "minimized" : "open";
}

const MINIMIZED_KEY = "mailcheap:get-started-minimized";
const EDITOR_PATH = /^\/campaigns\/[^/]+/;
const SMALL_SCREEN = "(max-width: 767px)";
// Read by the toasts' position in globals.css.
const HEIGHT_PROPERTY = "--get-started-height";
// Opens and folds from the bottom right corner, where the pill sits. Hidden, it's inert rather than invisible:
// a visibility transition leaves the panel unfocusable on the frame it opens.
const MOTION =
	"origin-bottom-right ease-[cubic-bezier(0.23,1,0.32,1)] starting:scale-95 starting:opacity-0 motion-reduce:transition-none";
const SHOWN = "pointer-events-auto duration-200";
const HIDDEN = "scale-95 opacity-0 duration-150";
const CONTROL = "relative text-muted-foreground after:absolute after:-inset-x-0.5 after:-inset-y-1.5";
