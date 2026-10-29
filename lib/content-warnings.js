import {
	beforeLastTagEnd,
	cleanBlockHtml,
	cleanRichHtml,
	decodeEntities,
	readHtmlBlocks,
	removeHtmlBlocks,
	replaceElements,
} from "./clean-html.js";
import { findBrokenMergeTags } from "./merge-tags.js";
import { UNSUBSCRIBE_PLACEHOLDER } from "./render-email.js";

// What may look broken to readers, for the review step's checklist (lib/presend-checks.js), the API's campaigns and the
// editor's markers beside each block (lib/editor-problems.js): merge tags that go out as written or leave a gap, links
// that go nowhere or where readers can't follow, HTML blocks whose tags don't match up or that lose what emails can't
// show, text left over from a template, and HTML or Markdown that shows as text. Each is something to check, never
// something that stops a send.

const LINK_ELEMENT = { start: /<(a)\b[^>]*>/gi, end: /<\/(a)\s*>/gi };
const CODE_ELEMENT = { start: /<(code|pre)\b[^>]*>/gi, end: /<\/(code|pre)\s*>/gi };
const ATTRIBUTE_PATTERN = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const BUTTON_BEFORE_PATTERN = /<div\s[^<>]*\bdata-button\b[^<>]*>\s*$/i;
// A long issue's links are read up to this many: no real issue has as many.
const MAX_LINKS = 1000;
const MAX_QUOTE = 40;

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;
// Only your own computer or network opens these.
const LOCAL_HOST_PATTERN =
	/^(?:localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\])$|\.(?:local|localhost|test|invalid|internal)$/i;
