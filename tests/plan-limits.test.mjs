import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { activate, anonymous, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

// Sends go through the real code: jobs wait in the D1 outbox and run here as the queue consumer runs them,
// SES sends land in the stub. Accounts get tiny limits so each case sends a handful of emails.
let app;
let m;
const processed = new Set();

async function readDueJobs() {
	const rows = await m.db.getAll("SELECT _id, kind, payload FROM job_outbox WHERE availableAt <= ? ORDER BY rowid", [Date.now()]);
	return rows.filter(({ _id }) => !processed.has(_id)).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

async function runJobs() {
	const results = [];
	for (let jobs = await readDueJobs(); jobs.length > 0; jobs = await readDueJobs()) {
		for (const { _id, kind, payload } of jobs) {
			processed.add(_id);
			results.push(kind === "send" ? await m.sending.runSendJob(payload) : await m.scheduling.runScheduledSend(payload));
		}
	}
	return results;
}

// Jobs already written are left alone.
async function skipJobs() {
	for (const { _id } of await m.db.getAll("SELECT _id FROM job_outbox")) processed.add(_id);
}

async function setup(email, { emails, subscribers, contacts, welcome = false }) {
	const user = await signIn(email);
	await activate(user, { limitOverrides: { emailsPerMonth: emails, subscribers } });
	const slug = email.split("@")[0].replace(/[^a-z0-9]/g, "-");
	const url = await as(user, () =>
		catchRedirect(
			m.newsletters.saveNewsletter(
				null,
				form({
					name: `${slug} news`,
					slug,
					fromEmail: `hello@${slug}.mailcheapmail.com`,
					postalAddress: "1 Main St, Paris",
					archiveEnabled: "on",
					...(welcome && { welcomeEnabled: "on", welcomeSubject: "Welcome", welcomeMarkdown: "Thanks for joining." }),
				})
			)
		)
	);
	user.newsletterId = url.split("/").at(-1);
	user.slug = slug;
	const rows = Array.from({ length: contacts }, (_, index) => ({ email: `reader${index}@${slug}.example.org`, status: "active" }));
	await as(user, () => m.contacts.importContacts({ newsletterId: user.newsletterId, consent: true, rows }));
	return user;
}

async function draft(user, subject = "Issue") {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const id = url.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject, previewText: "This week", body: "<p>Hello</p>" }));
	return id;
}

const campaignOf = (user, id) => m.db.getOne("SELECT * FROM campaigns WHERE accountId = ? AND _id = ?", [user.accountId, id]);

async function usage(user) {
	return (await m.db.getOne("SELECT usage FROM accounts WHERE _id = ?", [user.accountId])).usage;
}

async function setUsage(user, emailsSent) {
	await m.records.updateRows("accounts", { where: "_id = ?", params: [user.accountId] }, { set: { "usage.emailsSent": emailsSent } });
}

async function createApiKey(user) {
	user.apiKey ??= (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site" })))).key;
	return user.apiKey;
}

async function signup(user, email) {
	const key = await createApiKey(user);
	const response = await callApi("POST", "/api/v1/contacts", { key, body: { newsletter: user.slug, email } });
	await flushAfter();
	return response;
}

before(async () => {
	app = await startTestApp();
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		archive: await import("../app/archive/actions.js"),
		sending: await import("../lib/sending.js"),
		scheduling: await import("../lib/scheduling.js"),
		db: await import("../lib/db.js"),
		records: await import("../lib/records.js"),
		accounts: await import("../lib/accounts.js"),
		blocks: await import("../lib/account-blocks.js"),
		usage: await import("../lib/usage.js"),
	};
});

after(() => app?.stop());

describe("counting", () => {
	test("every email the account sends counts: issues and tests", async () => {
		const user = await setup("counting@example.com", { emails: 100, subscribers: 100, contacts: 3 });
		const id = await draft(user);
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
		assert.equal((await usage(user)).emailsSent, 1);

		const before = sesEmails.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		const [batch] = await runJobs();
		assert.equal(batch.sent, 3);
		assert.equal(sesEmails.length - before, 3);
		assert.equal((await usage(user)).emailsSent, 4);
		assert.equal((await campaignOf(user, id)).status, "sent");
	});

	test("welcome emails count, and keep going over the limit, like signups", async () => {
		const user = await setup("welcome@example.com", { emails: 1, subscribers: 100, contacts: 0, welcome: true });
		await setUsage(user, 1);
		const response = await signup(user, "new-reader@example.org");
		assert.equal(response.status, 201);
		const welcome = await m.db.getOne("SELECT * FROM messages WHERE accountId = ? AND kind = 'welcome'", [user.accountId]);
		assert.equal(welcome.status, "sent");
		assert.equal((await usage(user)).emailsSent, 2, "over the limit, and counted");
	});
});

