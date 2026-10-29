import crypto from "node:crypto";
import { getAppHost } from "./config.js";

// A campaign report's clicks per link: each counted click is an event of this type, its link in data as { key, url }
// (lib/email-events.js, lib/campaign-links.js). A link is its address without the parameters that only say where a
// visit came from, so the same page counts once whatever tracking each of its links in the email carries.
export const LINK_CLICK_EVENT = "link_click";

const TRACKING_PARAM =
	/^(utm_\w+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|twclid|ttclid|igshid|li_fat_id|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|ref_src)$/i;
// MailCheap's own pages in its emails: unsubscribing, keeping a subscription, confirming one.
const SYSTEM_PATH = /^\/(api\/)?(unsubscribe|keep|confirm)(\/|$)/;
const ANCHOR_PATTERN = /<a\b[^>]*?\shref\s*=\s*(["'])(https?:\/\/[^"'\s]+)\1[^>]*>([\s\S]*?)<\/a>/gi;
const ALT_PATTERN = /<img\b[^>]*?\salt\s*=\s*(["'])(.*?)\1/i;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const LABEL_LENGTH = 120;

// Null for anything that isn't a web address.
export function normalizeLink(href) {
	let url;
	try {
		url = new URL(String(href ?? "").trim());
	} catch {
		return null;
	}
	if (!["http:", "https:"].includes(url.protocol)) return null;
	const params = [...url.searchParams]
		.filter(([name]) => !TRACKING_PARAM.test(name))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	url.search = new URLSearchParams(params).toString();
	if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	return url.toString();
}

// Short and stable: what groups a link's clicks.
export function getLinkKey(url) {
	return crypto.createHash("sha256").update(url).digest("base64url").slice(0, 16);
}

export function isSystemLink(url, appHost = getAppHost()) {
	try {
		const { host, pathname } = new URL(url);
		return host.toLowerCase() === appHost && SYSTEM_PATH.test(pathname);
	} catch {
		return true;
	}
}

// What a click on href counts as, or null for one that doesn't count: not a web address, or MailCheap's own page.
export function toLinkClick(href) {
	const url = normalizeLink(href);
	return url && !isSystemLink(url) ? { key: getLinkKey(url), url } : null;
}

// What the email shows for each of its links, by key: the link's text, or its picture's alt text. webUrl is the issue's
// page, which sent emails link at the top as "Read online" (lib/sending-rules.js getIssueWebUrl). An issue with editions
// passes each edition's email too: the first label of a link stays.
export function getLinkLabels(html, { webUrl } = {}) {
	const labels = new Map();
	for (const email of [html].flat()) {
		for (const [, , href, inner] of String(email ?? "").matchAll(ANCHOR_PATTERN)) {
			const url = normalizeLink(decodeEntities(href));
			if (!url) continue;
			const key = getLinkKey(url);
			if (!labels.get(key)) labels.set(key, getLabel(inner));
		}
	}
	const page = webUrl && normalizeLink(webUrl);
	if (page && !labels.get(getLinkKey(page))) labels.set(getLinkKey(page), "Read online");
	return labels;
}

// "example.com/post?id=2" for a list: no scheme, no lone trailing slash.
export function formatLinkUrl(url) {
	return String(url).replace(/^https?:\/\//, "").replace(/^([^/?#]+)\/(?=$|[?#])/, "$1");
}

function getLabel(inner) {
	const text = decodeEntities(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
	const label = text || decodeEntities(ALT_PATTERN.exec(inner)?.[2] ?? "").trim();
	return label ? label.slice(0, LABEL_LENGTH) : null;
}

// HTML's text back to plain text: the common named entities and every numeric one.
function decodeEntities(value) {
	return String(value ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
		if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
		const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
		return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
	});
}
