import assert from "node:assert/strict";
import { test } from "node:test";
import { getArchiveHostUrl, getArchiveUrls, getLinkBaseUrl, getNewsletterHost, getSlugForSharedHost } from "../lib/archive-hosts.js";
import { getFeedbackId } from "../lib/sending-rules.js";
import { getShareLinks, getSocialPlatform, parseSocialLinks } from "../lib/social.js";

test("app-domain archive paths move to the newsletter's shared subdomain", () => {
	const shared = "mailcheapmail.com";
	const cases = [
		["/archive/weekly", "", "https://weekly.mailcheapmail.com/"],
		["/archive/weekly/", "", "https://weekly.mailcheapmail.com/"],
		["/archive/weekly/p/my-issue", "?ref=x", "https://weekly.mailcheapmail.com/p/my-issue?ref=x"],
		["/archive/monthly/authors/jane-doe", "", "https://monthly.mailcheapmail.com/authors/jane-doe"],
		["/archive/monthly/sitemap", "", "https://monthly.mailcheapmail.com/sitemap.xml"],
		["/archive/monthly/robots", "", "https://monthly.mailcheapmail.com/robots.txt"],
	];
	for (const [pathname, search, expected] of cases) assert.equal(getArchiveHostUrl(pathname, search, shared), expected, pathname);
	assert.equal(getArchiveHostUrl("/archive/weekly/p/x", "", null), null, "without SHARED_DOMAIN the archive stays on the app");
	assert.equal(getArchiveHostUrl("/campaigns", "", shared), null);
});

test("shared subdomains map to newsletter slugs, one label deep", () => {
	const shared = "mailcheapmail.com";
	assert.equal(getSlugForSharedHost("Weekly.Mailcheapmail.com:443", shared), "weekly");
	assert.equal(getSlugForSharedHost("a.b.mailcheapmail.com", shared), null);
	assert.equal(getSlugForSharedHost("mailcheapmail.com", shared), null);
	assert.equal(getSlugForSharedHost("weekly.example.com", shared), null);
	assert.equal(getSlugForSharedHost("weekly.mailcheapmail.com", null), null);
});

test("a newsletter's host is its verified archive subdomain, else its shared subdomain, else the app", () => {
	const shared = "mailcheapmail.com";
	assert.equal(getNewsletterHost({ slug: "weekly", archiveHost: "news.example.com" }, shared), "news.example.com");
	assert.equal(getNewsletterHost({ slug: "weekly" }, shared), "weekly.mailcheapmail.com");
	assert.equal(getNewsletterHost({ slug: "weekly" }, null), null);
	assert.equal(getLinkBaseUrl({ slug: "weekly" }, { sharedDomain: shared, appUrl: "https://app.test" }), "https://weekly.mailcheapmail.com");
	assert.equal(getLinkBaseUrl({ slug: "weekly" }, { sharedDomain: null, appUrl: "https://app.test" }), "https://app.test");
});

test("archive links use the newsletter's host", () => {
	const own = getArchiveUrls({ slug: "weekly", archiveHost: "news.example.com" }, { sharedDomain: null, appUrl: "https://app.test" });
	assert.equal(own.host, "news.example.com");
	assert.equal(own.index, "https://news.example.com/");
	assert.equal(own.siteIndex, "https://news.example.com/");
	assert.equal(own.post("issue-1"), "https://news.example.com/p/issue-1");
	assert.equal(own.absolutePost("issue-1"), "https://news.example.com/p/issue-1");
	assert.equal(own.author("jane-doe"), "https://news.example.com/authors/jane-doe");
	assert.equal(own.absoluteAuthor("jane-doe"), "https://news.example.com/authors/jane-doe");

	const app = getArchiveUrls({ slug: "monthly" }, { sharedDomain: null, appUrl: "https://app.test" });
	assert.equal(app.host, null);
	assert.equal(app.index, "/archive/monthly");
	assert.equal(app.post("issue-2"), "/archive/monthly/p/issue-2");
	assert.equal(app.author("jane-doe"), "/archive/monthly/authors/jane-doe");
	assert.equal(app.siteIndex, "https://app.test/archive/monthly");
	assert.equal(app.absolutePost("issue-2"), "https://app.test/archive/monthly/p/issue-2", "emails need the full URL");
	assert.equal(app.absoluteAuthor("jane-doe"), "https://app.test/archive/monthly/authors/jane-doe");
});

test("social links are recognized by their domain", () => {
	assert.equal(getSocialPlatform("https://twitter.com/example").id, "x");
	assert.equal(getSocialPlatform("https://www.linkedin.com/in/example/").id, "linkedin");
	assert.equal(getSocialPlatform("https://m.youtube.com/@example").id, "youtube");
	assert.deepEqual(getSocialPlatform("https://www.example.com"), {
		id: "website",
		label: "example.com",
		domain: "example.com",
	});
	assert.equal(getSocialPlatform("not a link"), null);
});

test("social links are one https link per line", () => {
	assert.deepEqual(parseSocialLinks(" https://x.com/example\n\nhttps://x.com/example https://youtube.com/@example "), {
		links: ["https://x.com/example", "https://youtube.com/@example"],
	});
	assert.match(parseSocialLinks("http://x.com/example").error, /not an https/);
	assert.match(parseSocialLinks("javascript:alert(1)").error, /not an https/);
	assert.match(parseSocialLinks(Array.from({ length: 9 }, (_, i) => `https://a${i}.com`).join("\n")).error, /at most 8/);
});

test("share links carry the issue URL", () => {
	const [x, linkedin] = getShareLinks({ url: "https://news.example.com/p/a b", text: "Hi & bye" });
	assert.equal(x.href, "https://x.com/intent/post?text=Hi%20%26%20bye&url=https%3A%2F%2Fnews.example.com%2Fp%2Fa%20b");
	assert.equal(linkedin.href, "https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fnews.example.com%2Fp%2Fa%20b");
});

test("Feedback-ID has campaign, newsletter, kind and sender fields", () => {
	assert.equal(
		getFeedbackId({ campaignId: "64f1a2b3c4d5e6f7a8b9c0d1", kind: "campaign", newsletterSlug: "weekly" }),
		"64f1a2b3c4d5e6f7a8b9c0d1:weekly:campaign:mailcheap"
	);
	assert.equal(getFeedbackId({ kind: "welcome", newsletterSlug: "week:ly" }), "welcome:weekly:welcome:mailcheap");
});
