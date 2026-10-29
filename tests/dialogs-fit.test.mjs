import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function read(path) {
	return readFileSync(join(root, path), "utf8");
}

function listJsx(dir) {
	return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listJsx(path);
		return entry.name.endsWith(".jsx") ? [path] : [];
	});
}

test("a dialog never grows past the window: it scrolls inside and keeps its actions in view", () => {
	const dialog = read("components/ui/dialog.jsx");
	assert.match(dialog, /max-h-\[calc\(100dvh-2rem\)\]/);
	assert.match(dialog, /overflow-y-auto/);
	assert.match(dialog, /grid-cols-\[minmax\(0,1fr\)\]/, "wide content can't widen the dialog past the window");
	assert.match(dialog, /sticky -bottom-4/, "the footer sticks to the bottom while the body scrolls");
	assert.match(read("components/ui/sheet.jsx"), /max-h-dvh[^"]*overflow-y-auto/);
	assert.match(read("components/ui/popover.jsx"), /max-h-\(--radix-popover-content-available-height\)[^"]*overflow-y-auto/);
});

test("no dialog turns the shared scrolling off", () => {
	const offenders = [];
	for (const file of [...listJsx("components"), ...listJsx("app")]) {
		const source = read(file);
		for (const match of source.matchAll(/<DialogContent\b/g)) {
			const tag = source.slice(match.index, source.indexOf("</DialogContent>", match.index));
			const className = tag.match(/className=(?:"([^"]*)"|\{[^}]*?"([^"]*)")/);
			const classes = className?.[1] ?? className?.[2] ?? "";
			if (/(^|\s)(overflow-(hidden|visible|clip)|max-h-none|h-screen|h-dvh)(\s|$)/.test(classes)) offenders.push(`${file}: ${classes}`);
		}
	}
	assert.deepEqual(offenders, []);
});
