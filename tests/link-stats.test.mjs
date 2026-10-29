import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { execute, getAll, getOne } from "../lib/db.js";
import { LINK_CLICK_EVENT, formatLinkUrl, getLinkKey, getLinkLabels, isSystemLink, normalizeLink } from "../lib/link-stats.js";
import { insertRow } from "../lib/records.js";
import { getClickUrl, readClickToken } from "../lib/tracking.js";
import { activate, as, catchRedirect, form, queued, signIn, startTestApp } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

test("a link counts once whatever its tracking parameters, its parameters' order or a trailing slash", () => {
	assert.equal(
		normalizeLink("https://Example.com/Post/?utm_source=news&b=2&a=1&fbclid=x&utm_campaign=oct#top"),
		"https://example.com/Post?a=1&b=2#top"
	);
	assert.equal(normalizeLink("https://example.com?utm_medium=email"), "https://example.com/");
	assert.equal(normalizeLink(" https://example.com/a?ref=me&gclid=1 "), "https://example.com/a?ref=me");
	assert.equal(getLinkKey(normalizeLink("https://example.com/a?utm_source=x")), getLinkKey(normalizeLink("https://example.com/a/")));
	assert.notEqual(getLinkKey("https://example.com/a"), getLinkKey("https://example.com/b"));
	assert.equal(getLinkKey("https://example.com/a").length, 16);
	for (const href of ["mailto:hi@example.com", "javascript:alert(1)", "not a url", "", null]) assert.equal(normalizeLink(href), null, href);
});

test("MailCheap's own unsubscribe, keep and confirm pages aren't the issue's links", () => {
	const host = "localhost:3000";
	assert.equal(isSystemLink("http://localhost:3000/api/unsubscribe?token=abc", host), true);
	assert.equal(isSystemLink("http://localhost:3000/unsubscribe", host), true);
	assert.equal(isSystemLink("http://localhost:3000/keep?token=abc", host), true);
	assert.equal(isSystemLink("https://example.com/unsubscribe", host), false, "a newsletter's own page");
	assert.equal(isSystemLink("http://localhost:3000/p/an-issue", host), false);
});

test("each link is shown as its text in the email, its picture's alt text, or Read online for the issue's page", () => {
	const labels = getLinkLabels(
		[
			'<a target="_blank" rel="noopener" href="https://example.com/a?utm_source=news&amp;x=1">Read <strong>this</strong></a>',
			'<a href="https://example.com/a?x=1"><img src="https://cdn.example.com/a.png" alt="Ignored"></a>',
			'<a href="https://example.com/cover"><img src="https://cdn.example.com/c.png" alt="The cover"></a>',
			'<a href="https://example.com/tom">Tom &amp; Jerry&#39;s</a>',
			'<a href="https://example.com/empty"><span> </span></a>',
		].join(""),
		{ webUrl: "https://news.example.com/p/issue" }
	);
	const label = (url) => labels.get(getLinkKey(normalizeLink(url)));
	assert.equal(label("https://example.com/a?x=1"), "Read this", "the first label of the same link stays");
	assert.equal(label("https://example.com/cover"), "The cover");
	assert.equal(label("https://example.com/tom"), "Tom & Jerry's");
	assert.equal(label("https://example.com/empty"), null);
	assert.equal(label("https://news.example.com/p/issue"), "Read online");
	assert.equal(formatLinkUrl("https://example.com/"), "example.com");
	assert.equal(formatLinkUrl("https://example.com/a?b=1"), "example.com/a?b=1");

	const editions = getLinkLabels(['<a href="https://example.com/a">Read</a>', '<a href="https://example.com/a">Lire</a><a href="https://example.com/b">Boutique</a>']);
	assert.equal(editions.get(getLinkKey("https://example.com/a")), "Read", "the campaign's own email first");
	assert.equal(editions.get(getLinkKey("https://example.com/b")), "Boutique", "then its editions'");
});

