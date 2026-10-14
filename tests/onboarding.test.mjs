import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getCleanupSettings } from "../lib/cleanup.js";
import { execute, getAll, getOne, getValue } from "../lib/db.js";
import { activate, anonymous, as, callApi, catchRedirect, findAccount, form, queued, signIn, startTestApp } from "./helpers/app.mjs";
import { flushAfter as flushResponses } from "./stubs/next-server.mjs";

// A new account names its newsletter at /welcome, tries the dashboard without a plan, and meets the paywall
// where something costs: sending, imports, domains and API keys. The REST API and MCP need a plan for everything.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
let app;
let m;
let processed = 0;

// Work after the response, then every job it published, through the queue consumer as the Jobs Worker runs them.
async function flushAfter() {
	await flushResponses();
	while (processed < queued.length) {
		const body = queued[processed++];
		await m.jobs.queue({ messages: [{ body, attempts: 1, ack() {}, retry() {} }] });
	}
}

before(async () => {
	app = await startTestApp();
	m = {
		welcome: await import("../app/welcome/actions.js"),
		onboarding: await import("../lib/onboarding.js"),
		sharedSender: await import("../lib/shared-sender.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		domains: await import("../app/(app)/domains/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		uploadsRoute: await import("../app/api/uploads/route.js"),
		mcpRoute: await import("../app/mcp/route.js"),
		jobs: (await import("../worker/jobs.js")).default,
	};
});

after(() => app?.stop());

function welcome(user, fields) {
	return as(user, () => catchRedirect(m.welcome.completeOnboarding(null, form(fields))));
}

async function callTool(key, name, args) {
	const request = new Request("http://localhost:3000/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
			authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
	});
	const text = await (await anonymous(() => m.mcpRoute.POST(request))).text();
	return JSON.parse(text.split("\n").find((line) => line.startsWith("data: ")).slice(6)).result;
}

function loadAccount(user) {
	return findAccount(user.accountId);
}

describe("/welcome", () => {
	test("a new account names its newsletter first, from the answers, then the dashboard opens", async () => {
		const user = await signIn("new@example.com");
		assert.equal(await m.onboarding.needsOnboarding(await loadAccount(user)), true);

		const answers = { name: "Field notes", description: "One idea a week.", fromName: "Jane", listSize: "growth", listSource: "Substack" };
		assert.equal(await welcome(user, answers), "/");
		const newsletter = await getOne("SELECT * FROM newsletters WHERE accountId = ?", [user.accountId]);
		assert.deepEqual(
			[newsletter.name, newsletter.slug, newsletter.description, newsletter.fromName, newsletter.fromEmail],
			["Field notes", "field-notes", "One idea a week.", "Jane", "hello@field-notes.mailcheapmail.com"]
		);
		assert.deepEqual(getCleanupSettings(newsletter), { enabled: true, issues: 6, days: 180 }, "list cleanup starts on");
		const account = await loadAccount(user);
		assert.deepEqual([account.onboarding.listSize, account.onboarding.listSource], ["growth", "Substack"]);
		assert.ok(account.onboarding.completedAt);
		assert.equal(m.onboarding.getRecommendedPlanId(account), "growth", "the paywall starts on the plan the list fits");
		assert.equal(await m.onboarding.needsOnboarding(account), false);

		assert.equal(await welcome(user, { name: "Again" }), "/", "sent twice, it only finishes");
		assert.equal(await getValue("SELECT count(*) FROM newsletters WHERE accountId = ?", [user.accountId]), 1);
	});

	test("a name another newsletter has gets a numbered slug; no list starts on the smallest plan", async () => {
		const user = await signIn("second@example.com");
		assert.equal(await welcome(user, { name: "Field notes", listSize: "none", listSource: "Substack" }), "/");
		assert.equal((await getOne("SELECT * FROM newsletters WHERE accountId = ?", [user.accountId])).slug, "field-notes-2");
		const account = await loadAccount(user);
		assert.equal(account.onboarding.listSource, undefined, "no list, no source");
		assert.equal(m.onboarding.getRecommendedPlanId(account), "starter");
		assert.equal(m.onboarding.getRecommendedPlanId({ onboarding: { listSize: "more" } }), "scale");
	});

	test("a name is needed, and answers that aren't choices aren't kept", async () => {
		const user = await signIn("blank@example.com");
		assert.deepEqual(await as(user, () => m.welcome.completeOnboarding(null, form({ name: "  " }))), { error: "Name your newsletter" });
		assert.equal(await welcome(user, { name: "Notes", listSize: "huge", listSource: "Myspace" }), "/");
		assert.equal((await loadAccount(user)).onboarding.listSize, undefined);
	});

	test("the list sizes follow the plans' subscribers", () => {
		assert.deepEqual(
			m.onboarding.LIST_SIZES.map(({ label }) => label),
			["Not yet", "Under 5,000", "5,000 to 15,000", "15,000 to 40,000", "40,000 to 100,000", "Over 100,000"]
		);
	});
});

