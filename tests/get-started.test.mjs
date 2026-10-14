import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { execute, getOne } from "../lib/db.js";
import { activate, addVerifiedDomain, anonymous, as, catchRedirect, findAccount, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";

// The dashboard's get-started panel: each step is done from what the account has, nothing another account has
// counts, the list finishes for good once every step but the optional domain is done, and dismissing it hides
// it for good, on every device.
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		welcome: await import("../app/welcome/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		domains: await import("../app/(app)/domains/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		auth: await import("../lib/auth.js"),
		getStarted: await import("../lib/get-started.js"),
	};
});

after(() => app?.stop());

async function customer(email, { hasPlan = false } = {}) {
	const user = await signIn(email);
	if (hasPlan) await activate(user);
	const slug = email.split("@")[0];
	const url = await as(user, () =>
		catchRedirect(
			m.newsletters.saveNewsletter(
				null,
				form({ name: `${slug} news`, slug, fromEmail: `hello@${slug}.mailcheapmail.com`, postalAddress: "1 Main St, Paris" })
			)
		)
	);
	user.newsletterId = url.split("/").at(-1);
	user.slug = slug;
	return user;
}

async function draft(user, subject = "Issue") {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const id = url.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject, previewText: "This week", body: "<p>Hello</p>" }));
	return id;
}

function addReader(user) {
	const rows = [{ email: `reader@${user.slug}.example.org`, status: "active" }];
	return as(user, () => m.contacts.importContacts({ newsletterId: user.newsletterId, consent: true, rows }));
}

function createKey(user, level) {
	return as(user, () => m.apiKeys.createApiKey(null, form({ name: level, level })));
}

// What Better Auth keeps when someone clicks Allow on the consent page (tests/oauth.test.mjs goes through it).
async function connectApp(user) {
	const now = new Date().toISOString();
	const clientId = "https://chatgpt.com/connector/mailcheap";
	await execute("INSERT OR IGNORE INTO oauthClient (id, clientId, redirectUris, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)", [
		"chatgpt",
		clientId,
		JSON.stringify(["https://chatgpt.com/connector/oauth/callback"]),
		now,
		now,
	]);
	await execute("INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)", [
		`consent-${user.userId}`,
		clientId,
		user.userId,
		JSON.stringify(["openid", "mcp"]),
		now,
		now,
	]);
}

function tomorrow() {
	return new Date(Date.now() + 86_400_000).toISOString();
}

function loadAccount(user) {
	return findAccount(user.accountId);
}

async function check(user) {
	return m.getStarted.getGetStartedSteps(await loadAccount(user), user.newsletterId);
}

async function doneSteps(user) {
	const { steps } = await check(user);
	return steps.filter(({ isDone }) => isDone).map(({ id }) => id);
}

