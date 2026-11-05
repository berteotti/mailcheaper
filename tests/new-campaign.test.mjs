import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getOne } from "../lib/db.js";
import { insertRow } from "../lib/records.js";
import { as, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";

// New on the Campaigns page (components/ButtonNewCampaign.jsx): a draft at once while the open newsletter has no
// campaign, then a dialog to start blank or from a copy of one of its campaigns, sent or not, never one of the
// account's other newsletters'. The copy is a new draft, and the campaign copied stays as it was.
let app;
let m;
let user;

before(async () => {
	app = await startTestApp();
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		campaignsPage: await import("../app/(app)/campaigns/(list)/page.js"),
		ButtonNewCampaign: (await import("../components/ButtonNewCampaign.jsx")).default,
	};
	user = await signIn("new-campaign@example.com");
	user.otherNewsletterId = await addNewsletter("other-news");
	user.newsletterId = await addNewsletter("open-news");
});

after(() => app?.stop());

async function addNewsletter(slug) {
	const url = await as(user, () =>
		catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${slug} letter`, slug, postalAddress: "1 Main St, Paris" })))
	);
	return url.split("/").at(-1);
}

async function draft(newsletterId, values) {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(newsletterId)));
	const id = url.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, values));
	return id;
}

const findCampaign = (id) => getOne("SELECT * FROM campaigns WHERE accountId = ? AND _id = ?", [user.accountId, String(id)]);

// The Campaigns page as its owner gets it, and the New button in its header with what it was given.
async function renderPage() {
	await as(user, () => catchRedirect(m.newsletters.selectNewsletter(user.newsletterId, "/campaigns")));
	const page = await as(user, () => m.campaignsPage.default());
	const html = renderToStaticMarkup(page);
	const [, header] = html.match(/<header[^>]*>([\s\S]*?)<\/header>/);
	return { button: findElement(page, m.ButtonNewCampaign), header };
}

function findElement(node, type) {
	if (Array.isArray(node)) return node.map((child) => findElement(child, type)).find(Boolean) ?? null;
	if (!isValidElement(node)) return null;
	return node.type === type ? node : findElement(node.props.children, type);
}

function readOptions(button) {
	return button.props.campaigns.map(({ thumbnail, ...option }) => {
		assert.ok(isValidElement(thumbnail), "each with its thumbnail, as the table shows it");
		return option;
	});
}

test("New makes a blank draft at once until the open newsletter has a campaign, whatever the account's other newsletters have", async () => {
	await draft(user.otherNewsletterId, { subject: "Elsewhere", previewText: "", body: "<p>Not this one</p>" });

	const { button, header } = await renderPage();
	assert.deepEqual(button.props.campaigns, []);
	assert.match(header, /<button[^>]*>(?:(?!<\/button>)[\s\S])*New<\/button>/);
	assert.doesNotMatch(header, /aria-haspopup="dialog"/, "no dialog to open");
});

test("once it has one, New opens a dialog listing its campaigns to copy, sent or not, newest first", async () => {
	const sentAt = new Date(Date.now() - 7 * 86_400_000);
	const sent = await insertRow("campaigns", {
		accountId: user.accountId,
		newsletterId: user.newsletterId,
		subject: "Issue 1",
		previewText: "The first one",
		format: "rich",
		html: "<h2>Links</h2><p>Three links</p>",
		status: "sent",
		startedAt: sentAt,
		sentAt,
	});
	const draftId = await draft(user.newsletterId, { subject: "Issue 2", previewText: "", body: "<p>Soon</p>" });

	const { button, header } = await renderPage();
	assert.match(header, /<button[^>]*aria-haspopup="dialog"[^>]*>(?:(?!<\/button>)[\s\S])*New<\/button>/);
	const options = readOptions(button);
	assert.deepEqual(
		options.map(({ id, subject, status }) => ({ id, subject, status })),
		[
			{ id: draftId, subject: "Issue 2", status: "draft" },
			{ id: String(sent._id), subject: "Issue 1", status: "sent" },
		],
		"the draft edited last first, as the table lists them, and none of the other newsletter's"
	);
	assert.equal(options[1].at, sentAt.toISOString(), "a sent issue's date is when it went out");
	assert.ok(Date.parse(options[0].at) > sentAt.getTime(), "a draft's, when it was last edited");
});

test("a copy is a new draft of the same newsletter with the subject, preview text and content, and the one copied stays as it was", async () => {
	const sent = await getOne("SELECT _id FROM campaigns WHERE accountId = ? AND subject = ?", [user.accountId, "Issue 1"]);
	const url = await as(user, () => catchRedirect(m.campaigns.duplicateCampaign(String(sent._id))));
	const copy = await findCampaign(url.split("/").at(-1));

	assert.equal(String(copy.newsletterId), user.newsletterId);
	assert.equal(copy.status, "draft");
	assert.equal(copy.subject, "Issue 1 (copy)");
	assert.equal(copy.previewText, "The first one");
	assert.equal(copy.html, "<h2>Links</h2><p>Three links</p>");
	assert.equal(copy.stats.recipients ?? 0, 0);
	assert.equal(copy.sentAt, null);

	const original = await findCampaign(sent._id);
	assert.deepEqual([original.status, original.subject], ["sent", "Issue 1"]);

	const { button } = await renderPage();
	assert.equal(button.props.campaigns[0].id, String(copy._id), "the copy is the newest draft, ready to copy again");
});