describe("without a plan", () => {
	test("the dashboard sets up and writes; sending, imports, domains and API keys answer subscription_required", async () => {
		const user = await signIn("trying@example.com");
		await welcome(user, { name: "Trying" });
		const newsletter = await getOne("SELECT * FROM newsletters WHERE accountId = ?", [user.accountId]);
		const saved = await as(user, () => m.newsletters.saveNewsletter(null, form({ id: String(newsletter._id), name: "Trying out", slug: "trying" })));
		assert.equal(saved.ok, true);
		const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(String(newsletter._id))));
		const id = url.split("/").at(-1);
		assert.deepEqual(await as(user, () => m.campaigns.saveCampaign(id, { subject: "Hello", previewText: "", body: "<p>Hi</p>" })), { ok: true });

		const blocked = [
			await as(user, () => m.campaigns.sendTestCampaign(id)),
			await as(user, () => m.campaigns.sendCampaign(id)),
			await as(user, () => m.campaigns.scheduleCampaign(id, { scheduledAt: new Date(Date.now() + 86_400_000).toISOString() })),
			await as(user, () => m.contacts.importContacts({ newsletterId: newsletter._id, rows: [{ email: "a@example.org" }], consent: true })),
			await as(user, () => m.domains.addDomainAction(null, form({ domain: "trying.dev" }))),
			await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site" }))),
			await as(user, () => m.newsletters.sendWelcomeTest(newsletter._id)),
		];
		for (const [index, result] of blocked.entries()) assert.equal(result.code, "subscription_required", String(index));

		await activate(user);
		const { key } = await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site" })));
		assert.ok(key, "with a plan it opens");
	});

	test("the dashboard uploads 20 images a day, and the picker lists them", async () => {
		const user = await signIn("images-trial@example.com");
		await welcome(user, { name: "Images trial" });
		const upload = (name) =>
			as(user, () =>
				m.uploadsRoute.POST(
					new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { "content-type": "image/png", "x-file-name": name }, body: PNG })
				)
			);
		for (let index = 0; index < 20; index++) assert.equal((await upload(`trial-${index}`)).status, 200, String(index));
		const capped = await upload("one-more");
		assert.equal(capped.status, 402);
		assert.equal((await capped.json()).code, "subscription_required");

		const library = await as(user, () => m.uploadsRoute.GET(new Request("http://localhost:3000/api/uploads")));
		const { images, nextCursor } = await library.json();
		assert.equal(images.length, 20);
		assert.match(images[0].url, new RegExp(`accounts/${user.accountId}/images/trial-19`), "newest first");
		assert.equal(nextCursor, null);

		await activate(user);
		assert.equal((await upload("paid")).status, 200, "a plan lifts the cap");
		const signedOut = await anonymous(() => m.uploadsRoute.GET(new Request("http://localhost:3000/api/uploads")));
		assert.equal(signedOut.status, 401);
	});

	test("the dashboard adds 5 contacts a day by hand, active at once with the signup checks and no email; imports stay paid", async () => {
		const user = await signIn("contacts-trial@example.com");
		await welcome(user, { name: "Contacts trial" });
		const newsletterId = String((await getOne("SELECT * FROM newsletters WHERE accountId = ?", [user.accountId]))._id);
		const add = (email, consent = "on") => as(user, () => m.contacts.addContact(null, form({ newsletterId, email, ...(consent && { consent }) })));

		assert.deepEqual(await add("me@example.org", null), { error: "Check that this person agreed to get your emails" }, "a refusal doesn't count");
		assert.deepEqual(await add("me@example.org"), { email: "me@example.org", status: "active" }, "though new newsletters ask signups to confirm");
		assert.deepEqual(await add("jane.doe@gmial.com"), { error: "Did you mean jane.doe@gmail.com?" }, "a refused address doesn't count");
		assert.deepEqual(await add("me@example.org"), { error: "me@example.org is already a contact" });
		for (const email of ["a@example.org", "b@example.org", "c@example.org"]) assert.equal((await add(email)).status, "active", email);
		assert.deepEqual(await add("d@example.org"), { error: "Pick a plan to add more contacts", code: "subscription_required" });
		await flushAfter();
		assert.equal(await getValue("SELECT count(*) FROM messages WHERE accountId = ?", [user.accountId]), 0, "sending stays paid: no email");
		const contacts = await getAll("SELECT * FROM contacts WHERE accountId = ? ORDER BY email", [user.accountId]);
		assert.deepEqual(
			contacts.map(({ email, source }) => [email, source]),
			["a", "b", "c", "me"].map((name) => [`${name}@example.org`, "dashboard"])
		);
		const rows = [{ email: "e@example.org" }];
		assert.equal((await as(user, () => m.contacts.importContacts({ newsletterId, rows, consent: true }))).code, "subscription_required");

		await activate(user);
		assert.equal((await add("d@example.org")).status, "active", "a plan lifts the cap");
		await flushAfter();
		assert.equal(await getValue("SELECT count(*) FROM messages WHERE accountId = ?", [user.accountId]), 0, "with a plan, still no confirmation email");
	});

	test("a contact added by hand gets the welcome email once the account has a plan, never before", async () => {
		const user = await signIn("welcome-trial@example.com");
		await welcome(user, { name: "Welcome trial" });
		const { _id, name, slug } = await getOne("SELECT * FROM newsletters WHERE accountId = ?", [user.accountId]);
		const newsletterId = String(_id);
		const settings = { id: newsletterId, name, slug, postalAddress: "1 Main St, Paris", welcomeEnabled: "on", welcomeSubject: "Welcome", welcomeMarkdown: "Thanks." };
		assert.equal((await as(user, () => m.newsletters.saveNewsletter(null, form(settings)))).ok, true, "signups don't confirm, so the welcome email is on");
		const add = (email) => as(user, () => m.contacts.addContact(null, form({ newsletterId, email, consent: "on" })));

		assert.equal((await add("early@example.org")).status, "active");
		await flushAfter();
		assert.equal(await getValue("SELECT count(*) FROM messages WHERE accountId = ?", [user.accountId]), 0, "a trial account sends nothing");

		// What Stripe's webhook does when the plan starts: the shared address gets set up at the provider.
		await activate(user);
		await m.sharedSender.syncSharedSenders(await loadAccount(user));
		assert.equal((await add("paid@example.org")).status, "active");
		await flushAfter();
		const messages = await getAll("SELECT * FROM messages WHERE accountId = ?", [user.accountId]);
		assert.deepEqual(messages.map(({ kind, email, status }) => [kind, email, status]), [["welcome", "paid@example.org", "sent"]]);
	});

	test("the REST API and MCP still need a plan for everything but billing, adding a contact included", async () => {
		const user = await signIn("api-trial@example.com");
		await welcome(user, { name: "API trial" });
		await activate(user);
		const { key } = await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site" })));
		await execute("UPDATE accounts SET subscriptionStatus = 'canceled' WHERE _id = ?", [user.accountId]);
		const response = await callApi("GET", "/api/v1/newsletters", { key });
		assert.equal(response.status, 402);
		assert.equal(response.body.error.code, "subscription_required");

		const signup = await callApi("POST", "/api/v1/contacts", { key, body: { email: "late@example.org" } });
		assert.equal(signup.status, 402);
		assert.equal(signup.body.error.code, "subscription_required");
		const tool = await callTool(key, "add_contact", { email: "late@example.org" });
		assert.equal(tool.isError, true);
		assert.equal(JSON.parse(tool.content[0].text).error.code, "subscription_required");
		assert.equal(await getValue("SELECT count(*) FROM contacts WHERE accountId = ?", [user.accountId]), 0);
	});
});