describe("the steps", () => {
	test("a new account has all five to do, the domain one optional, and sees the list", async () => {
		const user = await customer("gs-new@example.com");
		const { steps, draftId, isFinished } = await check(user);
		assert.deepEqual(
			steps.map(({ id, isDone, isOptional }) => [id, isDone, Boolean(isOptional)]),
			[
				["write", false, false],
				["subscribers", false, false],
				["agent", false, false],
				["domain", false, true],
				["send", false, false],
			]
		);
		assert.equal(draftId, null);
		assert.equal(isFinished, false);
		assert.equal(m.getStarted.isGetStartedOpen(await loadAccount(user)), true);
	});

	test("writing: any campaign but a discarded one; the send step opens the draft edited last", async () => {
		const user = await customer("gs-write@example.com");
		const discarded = await draft(user);
		assert.deepEqual(await doneSteps(user), ["write"]);
		await as(user, () => m.campaigns.discardCampaign(discarded));
		assert.deepEqual(await doneSteps(user), [], "a discarded draft is gone");

		const older = await draft(user, "First");
		const newer = await draft(user, "Second");
		assert.equal((await check(user)).draftId, newer);
		await as(user, () => m.campaigns.saveCampaign(older, { subject: "First, edited", previewText: "", body: "<p>Hi</p>" }));
		assert.equal((await check(user)).draftId, older);
	});

	test("subscribers: any contact, which an account adds once it has a plan", async () => {
		const user = await customer("gs-readers@example.com");
		assert.equal((await addReader(user)).code, "subscription_required");
		assert.deepEqual(await doneSteps(user), []);
		await activate(user);
		await addReader(user);
		assert.deepEqual(await doneSteps(user), ["subscribers"]);
	});

	test("an AI agent: a full access key that isn't revoked, or an app connected with OAuth", async () => {
		const user = await customer("gs-agent@example.com", { hasPlan: true });
		await createKey(user, "signups");
		assert.deepEqual(await doneSteps(user), [], "a signups only key can't run an agent");
		await createKey(user, "full");
		assert.deepEqual(await doneSteps(user), ["agent"]);
		const key = await getOne("SELECT _id FROM api_keys WHERE accountId = ? AND level = 'full'", [user.accountId]);
		assert.deepEqual(await as(user, () => m.apiKeys.revokeApiKey(key._id)), { ok: true });
		assert.deepEqual(await doneSteps(user), [], "a revoked key connects nothing");

		const connected = await customer("gs-chatgpt@example.com");
		await connectApp(connected);
		assert.deepEqual(await doneSteps(connected), ["agent"], "no plan needed: ChatGPT and Claude connect with OAuth");
		assert.deepEqual(await doneSteps(user), [], "another account's app doesn't count");
	});

	test("an own domain: once it's verified; optional with a shared domain, needed without one", async () => {
		const user = await customer("gs-domain@example.com", { hasPlan: true });
		assert.equal((await as(user, () => m.domains.addDomainAction(null, form({ domain: "gs-pending.dev" })))).ok, true);
		assert.deepEqual(await doneSteps(user), [], "not until it's verified");
		await addVerifiedDomain(user, "gs-domain.dev");
		assert.deepEqual(await doneSteps(user), ["domain"]);

		const isOptional = async () => (await check(user)).steps.find(({ id }) => id === "domain").isOptional;
		assert.equal(await isOptional(), true);
		assert.equal(await withEnv({ SHARED_DOMAIN: "" }, isOptional), false);
	});

	test("sending: a campaign scheduled or sent; unscheduling takes it back", async () => {
		const user = await customer("gs-send@example.com", { hasPlan: true });
		await addReader(user);
		const id = await draft(user);
		assert.deepEqual(await as(user, () => m.campaigns.scheduleCampaign(id, { scheduledAt: tomorrow() })), { ok: true });
		assert.deepEqual(await doneSteps(user), ["write", "subscribers", "send"]);
		assert.deepEqual(await as(user, () => m.campaigns.unscheduleCampaign(id)), { ok: true });
		assert.deepEqual(await doneSteps(user), ["write", "subscribers"]);
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		assert.deepEqual(await doneSteps(user), ["write", "subscribers", "send"]);
	});
});

describe("the list", () => {
	test("finishes once every step but the optional domain is done, and stays finished", async () => {
		const user = await customer("gs-finish@example.com", { hasPlan: true });
		await addReader(user);
		await createKey(user, "full");
		const id = await draft(user);
		await as(user, () => m.campaigns.scheduleCampaign(id, { scheduledAt: tomorrow() }));

		const withoutSharedDomain = await withEnv({ SHARED_DOMAIN: "" }, () => check(user));
		assert.equal(withoutSharedDomain.isFinished, false, "without a shared domain, newsletters need a domain of their own");
		assert.equal(m.getStarted.isGetStartedOpen(await loadAccount(user)), true);

		assert.equal((await check(user)).isFinished, true);
		const account = await loadAccount(user);
		assert.ok(account.onboarding.checklistFinishedAt instanceof Date);
		assert.equal(m.getStarted.isGetStartedOpen(account), false);

		const key = await getOne("SELECT _id FROM api_keys WHERE accountId = ? AND level = 'full'", [user.accountId]);
		await as(user, () => m.apiKeys.revokeApiKey(key._id));
		assert.equal(m.getStarted.isGetStartedOpen(await loadAccount(user)), false, "a key revoked later doesn't bring it back");
	});

	test("dismissed, it's hidden for good on every device, and the /welcome answers stay", async () => {
		const user = await signIn("gs-dismiss@example.com");
		await as(user, () => catchRedirect(m.welcome.completeOnboarding(null, form({ name: "Dismissed", listSize: "growth", listSource: "Substack" }))));
		assert.equal(m.getStarted.isGetStartedOpen(await loadAccount(user)), true);

		assert.deepEqual(await as(user, () => m.welcome.dismissGetStarted()), { ok: true });
		const account = await loadAccount(user);
		assert.ok(account.onboarding.checklistDismissedAt instanceof Date);
		assert.deepEqual([account.onboarding.listSize, account.onboarding.listSource], ["growth", "Substack"]);
		assert.ok(account.onboarding.completedAt);

		const otherDevice = await signIn("gs-dismiss@example.com");
		const { account: seen } = await as(otherDevice, () => m.auth.requireAccount());
		assert.equal(m.getStarted.isGetStartedOpen(seen), false);

		await as(otherDevice, () => m.welcome.dismissGetStarted());
		const again = await loadAccount(user);
		assert.equal(again.onboarding.checklistDismissedAt.getTime(), account.onboarding.checklistDismissedAt.getTime(), "dismissing again keeps the first date");
	});

	test("dismissing needs a session", async () => {
		assert.equal(await anonymous(() => catchRedirect(m.welcome.dismissGetStarted())), "/signin");
	});
});
