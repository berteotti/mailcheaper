import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function read(path) {
	return readFileSync(join(root, path), "utf8");
}

test("the status bar's Wi-Fi is a wedge and two arcs, as iOS draws it", () => {
	const icon = read("components/IconWifi.jsx");
	const paths = [...icon.matchAll(/<path\b[^/]*\/>/g)].map((match) => match[0]);
	assert.equal(paths.length, 3);
	assert.equal(paths.filter((path) => /fill="currentColor"/.test(path)).length, 1);
	assert.equal(paths.filter((path) => /stroke="currentColor"/.test(path)).length, 2);
	assert.doesNotMatch(icon, /<circle/i);
	assert.match(read("components/DialogPreviewEmail.jsx"), /import IconWifi from "@\/components\/IconWifi"/);
	assert.doesNotMatch(read("components/DialogPreviewEmail.jsx"), /\{[^}]*\bWifi\b[^}]*\} from "lucide-react"/);
});

test("a fingertip taps the previewed issue's row until it has been opened, and the row says what it does", () => {
	const preview = read("components/DialogPreviewEmail.jsx");
	assert.match(preview, /hasOpenedEmail/);
	assert.match(preview, /\{isHintShown && <HintTap \/>\}/);
	const hint = preview.slice(preview.indexOf("function HintTap"), preview.indexOf("function ViewEmail"));
	assert.match(hint, /motion-reduce:hidden/, "without motion, no ripple spreads");
	assert.match(preview, /Open the email from/, "screen readers hear what the row does");
});

test("on a phone the mobile preview is the email edge to edge", () => {
	const preview = read("components/DialogPreviewEmail.jsx");
	assert.match(preview, /isEdgeToEdge/);
	assert.match(preview, /<ViewEmail /);
});

test("the mail app's bar stays put while the title and sender scroll with the email", () => {
	const preview = read("components/DialogPreviewEmail.jsx");
	const screenEmail = preview.slice(preview.indexOf("function ScreenEmail"), preview.indexOf("function FrameEmail"));
	assert.match(screenEmail, /shrink-0/);
	assert.match(screenEmail, /overflow-y-auto[\s\S]*<HeaderMessage/);
	const desktop = preview.slice(preview.indexOf("function FrameDesktop"), preview.indexOf("function FramePhone"));
	assert.match(desktop, /shrink-0/);
	assert.match(desktop, /overflow-y-auto[\s\S]*fromName/);
});
