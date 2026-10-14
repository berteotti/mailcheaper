import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getAuthorSeo, getHomeSeo, getIssueSeo, getShareImage } from "../lib/archive-seo.js";

const APP = "https://mailcheap.test";
const newsletter = {
	name: "Field notes",
	slug: "field-notes",
	fromName: "Jane Doe",
	imageUrl: "/logos/field-notes.webp",
	description: "One idea about building things, every Sunday.",
	socialLinks: ["https://x.com/example", "https://youtube.com/@example"],
};
const issue = {
	subject: "How to price a side project",
	previewText: "Charge more than feels right.",
	archiveSlug: "how-to-price-a-side-project",
	thumbnailUrl: "https://images.example.com/thumb.png",
	sentAt: new Date("2023-10-21T10:00:00Z"),
	updatedAt: new Date("2026-10-05T17:00:00Z"),
};

afterEach(() => {
	delete process.env.SHARED_DOMAIN;
});

test("issues point search engines at the archive's domain", () => {
	const { metadata } = getIssueSeo({ ...newsletter, archiveHost: "news.example.com" }, issue, APP);
	assert.equal(metadata.alternates.canonical, "https://news.example.com/p/how-to-price-a-side-project");
	assert.deepEqual(metadata.robots, { index: true, follow: true });
	assert.deepEqual(metadata.title, { absolute: "How to price a side project" });
	assert.equal(metadata.description, "Charge more than feels right.");
	assert.equal(metadata.openGraph.type, "article");
	assert.equal(metadata.openGraph.url, metadata.alternates.canonical);
	assert.equal(metadata.openGraph.publishedTime, "2023-10-21T10:00:00.000Z");
	assert.equal(metadata.twitter.card, "summary_large_image");
	assert.equal(metadata.twitter.creator, "@example");
	assert.deepEqual(metadata.icons, { icon: "/logos/field-notes.webp" });
});

test("share images are the issue's own picture, or a generated card", () => {
	assert.deepEqual(getShareImage(newsletter, issue, APP), {
		url: "https://images.example.com/thumb.png",
		alt: "How to price a side project",
	});
	assert.equal(
		getShareImage(newsletter, { ...issue, thumbnailUrl: undefined }, APP).url,
		"https://mailcheap.test/archive/field-notes/og?p=how-to-price-a-side-project"
	);
	assert.deepEqual(getShareImage(newsletter, { ...issue, thumbnailUrl: "/email/x.png" }, APP), {
		url: "https://mailcheap.test/email/x.png",
		alt: "How to price a side project",
	});
});

test("issues describe themselves as blog posts for search engines", () => {
	const { jsonLd } = getIssueSeo(newsletter, issue, APP);
	assert.equal(jsonLd["@type"], "BlogPosting");
	assert.equal(jsonLd.headline, "How to price a side project");
	assert.equal(jsonLd.datePublished, "2023-10-21T10:00:00.000Z");
	assert.equal(jsonLd.dateModified, "2023-10-21T10:00:00.000Z", "stat updates don't make old issues look edited");
	assert.deepEqual(jsonLd.author, {
		"@type": "Person",
		name: "Jane Doe",
		url: "https://mailcheap.test/archive/field-notes/authors/jane-doe",
		image: "https://mailcheap.test/logos/field-notes.webp",
		sameAs: newsletter.socialLinks,
	});
	assert.equal(jsonLd.publisher.logo.url, "https://mailcheap.test/logos/field-notes.webp");
});

test("the author page is a profile with the photo, bio and social profiles", () => {
	const author = { bio: "I write about building small software companies.", imageUrl: "/authors/jane.jpg" };
	const { metadata, jsonLd } = getAuthorSeo({ ...newsletter, author, archiveHost: "news.example.com" }, APP);
	assert.equal(metadata.alternates.canonical, "https://news.example.com/authors/jane-doe");
	assert.deepEqual(metadata.title, { absolute: "Jane Doe" });
	assert.equal(metadata.description, "I write about building small software companies.");
	assert.equal(metadata.openGraph.type, "profile");
	assert.deepEqual(metadata.openGraph.images, [{ url: "https://mailcheap.test/authors/jane.jpg", alt: "Jane Doe" }]);
	assert.equal(metadata.twitter.card, "summary");
	assert.equal(jsonLd["@type"], "ProfilePage");
	assert.deepEqual(jsonLd.mainEntity, {
		"@type": "Person",
		name: "Jane Doe",
		url: "https://news.example.com/authors/jane-doe",
		image: "https://mailcheap.test/authors/jane.jpg",
		description: "I write about building small software companies.",
		sameAs: newsletter.socialLinks,
	});

	const { metadata: withoutPhoto } = getAuthorSeo({ ...newsletter, imageUrl: undefined }, APP);
	assert.equal(withoutPhoto.openGraph.images[0].url, "https://mailcheap.test/archive/field-notes/og");
	assert.equal(
		withoutPhoto.description,
		"One idea about building things, every Sunday.",
		"the newsletter's description stands in for a bio"
	);
});

test("the archive home shares a generated card and canonicalizes to its domain's root", () => {
	process.env.SHARED_DOMAIN = "mailcheapmail.com";
	const { metadata: shared } = getHomeSeo(newsletter, APP);
	assert.equal(shared.alternates.canonical, "https://field-notes.mailcheapmail.com/", "without a subdomain of its own, the shared one");
	const { metadata, jsonLd } = getHomeSeo({ ...newsletter, archiveHost: "news.example.com" }, APP);
	assert.equal(metadata.alternates.canonical, "https://news.example.com/");
	assert.equal(metadata.openGraph.images[0].url, "https://mailcheap.test/archive/field-notes/og");
	assert.equal(jsonLd["@type"], "Blog");

	delete process.env.SHARED_DOMAIN;
	const { metadata: withoutDomain } = getHomeSeo({ ...newsletter, socialLinks: [] }, APP);
	assert.equal(withoutDomain.alternates.canonical, "https://mailcheap.test/archive/field-notes");
	assert.equal(withoutDomain.twitter.creator, undefined);
});
