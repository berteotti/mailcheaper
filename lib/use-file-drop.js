import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// What a drop target takes, listed like an input's accept attribute: MIME types ("image/png", "text/*") and extensions
// (".csv"). A file passes on its type, or on its extension when its type is missing or isn't listed: some systems give
// a CSV no type, or a spreadsheet's.
export function acceptsFile({ type, name }, accept) {
	if (!accept) return true;
	const isTypeListed = accept.some((rule) => !rule.startsWith(".") && (rule.endsWith("/*") ? type?.startsWith(rule.slice(0, -1)) : type === rule));
	return isTypeListed || accept.some((rule) => rule.startsWith(".") && name.toLowerCase().endsWith(rule));
}

// Highlights a drop target while files are dragged over it, and hands over the first file dropped, or to onReject when
// accept doesn't take it. React bubbles events from portals (a dialog opened from inside) up to the target too, so
// only its own DOM counts.
export function useFileDrop({ accept, onFile, onReject }) {
	const [isDragging, setIsDragging] = useState(false);
	useFileDropGuard();

	function isFileDragInside(event) {
		return event.currentTarget.contains(event.target) && event.dataTransfer.types.includes("Files");
	}

	return {
		isDragging,
		dropProps: {
			onDragOver(event) {
				if (!isFileDragInside(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
				setIsDragging(true);
			},
			onDragLeave(event) {
				if (!event.currentTarget.contains(event.relatedTarget)) setIsDragging(false);
			},
			onDrop(event) {
				if (!isFileDragInside(event)) return;
				event.preventDefault();
				setIsDragging(false);
				const [file] = event.dataTransfer.files;
				if (!file) return;
				if (acceptsFile(file, accept)) onFile(file);
				else onReject?.(file);
			},
		},
	};
}

// A file of that kind dropped anywhere on the page, outside the drop targets, goes to onFile, and one of another kind to
// onReject. The first one mounted takes it when several want the same kind, and only it is told while files are dragged
// over the page, to show it.
export function usePageFileDrop({ accept, onFile, onReject }) {
	const latest = useRef({ onFile, onReject });
	const [target] = useState(() => ({
		accept,
		onFile: (file) => latest.current.onFile(file),
		onReject: (file) => latest.current.onReject?.(file),
	}));
	const isPageDragging = useSyncExternalStore(subscribePageDrag, () => pageDrag, () => false);
	useFileDropGuard();

	useEffect(() => {
		latest.current = { onFile, onReject };
	});

	useEffect(() => {
		pageTargets.push(target);
		return () => pageTargets.splice(pageTargets.indexOf(target), 1);
	}, [target]);

	return isPageDragging && pageTargets[0] === target;
}

// Let go outside every drop target, a file would be opened by the browser, leaving the page and its unsaved changes.
// While a target is mounted, the window refuses such drops, unless a page-wide target takes them. Targets cancel the
// events they handle first: React's listeners and the editor's sit below the window.
export function useFileDropGuard() {
	useEffect(() => {
		if (guards++ === 0) {
			window.addEventListener("dragover", guardDragOver);
			window.addEventListener("dragleave", guardDragLeave);
			window.addEventListener("drop", guardDrop);
		}
		return () => {
			if (--guards > 0) return;
			window.removeEventListener("dragover", guardDragOver);
			window.removeEventListener("dragleave", guardDragLeave);
			window.removeEventListener("drop", guardDrop);
		};
	}, []);
}

const pageTargets = [];
const pageDragListeners = new Set();
let guards = 0;
let pageDrag = false;
let pageDragTimer;

function isUnhandledFileDrag(event) {
	return !event.defaultPrevented && Boolean(event.dataTransfer?.types.includes("Files"));
}

function guardDragOver(event) {
	if (!isUnhandledFileDrag(event)) return setPageDrag(false);
	event.preventDefault();
	event.dataTransfer.dropEffect = pageTargets.length > 0 ? "copy" : "none";
	setPageDrag(pageTargets.length > 0);
}

// Leaving the window is a dragleave with nothing entered, at the window's edge: Safari sends dragleaves with nothing
// entered inside the page too.
function guardDragLeave(event) {
	const isAtEdge = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
	if (!event.relatedTarget && isAtEdge) setPageDrag(false);
}

function guardDrop(event) {
	setPageDrag(false);
	if (!isUnhandledFileDrag(event)) return;
	event.preventDefault();
	const [file] = event.dataTransfer.files;
	if (!file) return;
	const target = pageTargets.find(({ accept }) => acceptsFile(file, accept));
	if (target) target.onFile(file);
	else pageTargets[0]?.onReject(file);
}

// Dragover repeats while files are over the page, every 350 ms or so in some browsers when the pointer rests, and a
// cancelled drag may send nothing more: the state ends a little after the last one.
function setPageDrag(value) {
	clearTimeout(pageDragTimer);
	if (value) pageDragTimer = setTimeout(() => setPageDrag(false), 600);
	if (pageDrag === value) return;
	pageDrag = value;
	for (const listener of pageDragListeners) listener();
}

function subscribePageDrag(listener) {
	pageDragListeners.add(listener);
	return () => pageDragListeners.delete(listener);
}
