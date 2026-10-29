import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { execute, getOne } from "../lib/db.js";
import { getEmailOutcome } from "../lib/email-outcome.js";
import { LINK_CLICK_EVENT, toLinkClick } from "../lib/link-stats.js";
import { insertRow } from "../lib/records.js";
import { activate, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";

const HOUR = 3_600_000;

describe("an email's outcome", () => {
	test("is the furthest it got, or what stopped it, and a sent email its inbox never took isn't delivered", () => {
		const sentAt = new Date();
		assert.equal(getEmailOutcome({ status: "delivered", sentAt, deliveredAt: sentAt, openedAt: sentAt, clickedAt: sentAt }), "clicked");
		assert.equal(getEmailOutcome({ status: "complained", sentAt, deliveredAt: sentAt, openedAt: sentAt, complainedAt: sentAt }), "complained");
		assert.equal(getEmailOutcome({ status: "bounced", sentAt, bouncedAt: sentAt }), "bounced");
		assert.equal(getEmailOutcome({ status: "sent", sentAt, error: "Soft bounce: Mailbox Unavailable" }), "undelivered");
		assert.equal(getEmailOutcome({ status: "failed", sentAt, error: "Dropped by PostShiba: Bounced Address" }), "undelivered");
		assert.equal(getEmailOutcome({ status: "sent", sentAt }), "sent", "still on its way");
		assert.equal(getEmailOutcome({ status: "failed", error: "Timed out" }), "unsent", "never handed over");
		assert.equal(getEmailOutcome({ status: "queued" }), "waiting");
	});
});

describe("a campaign's recipients", () => {
	let app;
	let m;
	let user;
	let campaign;
	const people = {};

	before(async () => {
		app = await startTestApp();
		m = {
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			apiKeys: await import("../app/(app)/api-keys/actions.js"),
			campaignPage: await import("../app/(app)/campaigns/[id]/page.js"),
			unsubscribeRoute: await import("../app/api/unsubscribe/route.js"),
			events: await import("../lib/email-events.js"),
			unsubscribeTokens: await import("../lib/unsubscribe.js"),
			TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		};
		user = await customer("recipients@example.com");

		const sentAt = new Date(Date.now() - 24 * HOUR);
		const later = (hours) => new Date(sentAt.getTime() + hours * HOUR);
		campaign = await insertRow("campaigns", {
			accountId: user.accountId,
			newsletterId: user.newsletterId,
			subject: "Spring issue",
			format: "markdown",
			markdown: "Hi",
			status: "sent",
			startedAt: sentAt,
			sentAt,
			linksCountedAt: sentAt,
		});
		const delivered = { status: "delivered", sentAt, deliveredAt: sentAt };
		// In the order of their IDs, the list's.
		const emails = [
			["ada", { ...delivered, openedAt: later(1), clickedAt: later(2) }, "Ada", "Lovelace"],
			["ben", { ...delivered, openedAt: later(3) }],
			["cy", delivered],
			["dee", { status: "bounced", sentAt, bouncedAt: sentAt }],
			["eve", { status: "sent", sentAt, error: "Soft bounce: Mailbox Unavailable, The recipient's inbox is out of storage space" }],
			["fay", { status: "sent", sentAt }],
			["gus", { ...delivered, openedAt: later(4), unsubscribedAt: later(5) }],
			["hal", delivered, null, "Hall"],
			["ivy", { status: "queued" }],
		];
		for (const [index, [name, fields, firstName, lastName]] of emails.entries()) {
			const contact = await insertRow("contacts", {
				_id: `${"c".repeat(20)}${String(index).padStart(4, "0")}`,
				accountId: user.accountId,
				newsletterId: user.newsletterId,
				email: `${name}@example.org`,
				subscribedAt: sentAt,
				firstName: firstName ?? undefined,
				lastName: lastName ?? undefined,
			});
			people[name] = contact;
			people[name].message = await insertRow("messages", {
				accountId: user.accountId,
				newsletterId: user.newsletterId,
				campaignId: campaign._id,
				contactId: contact._id,
				kind: "campaign",
				email: contact.email,
				...fields,
			});
		}
		await insertRow("messages", { accountId: user.accountId, newsletterId: user.newsletterId, campaignId: campaign._id, contactId: people.cy._id, kind: "last-chance", email: "cy@example.org", ...delivered });
		for (const [url, hours] of [
			["https://example.net/shop", 2],
			["https://example.com/story?utm_source=mailcheap", 3],
			["https://example.net/shop", 4],
		]) {
			await insertRow("events", { accountId: user.accountId, type: LINK_CLICK_EVENT, messageId: people.ada.message._id, campaignId: campaign._id, occurredAt: later(hours), data: toLinkClick(url) });
		}
	});

	after(() => app?.stop());

	async function customer(email) {
		const signedIn = await signIn(email);
		await activate(signedIn);
		const slug = email.split("@")[0];
		const url = await as(signedIn, () =>
			catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${slug} news`, slug, postalAddress: "1 Main St, Paris" })))
		);
		signedIn.newsletterId = url.split("/").at(-1);
		signedIn.key = (await as(signedIn, () => m.apiKeys.createApiKey(null, form({ name: "Full", level: "full" })))).key;
		return signedIn;
	}

	const list = (query = "") => callApi("GET", `/api/v1/campaigns/${campaign._id}/recipients${query}`, { key: user.key });
	const names = (body) => body.recipients.map(({ email }) => email.split("@")[0]);

	test("list_campaign_recipients lists everyone it went to, with what each did and how many each filter picks", async () => {
		const { status, body } = await list();
		assert.equal(status, 200, JSON.stringify(body));
		assert.deepEqual(names(body), ["ada", "ben", "cy", "dee", "eve", "fay", "gus", "hal"], "an email still waiting and the last-chance email aren't the issue's");
		assert.deepEqual(body.counts, { all: 8, opened: 3, clicked: 1, unopened: 2, undelivered: 2, bounced: 1, unsubscribed: 1 });
		assert.deepEqual(
			body.recipients.map(({ outcome }) => outcome),
			["clicked", "opened", "delivered", "bounced", "undelivered", "sent", "opened", "delivered"]
		);
		const [ada] = body.recipients;
		assert.deepEqual([ada.contactId, ada.firstName, ada.lastName], [people.ada._id, "Ada", "Lovelace"]);
		assert.deepEqual(ada.clickedLinks, ["https://example.net/shop", "https://example.com/story"], "first clicked first, once each, without tracking parameters");
		assert.ok(ada.openedAt && ada.clickedAt && ada.deliveredAt);
		assert.ok(body.recipients[6].unsubscribedAt, "Gus unsubscribed through it");
		assert.deepEqual([body.recipients[7].firstName, body.recipients[7].lastName], [null, "Hall"]);
		assert.ok(!JSON.stringify(body).includes("storage space"), "the inbox's own words stay out");
		assert.equal(body.nextCursor, null);
	});

	test("each filter picks its recipients, page by page", async () => {
		assert.deepEqual(names((await list("?filter=opened")).body), ["ada", "ben", "gus"]);
		assert.deepEqual(names((await list("?filter=clicked")).body), ["ada"]);
		assert.deepEqual(names((await list("?filter=unopened")).body), ["cy", "hal"]);
		assert.deepEqual(names((await list("?filter=undelivered")).body), ["eve", "fay"]);
		assert.deepEqual(names((await list("?filter=bounced")).body), ["dee"]);
		assert.deepEqual(names((await list("?filter=unsubscribed")).body), ["gus"]);

		const first = (await list("?limit=3")).body;
		assert.deepEqual(names(first), ["ada", "ben", "cy"]);
		assert.equal(first.nextCursor, people.cy._id);
		const second = (await list(`?limit=3&cursor=${first.nextCursor}`)).body;
		assert.deepEqual(names(second), ["dee", "eve", "fay"]);
		const last = (await list(`?limit=3&cursor=${second.nextCursor}`)).body;
		assert.deepEqual(names(last), ["gus", "hal"]);
		assert.equal(last.nextCursor, null);

		assert.equal((await list("?cursor=nope")).body.error.code, "validation_failed");
		assert.equal((await list("?filter=everyone")).body.error.code, "validation_failed");
	});

	test("another account's campaign isn't found", async () => {
		const other = await customer("recipients-other@example.com");
		const foreign = await callApi("GET", `/api/v1/campaigns/${campaign._id}/recipients`, { key: other.key });
		assert.equal(foreign.status, 404);
	});

	async function renderPage(searchParams = {}) {
		const element = await as(user, () => m.campaignPage.default({ params: Promise.resolve({ id: campaign._id }), searchParams: Promise.resolve(searchParams) }));
		return renderToStaticMarkup(createElement(m.TooltipProvider, null, element));
	}

	// The label of the tab open on the page.
	function openTab(html) {
		const [, inner] = /<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>([\s\S]*?)<\/button>/.exec(html) ?? [];
		return inner?.replace(/<[^>]*>/g, "");
	}

	test("the campaign's page lists them in its Recipients tab, a filter at a time", async () => {
		const html = await renderPage();
		assert.match(html, /role="tab"[^>]*>(<svg[\s\S]*?<\/svg>)?Recipients<\/button>/);
		assert.equal(openTab(html), "Timeline", "the page opens on its timeline");
		for (const label of ["Everyone", "Opened", "Clicked", "Didn&#x27;t open", "Not delivered", "Bounced", "Unsubscribed"]) {
			assert.ok(html.includes(`>${label}<`), label);
		}
		assert.ok(html.includes(">Ada Lovelace<") && html.includes("ada@example.org"), "Ada by her name, her address under it");
		assert.ok(html.includes(">Not delivered<") && html.includes(">Unsubscribed<"));
		assert.ok(html.includes('href="https://example.com/story"'), "the links she clicked");
		assert.ok(!html.includes('href="/contacts/'), "no contact pages to open");

		const clicked = await renderPage({ recipients: "clicked" });
		assert.equal(openTab(clicked), "Recipients", "a filter keeps the page on its recipients");
		assert.equal(openTab(await renderPage({ shown: "100" })), "Recipients", "and so does Show more");
		assert.match(clicked, /aria-current="page"[^>]*>Clicked</);
		assert.ok(clicked.includes(">Ada Lovelace<") && !clicked.includes("ben@example.org"));
		assert.ok(clicked.includes(`href="/campaigns/${campaign._id}?recipients=opened"`));
		assert.match(await renderPage({ recipients: "nobody" }), /aria-current="page"[^>]*>Everyone</, "an unknown filter shows everyone");
	});

	test("an unsubscribe counts on the email it came through: the latest issue for a link, the one the provider names for its own", async () => {
		const sentAt = new Date(Date.now() - 2 * HOUR);
		const reader = await insertRow("contacts", { accountId: user.accountId, newsletterId: user.newsletterId, email: "leaving@example.org", subscribedAt: sentAt });
		const issue = await insertRow("campaigns", { accountId: user.accountId, newsletterId: user.newsletterId, subject: "Latest", status: "sent", startedAt: sentAt, sentAt });
		const email = await insertRow("messages", { accountId: user.accountId, newsletterId: user.newsletterId, campaignId: issue._id, contactId: reader._id, kind: "campaign", email: reader.email, status: "delivered", sentAt, deliveredAt: sentAt });
		const token = m.unsubscribeTokens.createUnsubscribeToken({ contactId: reader._id, newsletterId: user.newsletterId });
		const loadEmail = (id) => getOne("SELECT * FROM messages WHERE accountId = ? AND _id = ?", [user.accountId, id]);
		const unsubscribedOf = async (id) => (await getOne("SELECT stats FROM campaigns WHERE accountId = ? AND _id = ?", [user.accountId, id])).stats.unsubscribed;
		function leave() {
			const body = new FormData();
			body.set("source", "page");
			return m.unsubscribeRoute.POST(new Request(`http://localhost:3000/api/unsubscribe?token=${token}`, { method: "POST", body }));
		}
		await leave();
		const { unsubscribedAt } = await loadEmail(email._id);
		assert.ok(unsubscribedAt);
		assert.equal(await unsubscribedOf(issue._id), 1);
		await execute("UPDATE contacts SET status = 'active' WHERE accountId = ? AND _id = ?", [user.accountId, reader._id]);
		await leave();
		assert.equal(await unsubscribedOf(issue._id), 1, "once per email");
		assert.deepEqual((await loadEmail(email._id)).unsubscribedAt, unsubscribedAt, "the first time stays");
		assert.equal((await getOne("SELECT status FROM contacts WHERE accountId = ? AND _id = ?", [user.accountId, reader._id])).status, "unsubscribed");

		const other = await insertRow("contacts", { accountId: user.accountId, newsletterId: user.newsletterId, email: "provider@example.org", subscribedAt: sentAt });
		const named = await insertRow("messages", { accountId: user.accountId, newsletterId: user.newsletterId, campaignId: campaign._id, contactId: other._id, kind: "campaign", email: other.email, status: "delivered", sentAt, deliveredAt: sentAt });
		const before = await unsubscribedOf(campaign._id);
		await m.events.handleEmailEvent({ type: "unsubscribe", accountId: user.accountId, messageId: named._id, email: other.email, emails: [other.email] });
		assert.ok((await loadEmail(named._id)).unsubscribedAt);
		assert.equal(await unsubscribedOf(campaign._id), before + 1);
		await execute("UPDATE contacts SET status = 'active' WHERE accountId = ? AND _id = ?", [user.accountId, other._id]);
		await m.events.handleEmailEvent({ type: "unsubscribe", accountId: user.accountId, messageId: named._id, email: other.email, emails: [other.email] });
		assert.equal(await unsubscribedOf(campaign._id), before + 1, "once per email, the provider's too");
	});
});
