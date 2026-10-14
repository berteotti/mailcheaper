import assert from "node:assert/strict";
import { test } from "node:test";
import { getTrackingPlan } from "../lib/email-event-rules.js";
import { buildRecipientEmail } from "../lib/sending-rules.js";
import { addTracking, getClickUrl, getOpenUrl, isLikelyScanner, readClickToken, readOpenToken } from "../lib/tracking.js";

process.env.BETTER_AUTH_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.APP_URL = "https://mail.example.com";

const BASE = "https://mail.example.com";
const MESSAGE_ID = "66f1a2b3c4d5e6f7a8b9c0d1";

function tokenOf(url) {
	return url.split("/").pop();
}

test("open and click links carry the message and can't be forged", () => {
	assert.equal(readOpenToken(tokenOf(getOpenUrl(BASE, MESSAGE_ID))), MESSAGE_ID);
	const openToken = tokenOf(getOpenUrl(BASE, MESSAGE_ID));
	assert.equal(readOpenToken(openToken.replace(MESSAGE_ID, "66f1a2b3c4d5e6f7a8b9c0d2")), null);

	const url = "https://example.org/?utm_source=newsletter&ref=1";
	const link = readClickToken(tokenOf(getClickUrl(BASE, MESSAGE_ID, url)));
	assert.deepEqual(link, { messageId: MESSAGE_ID, url, isSigned: true });

	const [id, signature] = tokenOf(getClickUrl(BASE, MESSAGE_ID, url)).split(".");
	const swapped = `${id}.${signature}.${Buffer.from("https://evil.example").toString("base64url")}`;
	assert.equal(readClickToken(swapped).isSigned, false, "another destination breaks the signature");
	assert.equal(readClickToken(`${id}.${signature}.${Buffer.from("javascript:alert(1)").toString("base64url")}`), null);
	assert.equal(readClickToken("not-a-token"), null);
});

test("links go through MailCheap except unsubscribe links, and the pixel comes first", () => {
	const html = [
		'<html><body style="margin:0"><p><a href="https://example.org/?a=1&amp;b=2">Example</a>',
		"<a href='https://x.com/example'>X</a>",
		'<a href="mailto:hi@example.com">Mail</a> <a href="#top">Top</a>',
		'<a href="{{unsubscribe_url}}">Unsubscribe</a>',
		'<a href="https://mail.example.com/unsubscribe?token=abc">Unsubscribe here</a></p></body></html>',
	].join("");
	const tracked = addTracking(html, { baseUrl: BASE, messageId: MESSAGE_ID });

	assert.ok(tracked.startsWith(`<html><body style="margin:0"><img src="${getOpenUrl(BASE, MESSAGE_ID)}"`));
	assert.ok(tracked.includes(`href="${getClickUrl(BASE, MESSAGE_ID, "https://example.org/?a=1&b=2")}"`));
	assert.ok(tracked.includes(`href='${getClickUrl(BASE, MESSAGE_ID, "https://x.com/example")}'`));
	assert.ok(tracked.includes('href="mailto:hi@example.com"'));
	assert.ok(tracked.includes('href="#top"'));
	assert.ok(tracked.includes('href="{{unsubscribe_url}}"'));
	assert.ok(tracked.includes('href="https://mail.example.com/unsubscribe?token=abc"'));
});

test("sent emails are tracked and keep a direct unsubscribe link", () => {
	const email = buildRecipientEmail({
		campaign: { format: "rich", subject: "Hi", html: '<p><a href="https://example.org">Example</a></p>' },
		newsletter: { _id: "74f1a2b3c4d5e6f7a8b9c0d2", name: "Field notes", fromEmail: "hi@mail.example.com" },
		contact: { _id: "64f1a2b3c4d5e6f7a8b9c0d1", email: "reader@example.com" },
		messageId: MESSAGE_ID,
	});
	assert.ok(email.html.includes(getOpenUrl(BASE, MESSAGE_ID)));
	assert.ok(email.html.includes(getClickUrl(BASE, MESSAGE_ID, "https://example.org")));
	assert.ok(email.html.includes(`href="${email.unsubscribeUrl}"`), "the footer link isn't rewritten");
	assert.ok(email.text.includes("https://example.org"), "the text part keeps the original links");
	assert.ok(!email.html.includes("{{unsubscribe_url}}"));
});

test("security scanners don't count as clicks", () => {
	const sentAt = new Date("2026-10-06T10:00:00Z");
	const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";
	assert.equal(isLikelyScanner({ userAgent: chrome, sentAt, now: sentAt.getTime() + 5 * 60_000 }), false);
	assert.equal(isLikelyScanner({ userAgent: chrome, sentAt, now: sentAt.getTime() + 5_000 }), true, "too fast for a person");
	assert.equal(isLikelyScanner({ userAgent: "Mimecast Link Checker", sentAt, now: sentAt.getTime() + 600_000 }), true);
	assert.equal(isLikelyScanner({ userAgent: "", sentAt }), true);
});

test("tracked clicks also count as opens", () => {
	const at = new Date("2026-10-06T10:05:00Z");
	assert.deepEqual(getTrackingPlan("Open", at).firsts.map(({ field }) => field), ["openedAt"]);
	const click = getTrackingPlan("Click", at);
	assert.deepEqual(click.firsts.map(({ field }) => field), ["openedAt", "clickedAt"]);
	assert.deepEqual(click.engagement, { lastOpenAt: at, lastClickAt: at });
});