describe("blocking", () => {
	test("a send that needs more emails than are left is refused with plan_limit_emails", async () => {
		const user = await setup("emails@example.com", { emails: 5, subscribers: 100, contacts: 4 });
		await setUsage(user, 2);
		const id = await draft(user);
		const result = await as(user, () => m.campaigns.sendCampaign(id, {}));
		assert.deepEqual(result, {
			error: "This send needs 4 emails and your plan has 3 left this month. Upgrade to send.",
			code: "plan_limit_emails",
		});
		assert.equal((await campaignOf(user, id)).status, "draft");
		assert.equal(await m.db.getValue("SELECT count(*) FROM messages WHERE accountId = ? AND campaignId = ?", [user.accountId, id]), 0, "nothing was queued");

		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, { audienceLimit: 3 })), { ok: true }, "fewer contacts fit");
		await runJobs();
		assert.equal((await usage(user)).emailsSent, 5);
	});

	test("an account over its subscriber limit can't send, but keeps taking signups", async () => {
		const user = await setup("subscribers@example.com", { emails: 1_000, subscribers: 2, contacts: 3 });
		const id = await draft(user);
		const result = await as(user, () => m.campaigns.sendCampaign(id, {}));
		assert.equal(result.code, "plan_limit_subscribers");
		assert.equal(result.error, "You have 3 subscribers and your plan allows 2. Upgrade to send.");
		assert.equal((await signup(user, "still-welcome@example.org")).status, 201);
		assert.equal(await m.db.getValue("SELECT count(*) FROM contacts WHERE accountId = ? AND status = 'active'", [user.accountId]), 4);
	});

	test("scheduling checks the plan, and a schedule after the reset only checks subscribers", async () => {
		const user = await setup("schedule@example.com", { emails: 3, subscribers: 100, contacts: 4 });
		const id = await draft(user);
		const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
		assert.equal((await as(user, () => m.campaigns.scheduleCampaign(id, { scheduledAt: soon }))).code, "plan_limit_emails");
		const current = await usage(user);
		const afterReset = new Date(current.periodEnd.getTime() + 3_600_000).toISOString();
		assert.deepEqual(await as(user, () => m.campaigns.scheduleCampaign(id, { scheduledAt: afterReset })), { ok: true });
	});

	test("a scheduled send that no longer fits goes back to draft when it's due", async () => {
		const user = await setup("due@example.com", { emails: 10, subscribers: 100, contacts: 2 });
		const id = await draft(user);
		const at = new Date(Date.now() + 3_600_000);
		assert.deepEqual(await as(user, () => m.campaigns.scheduleCampaign(id, { scheduledAt: at.toISOString() })), { ok: true });
		await skipJobs();
		await setUsage(user, 10);
		await m.db.execute("UPDATE campaigns SET scheduledAt = ? WHERE accountId = ? AND _id = ?", [new Date(Date.now() + 10_000), user.accountId, id]);
		const { scheduledAt } = await campaignOf(user, id);
		const result = await m.scheduling.runScheduledSend({ accountId: String(user.accountId), campaignId: id, scheduledAt: scheduledAt.toISOString() });
		assert.equal(result.code, "plan_limit_emails");
		assert.equal((await campaignOf(user, id)).status, "draft");
	});

	test("emails another send is still sending count against the next one", async () => {
		const user = await setup("inflight@example.com", { emails: 6, subscribers: 100, contacts: 4 });
		const first = await draft(user, "First");
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(first, {})), { ok: true });
		const second = await draft(user, "Second");
		const result = await as(user, () => m.campaigns.sendCampaign(second, {}));
		assert.equal(result.error, "This send needs 4 emails and your plan has 2 left this month. Upgrade to send.");
		await runJobs();
	});

	test("the batch stops at the limit: the campaign pauses with the code, and resumes after an upgrade", async () => {
		const user = await setup("hardstop@example.com", { emails: 4, subscribers: 100, contacts: 4 });
		const id = await draft(user);
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		await setUsage(user, 2);
		const [batch] = await runJobs();
		assert.equal(batch.sent, 2);
		let campaign = await campaignOf(user, id);
		assert.equal(campaign.status, "paused");
		assert.equal(campaign.pauseCode, "plan_limit_emails");
		assert.equal(campaign.pauseReason, "this month's emails are used up");
		assert.equal(await m.db.getValue("SELECT count(*) FROM messages WHERE accountId = ? AND campaignId = ? AND status = 'queued'", [user.accountId, id]), 2);
		assert.equal((await usage(user)).emailsSent, 4, "never past the limit");

		assert.equal((await as(user, () => m.campaigns.resumeCampaign(id))).code, "plan_limit_emails");
		await m.accounts.setLimitOverrides(user.accountId, { emailsPerMonth: 10, subscribers: 100 });
		assert.deepEqual(await as(user, () => m.campaigns.resumeCampaign(id)), { ok: true });
		await runJobs();
		campaign = await campaignOf(user, id);
		assert.equal(campaign.status, "sent");
		assert.equal(campaign.pauseCode, null);
		assert.equal(campaign.stats.sent, 4);
		assert.equal((await usage(user)).emailsSent, 6);
	});
});