// Addresses templates leave for the real one.
const PLACEHOLDER_HOST_PATTERN = /(?:^|\.)(?:example\.(?:com|net|org)|your-?(?:domain|website|site|company|link|url|newsletter)\.[a-z]+)$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
// A link's text that reads as a web address, on the domains people know by sight, so a file name like readme.md isn't
// one.
const TEXT_ADDRESS_PATTERN =
	/^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:com|org|net|io|co|ai|app|dev|me|info|biz|xyz|so|gg|tv|fm|ly|to|sh|us|uk|ca|de|fr|es|it|nl|be|ch|at|se|no|dk|fi|pl|pt|br|mx|ar|au|nz|jp|in|eu|edu|gov))(?::\d+)?(?:[/?#]\S*)?$/i;

// Elements that never close, and those HTML closes by itself, whose end tags are optional: one left open, or closed by its
// parent's end tag, is fine.
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const IMPLIED_END_TAGS = new Set(["p", "li", "dt", "dd", "rt", "rp", "optgroup", "option", "colgroup", "caption", "thead", "tbody", "tfoot", "tr", "td", "th", "html", "head", "body"]);
// Their content is text up to their end tag.
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
// What an HTML block loses in emails and on the website (lib/clean-html.js), and why.
const REMOVED_PATTERN = /<(style|script|noscript|iframe|video|audio|object|embed|canvas|svg|form|input|button|select|textarea)\b/i;
const REMOVED_REASONS = {
	style: "style each element inline",
	script: "emails can't run code",
	noscript: "emails can't run code",
	form: "emails can't hold forms",
	input: "emails can't hold forms",
	button: "emails can't hold forms",
	select: "emails can't hold forms",
	textarea: "emails can't hold forms",
};
const IMAGE_PATTERN = /<img\b[^>]*>/gi;

const PLACEHOLDER_PATTERNS = [/lorem ipsum/i, /\b(?:TODO|FIXME|TKTK)\b/, /\[(?:insert|add|your|link|url|name|image|photo|placeholder)\b[^\]\n]{0,40}\]/i];
const PROSE_BREAK_PATTERN = /<\/?(?:p|div|h[1-6]|li|blockquote|tr|td|th|br)\b[^>]*>/gi;
const FORMATTING = [
	{
		pattern: /<\/?(?:a|b|blockquote|br|button|center|div|em|font|h[1-6]|hr|i|iframe|img|li|ol|p|script|span|strong|style|table|tbody|td|th|tr|u|ul)\b[^<>\n]{0,200}>/i,
		advice: "shows as text: HTML goes in an HTML block",
	},
	{
		pattern: /\[[^[\]\n]{1,200}\]\((?:https?:\/\/|mailto:|www\.)[^()\s]{1,500}\)/,
		advice: "shows as text: add the link to the words instead",
	},
	{ pattern: /\*\*[^*\n]{1,100}\*\*/, advice: "shows its asterisks: make the words bold instead" },
	{ pattern: /^[ \t]*#{1,6}[ \t]+\S[^\n]{0,100}/m, advice: "shows its #: make the line a heading instead" },
];

// The review step's name for each kind of warning, which the editor's markers share (lib/editor-problems.js).
export const WARNING_LABELS = {
	"merge-tags": "Merge tags",
	links: "Links",
	"html-blocks": "HTML blocks",
	"placeholder-text": "Placeholder text",
	formatting: "Formatting",
};

// The issue's warnings, each { id, label, message, count, words }: message about the first of count, and words to find it
// by in the editor, when it's text there. html: the issue as the editor writes it, or an HTML email designed elsewhere
// (isDesigned), whose links alone are read.
export function findContentWarnings(html, { isDesigned = false } = {}) {
	const source = String(html ?? "");
	const cleaned = isDesigned ? "" : cleanRichHtml(source);
	const blocks = isDesigned ? [] : readHtmlBlocks(cleaned).map(getHtmlBlockWarnings);
	const warnings = [];

	const links = [...findLinkWarnings(source), ...blocks.flat().filter(({ id }) => id === "links")];
	if (links.length) warnings.push(summarize(links));
	if (isDesigned) return warnings;

	const blockProblems = blocks.map((block) => block.find(({ id }) => id === "html-blocks")).filter(Boolean);
	if (blockProblems.length) warnings.push(summarize(blockProblems));
	for (const warning of findTextWarnings(readProse(cleaned))) warnings.push(summarize([warning]));
	return warnings;
}

// The first of a kind's warnings, with how many there are.
function summarize(warnings) {
	const [{ id, message, words }] = warnings;
	return { id, label: WARNING_LABELS[id], message, count: warnings.length, ...(words && { words }) };
}

// {{...}} that goes out as written: neither a name's tag nor the unsubscribe link, which each email fills in wherever it
// is. One warning per tag, { id, message, words }. A name's tag without a fallback leaves no gap: it goes with the space
// before it (lib/merge-tags.js).
export function getMergeTagWarnings(values) {
	return findBrokenMergeTags(values)
		.filter((tag) => tag !== UNSUBSCRIBE_PLACEHOLDER)
		.map((tag) => ({ id: "merge-tags", message: `${tag} goes out as written: only {{first_name}} and {{last_name}} are filled in`, words: tag }));
}

// An HTML block's warnings, from its HTML as its author wrote it, { id, message }: its own first (tags that don't match
// up, parts emails remove, nothing left to show), then its links'. A block whose tags don't match up has its links read
// wrong too: its own warning says why.
export function getHtmlBlockWarnings(source) {
	const html = String(source ?? "");
	const tags = findTagProblem(html);
	const own = findBlockProblem(html, tags);
	return [...(own ? [{ id: "html-blocks", message: own }] : []), ...(tags ? [] : findLinkWarnings(html, { inBlock: true }))];
}

// Each link of the HTML that looks broken, in order. A button's own <div> marks its link.
function findLinkWarnings(html, { inBlock = false } = {}) {
	const warnings = [];
	forEachElement(html, LINK_ELEMENT, (tag, content) => {
		if (warnings.length >= MAX_LINKS) return;
		const attributes = readAttributes(tag[0].replace(/^<a\b/i, "").replace(/>$/, ""));
		const warning = getLinkWarning({
			href: attributes.has("href") ? decodeEntities(attributes.get("href")) : null,
			text: readText(content),
			hasImage: /<img\b/i.test(content),
			isAnchor: attributes.has("name") || attributes.has("id"),
			isButton: !inBlock && BUTTON_BEFORE_PATTERN.test(html.slice(Math.max(0, tag.index - 60), tag.index)),
			inBlock,
		});
		if (warning) warnings.push(warning);
	});
	return warnings;
}

// A link's warning, { id, message, words }, or null. href: null for a link without one. text: what it shows, on one line.
// isAnchor: one others link to, like <a name="top">. isButton: a button's, whose missing link or text is the review
// step's own check. inBlock: one in an HTML block, whose words aren't the editor's to select.
export function getLinkWarning({ href, text = "", hasImage = false, isAnchor = false, isButton = false, inBlock = false }) {
	const problem = findLinkProblem({ href, text, hasImage, isAnchor, isButton });
	if (!problem) return null;
	const { message, words } = describeLink(problem, { inBlock });
	return { id: "links", message, ...(words && { words }) };
}

function findLinkProblem({ href, text, hasImage, isAnchor, isButton }) {
	if (href === null) return isAnchor || isButton ? null : { kind: "missing", text };
	const value = href.trim();
	// Filled in for each reader: what it becomes depends on their fields.
	if (value.includes("{{")) return null;
	const target = readTarget(value);
	if (target.kind === "missing" && isButton) return null;
	if (target.kind) return { ...target, text, href: value };
	if (!text && !hasImage) return isButton ? null : { kind: "no-text", href: value, host: target.host };
	const textHost = TEXT_ADDRESS_PATTERN.exec(text)?.[1].toLowerCase().replace(/^www\./, "");
	if (textHost && target.host && !isSameSite(textHost, target.host)) return { kind: "mismatch", text, host: target.host };
	return null;
}

// What's wrong with where a link goes ({ kind }), or for a web address that's fine, its host.
function readTarget(href) {
	if (!href || href === "#" || /^javascript:/i.test(href)) return { kind: "missing" };
	const scheme = SCHEME_PATTERN.exec(href)?.[1].toLowerCase();
	if (!scheme) return href.startsWith("#") ? {} : { kind: "partial" };
	if (scheme === "mailto") return isMailto(href) ? {} : { kind: "invalid" };
	if (scheme === "tel" || scheme === "sms") return {};
	if (scheme === "file") return { kind: "file" };
	if (scheme !== "http" && scheme !== "https") return { kind: "invalid" };
	let url;
	try {
		url = new URL(href);
	} catch {
		return { kind: "invalid" };
	}
	const host = url.hostname.toLowerCase();
	if (LOCAL_HOST_PATTERN.test(host)) return { kind: "local", host };
	if (!isWebHost(host)) return { kind: "invalid" };
	if (PLACEHOLDER_HOST_PATTERN.test(host)) return { kind: "placeholder", host };
	return { host: host.replace(/^www\./, "") };
}

// A name with a dot between its parts, like example.org (not example, www. or https), or an IP address.
function isWebHost(host) {
	if (host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
	const labels = host.replace(/\.$/, "").split(".");
	return labels.length > 1 && labels.every(Boolean) && !/^\d+$/.test(labels.at(-1));
}

function isMailto(href) {
	const [addresses] = decodeURIComponentSafe(href.slice("mailto:".length)).split("?");
	return addresses.split(",").every((address) => EMAIL_PATTERN.test(address.trim()));
}

function decodeURIComponentSafe(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

// A subdomain is the same site: blog.example.com for example.com.
function isSameSite(a, b) {
	return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function describeLink(problem, { inBlock }) {
	const where = inBlock ? " in an HTML block" : "";
	const link = problem.text ? `The link on ${quote(problem.text)}${where}` : `A link${where}`;
	// Selected in the editor to fix it: an HTML block's text isn't the editor's.
	const words = !inBlock && problem.text ? problem.text : undefined;
	const messages = {
		missing: `${link} has no address`,
		invalid: `${link} goes to ${quote(problem.href)}, which isn't a working address`,
		partial: `${link} goes to ${quote(problem.href)}, which needs the full address, starting with https://`,
		file: `${link} opens a file on your computer, which readers can't open`,
		local: `${link} goes to ${problem.host}, which only opens on your own computer or network`,
		placeholder: `${link} goes to ${problem.host}, a placeholder address`,
		mismatch: `${link} opens ${problem.host}: spam filters distrust a link that shows one site and opens another`,
		"no-text": `A link to ${quote(problem.host ?? problem.href)}${where} has no text, so readers can't see it`,
	};
	return { message: messages[problem.kind], words };
}

// The first problem of an HTML block, as its author wrote it: tags that don't match up, then what emails remove, then a
// block left showing nothing.
function findBlockProblem(source, tags) {
	if (tags) return describeTags(tags);
	const removed = REMOVED_PATTERN.exec(source)?.[1].toLowerCase();
	if (removed) return `An HTML block's <${removed}> is removed: ${REMOVED_REASONS[removed] ?? "emails can't show it, so link to it instead"}`;
	if (hasOffWebImage(source)) return "A picture in an HTML block is removed: its address has to start with https://";
	if (source.trim() && !cleanBlockHtml(source)) return "An HTML block shows nothing once it's cleaned";
	return null;
}

function hasOffWebImage(source) {
	let isOffWeb = false;
	beforeLastTagEnd(source, (part) => {
		for (const [tag] of part.matchAll(IMAGE_PATTERN)) {
			const src = decodeEntities(readAttributes(tag.slice(4, -1)).get("src") ?? "").trim();
			if (!/^https?:\/\//i.test(src)) {
				isOffWeb = true;
				break;
			}
		}
		return part;
	});
	return isOffWeb;
}

function describeTags({ kind, tag, inner }) {
	const messages = {
		comment: "An HTML block has a comment that's never closed with -->",
		quote: `A quote in an HTML block's <${tag}> is never closed`,
		cut: `An HTML block's <${tag}> is missing its closing >`,
		stray: `An HTML block closes </${tag}> without opening it`,
		crossed: `An HTML block closes </${tag}> while <${inner}> is still open`,
		unclosed: `An HTML block never closes <${tag}>, so what follows can end up inside it`,
	};
	return messages[kind];
}

// The first tag of an HTML block's source that doesn't match up, { kind, tag }: a comment never closed, a tag cut off
// before its ">" or with a quote left open, one closed while another inside it is still open (crossed), one closed
// without being open (stray), and one never closed. Tags HTML closes by itself, like <p>, <li> and table cells, never
// count, and what's in a script or a style is text. Each character is read once.
export function findTagProblem(source) {
	const html = String(source ?? "");
	const lower = html.toLowerCase();
	const open = [];
	const counts = new Map();
	let index = html.indexOf("<");
	while (index !== -1) {
		if (html.startsWith("<!--", index)) {
			const end = html.indexOf("-->", index + 4);
			if (end === -1) return { kind: "comment" };
			index = html.indexOf("<", end + 3);
			continue;
		}
		const name = /^<(\/?)([a-z][^\s/>]*)/i.exec(html.slice(index, index + 64));
		if (!name) {
			index = html.indexOf("<", index + 1);
			continue;
		}
		const tag = name[2].toLowerCase();
		const end = findTagEnd(html, index + name[0].length);
		if (end.kind) return { kind: end.kind, tag };
		index = html.indexOf("<", end.index + 1);
		if (name[1]) {
			const problem = closeTag(tag, open, counts);
			if (problem) return problem;
		} else if (!VOID_TAGS.has(tag) && !end.isSelfClosing) {
			open.push(tag);
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
			if (RAW_TEXT_TAGS.has(tag)) {
				const close = lower.indexOf(`</${tag}`, end.index + 1);
				if (close === -1) return { kind: "unclosed", tag };
				index = close;
			}
		}
	}
	const unclosed = open.find((tag) => !IMPLIED_END_TAGS.has(tag));
	return unclosed ? { kind: "unclosed", tag: unclosed } : null;
}

// Past a tag's attributes to its ">", a quoted value running to its closing quote: { index, isSelfClosing }. A "<"
// before the ">" means the tag was cut off ("cut"), and a tag inside a quoted value that its quote was never closed.
function findTagEnd(html, from) {
	let quote = null;
	let isAfterEquals = false;
	for (let index = from; index < html.length; index += 1) {
		const char = html[index];
		if (quote) {
			if (char === quote) quote = null;
			else if (char === "<" && /[a-z/!]/i.test(html[index + 1] ?? "")) return { kind: "quote" };
		} else if (char === ">") {
			return { index, isSelfClosing: html[index - 1] === "/" };
		} else if (char === "<") {
			return { kind: "cut" };
		} else if (isAfterEquals && (char === '"' || char === "'")) {
			quote = char;
			isAfterEquals = false;
		} else if (char === "=") {
			isAfterEquals = true;
		} else if (!/\s/.test(char)) {
			isAfterEquals = false;
		}
	}
	return { kind: quote ? "quote" : "cut" };
}

// An end tag closes the nearest open tag of its name, and the tags HTML closes by itself in between.
function closeTag(tag, open, counts) {
	// </br> reads as <br>.
	if (VOID_TAGS.has(tag)) return null;
	if (!counts.get(tag)) return IMPLIED_END_TAGS.has(tag) ? null : { kind: "stray", tag };
	while (open.length) {
		const top = open.pop();
		counts.set(top, counts.get(top) - 1);
		if (top === tag) return null;
		if (!IMPLIED_END_TAGS.has(top)) return { kind: "crossed", tag, inner: top };
	}
	return null;
}

// Placeholder text and formatting that shows as text, the first of each in text, the issue's or a block's:
// { id, message, words, index }, index where the words start.
export function findTextWarnings(text) {
	const warnings = [];
	const placeholder = findPlaceholder(text);
	if (placeholder) warnings.push({ id: "placeholder-text", message: `Your issue still says ${quote(placeholder.words)}`, ...placeholder });
	const formatting = findFormatting(text);
	if (formatting) warnings.push({ id: "formatting", ...formatting });
	return warnings;
}

function findPlaceholder(text) {
	for (const pattern of PLACEHOLDER_PATTERNS) {
		const match = pattern.exec(text);
		if (match) return { words: match[0], index: match.index };
	}
	return null;
}

function findFormatting(text) {
	for (const { pattern, advice } of FORMATTING) {
		const match = pattern.exec(text);
		if (!match) continue;
		const words = match[0].trim();
		return { message: `${quote(words)} ${advice}`, words, index: match.index + match[0].indexOf(words) };
	}
	return null;
}

// What readers read in the issue, a line per block: its HTML blocks, code and preformatted text left out, as they're
// written as they're meant to show.
function readProse(html) {
	const prose = beforeLastTagEnd(removeHtmlBlocks(html), (part) => replaceElements(part, CODE_ELEMENT));
	return decodeEntities(beforeLastTagEnd(prose, (part) => part.replace(PROSE_BREAK_PATTERN, "\n").replace(/<[^>]*>/g, "")));
}

function readText(html) {
	return decodeEntities(beforeLastTagEnd(html, (part) => part.replace(/<[^>]*>/g, " ")))
		.replace(/\s+/g, " ")
		.trim();
}

function readAttributes(text) {
	const attributes = new Map();
	for (const [, name, double, single, bare] of text.matchAll(ATTRIBUTE_PATTERN)) {
		const key = name.toLowerCase();
		if (!attributes.has(key)) attributes.set(key, double ?? single ?? bare ?? "");
	}
	return attributes;
}

function forEachElement(html, element, visit) {
	beforeLastTagEnd(html, (part) =>
		replaceElements(part, {
			...element,
			replace: (tag, content) => {
				visit(tag, content);
				return "";
			},
		})
	);
}

function quote(text) {
	const value = String(text).replace(/\s+/g, " ").trim();
	return `“${value.length > MAX_QUOTE ? `${value.slice(0, MAX_QUOTE - 1).trimEnd()}…` : value}”`;
}