describe("clicks per link", () => {
	const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
	let app;
	let m;
	let processed = 0;

	before(async () => {
		app = await startTestApp();
		m = {
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			campaigns: await import("../app/(app)/campaigns/actions.js"),
			contacts: await import("../app/(app)/contacts/actions.js"),
			jobs: (await import("../worker/jobs.js")).default,
			clickRoute: await import("../app/c/[token]/route.js"),
			actions: (await import("../lib/actions/campaigns.js")).campaignActions,
		};
	});

	after(() => app?.stop());

	async function customer(email, contacts) {
		const user = await signIn(email);
		await activate(user);
		const slug = email.split("@")[0];
		const url = await as(user, () =>
			catchRedirect(
				m.newsletters.saveNewsletter(
					null,
					form({ name: `${slug} news`, slug, fromEmail: `hello@${slug}.mailcheapmail.com`, postalAddress: "1 Main St, Paris", archiveEnabled: "on" })
				)
			)
		);
		user.newsletterId = url.split("/").at(-1);
		const rows = Array.from({ length: contacts }, (_, index) => ({ email: `reader${index}@${slug}.example.org`, status: "active" }));
		await as(user, () => m.contacts.importContacts({ newsletterId: user.newsletterId, consent: true, rows }));
		return user;
	}

	// Every published job, through the queue consumer as the Jobs Worker runs them.
	async function runJobs() {
		while (processed < queued.length) {
			const body = queued[processed++];
			await m.jobs.queue({ messages: [{ body, attempts: 1, ack() {}, retry() {} }] });
		}
	}

	async function sendIssue(user, body) {
		const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
		const id = url.split("/").at(-1);
		await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "This week", body }));
		const before = sesEmails.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		await runJobs();
		// An hour ago: a click seconds after sending is a link scanner's.
		await execute("UPDATE messages SET sentAt = ? WHERE accountId = ? AND campaignId = ?", [Date.now() - 3_600_000, user.accountId, id]);
		return { id, emails: sesEmails.slice(before) };
	}

	// The tracked links of a sent email, by the address each one leads to.
	function trackedLinks(email) {
		const tokens = [...String(email.html).matchAll(/href="[^"]*\/c\/([^"]+)"/g)].map(([, token]) => token);
		return new Map(tokens.map((token) => [readClickToken(token).url, token]));
	}

	async function click(token, userAgent = BROWSER) {
		const response = await m.clickRoute.GET(new Request(`http://localhost:3000/c/${token}`, { headers: { "user-agent": userAgent } }), {
			params: Promise.resolve({ token }),
		});
		await flushAfter();
		return response;
	}

	async function report(user, id) {
		const action = m.actions.find(({ name }) => name === "get_campaign_report");
		return action.output.parse(await action.handler({ account: user.account, input: { id } }));
	}

	test("a reader's clicks count once per link and once per issue; repeats only add clicks; scanners count for nothing", async () => {
		const user = await customer("clickcount@example.com", 3);
		const story = "https://example.com/story?utm_source=mailcheap";
		const { id, emails } = await sendIssue(
			user,
			`<p><a href="${story}">The story</a> and <a href="https://example.com/shop">the shop</a></p><p><a href="https://example.com/story">Again</a></p>`
		);
		assert.equal(emails.length, 3);
		const campaign = await getOne("SELECT * FROM campaigns WHERE accountId = ? AND _id = ?", [user.accountId, id]);
		assert.equal(campaign.linksCountedAt.getTime(), campaign.startedAt.getTime(), "counted from the send's start");
		const [first, second, third] = emails.map(trackedLinks);
		assert.ok(![...first.keys()].some((url) => url.includes("unsubscribe")), "the unsubscribe link isn't tracked");

		assert.equal((await click(first.get(story))).headers.get("location"), story, "still redirects with its parameters");
		await click(first.get(story));
		await click(first.get("https://example.com/story"));
		await click(first.get("https://example.com/shop"));
		await click(second.get("https://example.com/story"));
		await click(third.get(story), "Mozilla/5.0 (compatible; Barracuda Sentinel)");

		const events = await getAll("SELECT messageId, data FROM events WHERE accountId = ? AND campaignId = ? AND type = ?", [user.accountId, id, LINK_CLICK_EVENT]);
		assert.equal(events.length, 5, "every click but the scanner's");
		assert.deepEqual(events[0].data, { key: getLinkKey("https://example.com/story"), url: "https://example.com/story" });
		const fresh = await getOne("SELECT stats FROM campaigns WHERE accountId = ? AND _id = ?", [user.accountId, id]);
		assert.equal(fresh.stats.clicked, 2, "the issue's click count is unchanged");

		const result = await report(user, id);
		assert.deepEqual(result.links, [
			{ url: "https://example.com/story", text: "The story", clickers: 2, clicks: 4 },
			{ url: "https://example.com/shop", text: "the shop", clickers: 1, clicks: 1 },
		]);
		assert.deepEqual([result.linkClickers, result.linksComplete, result.linksCountedSince], [2, true, null]);
		const hours = result.timeline.hours;
		assert.equal(hours.reduce((sum, { opens }) => sum + opens, 0), 2, "each reader's first open counts once, in its hour");
		assert.equal(hours.reduce((sum, { clicks }) => sum + clicks, 0), 2);
		assert.ok(hours.every(({ at }) => new Date(at) <= new Date()), "no hours to come");
		assert.equal(result.comparison, null, "a first issue has nothing to compare with");
		assert.deepEqual(result.providers.map(({ provider, sent }) => [provider, sent]), [["other", 3]]);
	});

	test("an issue's page linked at the top of its emails shows as Read online, and an edition's links as the edition shows them", async () => {
		const user = await customer("clicklabels@example.com", 2);
		await execute("UPDATE contacts SET language = 'fr' WHERE accountId = ? AND email = ?", [user.accountId, "reader1@clicklabels.example.org"]);
		const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
		const id = url.split("/").at(-1);
		await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "", body: '<p><a href="https://example.com/story">The story</a></p>' }));
		assert.deepEqual(
			await as(user, () => m.campaigns.saveCampaignEdition(id, "fr", { subject: "Numéro", previewText: "", body: '<p><a href="https://example.com/boutique">La boutique</a></p>' })),
			{ ok: true }
		);
		const before = sesEmails.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		await runJobs();
		await execute("UPDATE messages SET sentAt = ? WHERE accountId = ? AND campaignId = ?", [Date.now() - 3_600_000, user.accountId, id]);
		const emails = sesEmails.slice(before);
		const english = trackedLinks(emails.find(({ subject }) => subject === "Issue"));
		const french = trackedLinks(emails.find(({ subject }) => subject === "Numéro"));
		const page = [...english.keys()].find((link) => !link.startsWith("https://example.com/"));
		assert.match(page, /\/p\//, "its emails link its page");
		await click(english.get(page));
		await click(french.get("https://example.com/boutique"));

		const result = await report(user, id);
		assert.deepEqual(
			result.links.map(({ url: link, text }) => [link, text]).sort(),
			[
				["https://example.com/boutique", "La boutique"],
				[normalizeLink(page), "Read online"],
			].sort()
		);
	});

	test("an issue sent before clicks were counted per link has them since its first one; other emails count for nothing", async () => {
		const user = await customer("oldclicks@example.com", 1);
		const contact = await getOne("SELECT * FROM contacts WHERE accountId = ?", [user.accountId]);
		const older = await insertRow("campaigns", {
			accountId: user.accountId,
			newsletterId: user.newsletterId,
			subject: "Older issue",
			status: "sent",
			startedAt: new Date(Date.now() - 86_400_000),
			stats: { recipients: 1, sent: 1, delivered: 1, opened: 1, clicked: 1, bounced: 0, complained: 0, unsubscribed: 0, failed: 0 },
		});
		const sentAt = new Date(Date.now() - 3_600_000);
		const issue = await insertRow("messages", { kind: "campaign", accountId: user.accountId, newsletterId: user.newsletterId, campaignId: older._id, contactId: contact._id, email: contact.email, status: "delivered", sentAt });
		const welcome = await insertRow("messages", { kind: "welcome", accountId: user.accountId, newsletterId: user.newsletterId, contactId: contact._id, email: contact.email, status: "delivered", sentAt });

		const none = await report(user, older._id);
		assert.deepEqual([none.links, none.linksComplete, none.linksCountedSince], [[], false, null]);

		const token = (message, link) => getClickUrl("http://localhost:3000", message._id, link).split("/").at(-1);
		await click(token(issue, "https://example.com/later"));
		await click(token(issue, "http://localhost:3000/api/unsubscribe?token=abc"));
		await click(token(welcome, "https://example.com/later"));

		const partial = await report(user, older._id);
		assert.deepEqual(partial.links, [{ url: "https://example.com/later", text: null, clickers: 1, clicks: 1 }]);
		assert.equal(partial.linksComplete, false);
		assert.ok(partial.linksCountedSince, "counted since its first counted click");
		const counted = await getAll("SELECT * FROM events WHERE accountId = ? AND type = ?", [user.accountId, LINK_CLICK_EVENT]);
		assert.equal(counted.length, 1, "the welcome email and the unsubscribe link aren't counted");
	});
});