describe("blocked and canceled accounts", () => {
	test("a block mid-send stops the next batch, and the campaign says why", async () => {
		const user = await setup("midsend@example.com", { emails: 100, subscribers: 100, contacts: 2 });
		const id = await draft(user);
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		await m.blocks.blockAccount(user.accountId, { reason: "Review" });
		const [batch] = await runJobs();
		assert.equal(batch.sent, 0);
		const campaign = await campaignOf(user, id);
		assert.equal(campaign.status, "paused");
		assert.equal(campaign.pauseCode, "account_blocked");
		assert.equal(campaign.pauseReason, "the account is blocked");
		assert.equal((await usage(user)).emailsSent, 0, "nothing sent, nothing counted");
	});

	test("a canceled account takes no signups and sends no signup emails; its archive is offline", async () => {
		const user = await setup("canceled@example.com", { emails: 100, subscribers: 100, contacts: 1, welcome: true });
		await createApiKey(user);
		await m.db.execute("UPDATE accounts SET subscriptionStatus = 'canceled' WHERE _id = ?", [user.accountId]);
		assert.equal((await signup(user, "too-late@example.org")).status, 402);
		const formResult = await anonymous(() => m.archive.subscribe(null, form({ newsletter: user.slug, email: "visitor@example.org" })));
		assert.deepEqual(formResult, { error: "This newsletter is not taking signups" });
		const { getArchiveNewsletter } = await import("../lib/archive-data.js");
		assert.equal(await getArchiveNewsletter(user.slug), null);

		const newsletter = await m.db.getOne("SELECT * FROM newsletters WHERE accountId = ?", [user.accountId]);
		const reader = await m.db.getOne("SELECT * FROM contacts WHERE accountId = ?", [user.accountId]);
		const { queueWelcomeEmail } = await import("../lib/sending.js");
		assert.deepEqual(await queueWelcomeEmail({ newsletter, contact: { ...reader, status: "active" } }), { skipped: "no active plan" });
	});
});

describe("yearly plans", () => {
	test("the email count starts over each month of a paid year", async () => {
		const user = await setup("yearly@example.com", { emails: 100, subscribers: 100, contacts: 0 });
		const start = new Date(Date.now() - 45 * 86_400_000);
		const { startUsagePeriod, addMonths } = await import("../lib/usage-period.js");
		const usageFields = { ...startUsagePeriod({ start, end: addMonths(start, 12) }), emailsSent: 80 };
		await m.records.updateRows("accounts", { where: "_id = ?", params: [user.accountId] }, { set: { interval: "year", usage: usageFields } });
		const account = await m.db.getOne("SELECT * FROM accounts WHERE _id = ?", [user.accountId]);
		const current = await m.usage.getUsage(account);
		assert.equal(current.emailsSent, 0);
		assert.ok(current.periodStart > start && current.periodStart <= new Date());
		assert.ok(current.periodEnd > new Date());
	});
});
