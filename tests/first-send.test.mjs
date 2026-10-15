import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getFirstSendProblem, getFirstSendSlice } from "../lib/first-send.js";
import { activate, as, catchRedirect, form, platformEmails, signIn, startTestApp } from "./helpers/app.mjs";

test("the first slice is 5% of never-mailed contacts, between 200 and 2,000", () => {
	assert.equal(getFirstSendSlice(150), null, "small lists go at once");
	assert.equal(getFirstSendSlice(200), null);
	assert.equal(getFirstSendSlice(201), 200);
	assert.equal(getFirstSendSlice(5000), 250);
	assert.equal(getFirstSendSlice(10_000), 500);
	assert.equal(getFirstSendSlice(100_000), 2000);
});

test("a slice over a campaign's levels stops the rest", () => {
	assert.equal(getFirstSendProblem({ sent: 250, bounced: 5 }), null, "2% is the pause limit");
	assert.deepEqual(getFirstSendProblem({ sent: 250, bounced: 6 }), { level: "pause", reason: "The first 250 new contacts had a bounce rate of 2.40% (limit 2.00%)" });
	assert.equal(getFirstSendProblem({ sent: 2000, complained: 2 }).level, "pause");
	assert.equal(getFirstSendProblem({ sent: 2000, complained: 1 }), null, "one complaint");
	assert.equal(getFirstSendProblem({ sent: 0 }), null);
});

describe("first sends in steps", () => {
	let app;
	let m;
	const handled = new Set();

	// The outbox's jobs in the order they were written, as the queue consumer would run them by kind.
	async function readJobs() {
		const rows = await m.db.getAll("SELECT _id, kind, payload, availableAt FROM job_outbox ORDER BY rowid");
		return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
	}

	// Sends run until none are left; checks only once, as the ones they write are due later.
	async function runJobs({ checks = false } = {}) {
		const results = [];
		const end = checks ? (await readJobs()).length : Infinity;
		for (let index = 0; ; index++) {
			const jobs = await readJobs();
			if (index >= Math.min(end, jobs.length)) break;
			const job = jobs[index];
			const isCheck = job.kind === "check-first-send";
			if (handled.has(job._id) || isCheck !== checks) continue;
			handled.add(job._id);
			const result = isCheck ? await m.sending.checkFirstSend(job.payload) : await m.sending.runSendJob(job.payload);
			results.push({ kind: job.kind, availableAt: job.availableAt, result });
		}
		return results;
	}

	const skipPublished = async () => (await readJobs()).forEach(({ _id }) => handled.add(_id));

	async function setup(email, { neverMailed, mailed = 0 }) {
		const user = await signIn(email);
		await activate(user, { limitOverrides: { emailsPerMonth: 100_000, subscribers: 100_000 } });
		const slug = email.split("@")[0];
		const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St" }))));
		user.newsletterId = url.split("/").at(-1);
		const contact = (index, lastSentAt) => ({
			accountId: user.accountId,
			newsletterId: user.newsletterId,
			email: `reader${index}@${slug}.example.org`,
			status: "active",
			...(lastSentAt && { lastSentAt }),
		});
		const db = await m.db.connectDb();
		await db.batch(
			[
				...Array.from({ length: neverMailed }, (_, index) => contact(index)),
				...Array.from({ length: mailed }, (_, index) => contact(neverMailed + index, new Date(Date.now() - 86_400_000))),
			].map((values) => m.records.insertStatement(db, "contacts", { ...values, subscribedAt: new Date() }))
		);
		const draftUrl = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
		user.campaignId = draftUrl.split("/").at(-1);
		await as(user, () => m.campaigns.saveCampaign(user.campaignId, { subject: "Issue", previewText: "Hi", body: "<p>Hello</p>" }));
		return user;
	}

	const count = (user, status) =>
		m.db.getValue("SELECT count(*) FROM messages WHERE accountId = ? AND campaignId = ? AND status = ?", [user.accountId, user.campaignId, status]);
	const campaignOf = (user) => m.db.getOne("SELECT * FROM campaigns WHERE accountId = ? AND _id = ?", [user.accountId, user.campaignId]);
	// A few of the slice's sends bounced.
	async function bounceSlice(user, howMany) {
		await m.db.execute(
			`UPDATE messages SET status = 'bounced', bouncedAt = ? WHERE rowid IN (SELECT rowid FROM messages
				WHERE accountId = ? AND campaignId = ? AND firstSend = 1 AND status = 'sent' LIMIT ?)`,
			[new Date(), user.accountId, user.campaignId, howMany]
		);
	}

	before(async () => {
		app = await startTestApp({ SEND_RATE_PER_SECOND: "1000" });
		m = {
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			campaigns: await import("../app/(app)/campaigns/actions.js"),
			sending: await import("../lib/sending.js"),
			blocks: await import("../lib/account-blocks.js"),
			db: await import("../lib/db.js"),
			records: await import("../lib/records.js"),
		};
	});

	after(() => app?.stop());

	test("a slice goes first; the rest waits 3 hours, then follows when the slice is clean", async () => {
		const user = await setup("clean-list@example.com", { neverMailed: 2500, mailed: 100 });
		const start = Date.now();
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(user.campaignId, {})), { ok: true });
		assert.equal(await count(user, "held"), 2300);
		assert.equal(await count(user, "queued"), 300, "the slice and contacts mailed before");
		const campaign = await campaignOf(user);
		assert.equal(campaign.stats.recipients, 2600);
		assert.deepEqual({ slice: campaign.firstSend.slice, held: campaign.firstSend.held }, { slice: 200, held: 2300 });

		const batchJobs = (await readJobs()).filter(({ kind, payload }) => kind === "send" && payload.accountId === user.accountId);
		assert.ok(batchJobs.every(({ payload }) => payload.campaignId === user.campaignId && payload.messageIds.length <= 50), "batches of the campaign's messages");
		const sends = await runJobs();
		assert.equal(sends.reduce((sum, { result }) => sum + result.sent, 0), 300);
		assert.equal((await campaignOf(user)).status, "sending", "not sent while contacts are held");

		const [check] = await runJobs({ checks: true }).then((results) => results.filter(({ kind }) => kind === "check-first-send"));
		assert.ok(check.availableAt.getTime() >= start + 179 * 60_000, "3 hours later");
		assert.equal(check.result.released, 2300);
		assert.equal(await count(user, "held"), 0);
		assert.equal(await count(user, "queued"), 2300);
		const batches = (await readJobs()).filter(({ _id, kind, payload }) => !handled.has(_id) && kind === "send" && payload.accountId === user.accountId);
		assert.equal(batches.reduce((sum, { payload }) => sum + payload.messageIds.length, 0), 2300);
		assert.ok(batches.every(({ availableAt }) => availableAt.getTime() <= Date.now()), "past the warm-up, at full speed");
		await skipPublished();
	});

	test("a slice with too many bounces blocks the account; once an admin unblocks it, resuming sends the rest", async () => {
		const user = await setup("bought-list@example.com", { neverMailed: 3000 });
		await as(user, () => m.campaigns.sendCampaign(user.campaignId, {}));
		await runJobs();
		await bounceSlice(user, 12);

		const [check] = await runJobs({ checks: true });
		assert.equal(check.result.blocked, true);
		const paused = await campaignOf(user);
		assert.equal(paused.status, "paused");
		assert.equal(paused.pauseCode, "first_send_slice");
		assert.equal(paused.pauseReason, "The first 200 new contacts had a bounce rate of 6.00% (limit 5.00%). The rest of the new contacts weren't sent.");
		const account = await m.db.getOne("SELECT * FROM accounts WHERE _id = ?", [user.accountId]);
		assert.deepEqual(
			[account.status, account.pausedBy, account.pauseReason],
			["paused", "slice", "The first 200 new contacts had a bounce rate of 6.00% (limit 5.00%)"]
		);
		assert.equal(await count(user, "held"), 2800);

		assert.equal((await as(user, () => m.campaigns.resumeCampaign(user.campaignId))).code, "account_blocked");
		await m.blocks.unblockAccount(user.accountId);
		assert.deepEqual(await as(user, () => m.campaigns.resumeCampaign(user.campaignId)), { ok: true });
		assert.equal(await count(user, "held"), 0, "the customer chose to send the rest");
		assert.equal(await count(user, "queued"), 2800);
		assert.equal((await campaignOf(user)).status, "sending");
		await skipPublished();
	});

	test("a slice over the pause level only holds the rest, with a warning, until its owner resumes", async () => {
		const user = await setup("warm-list@example.com", { neverMailed: 3000 });
		await as(user, () => m.campaigns.sendCampaign(user.campaignId, {}));
		await runJobs();
		await bounceSlice(user, 6);

		const emailsBefore = platformEmails.length;
		const [check] = await runJobs({ checks: true });
		assert.deepEqual([check.result.paused, check.result.blocked], [true, undefined]);
		const paused = await campaignOf(user);
		assert.equal(paused.pauseCode, "first_send_slice");
		assert.match(paused.pauseReason, /^The first 200 new contacts had a bounce rate of 3.00% \(limit 2.00%\)\. The rest of the new contacts wait: clean the list/);
		assert.equal((await m.db.getOne("SELECT status FROM accounts WHERE _id = ?", [user.accountId])).status, "active", "6 bounces don't block");
		const emails = platformEmails.slice(emailsBefore);
		assert.deepEqual(emails.map(({ to, subject }) => [to, subject]), [[["warm-list@example.com"], "[MailCheap] Campaign paused"]]);
		assert.equal(await count(user, "held"), 2800);

		assert.deepEqual(await as(user, () => m.campaigns.resumeCampaign(user.campaignId)), { ok: true });
		const resumed = await campaignOf(user);
		assert.equal(resumed.status, "sending");
		assert.ok(resumed.ratesAcceptedAt instanceof Date, "the owner took the rates as they are");
		assert.equal(await count(user, "held"), 0);
		await skipPublished();
	});

	test("a check while the slice is still going out waits a few more minutes", async () => {
		const user = await setup("slow-slice@example.com", { neverMailed: 1000 });
		await as(user, () => m.campaigns.sendCampaign(user.campaignId, {}));
		const check = (await readJobs()).find(({ _id, kind }) => !handled.has(_id) && kind === "check-first-send");
		await skipPublished();
		const result = await m.sending.checkFirstSend(check.payload);
		assert.equal(result.waiting, true);
		assert.equal(result.queued, 200);
		assert.equal((await readJobs()).at(-1).kind, "check-first-send", "checks again later");
		assert.equal(await count(user, "held"), 800);
		await skipPublished();
	});

	test("lists without new contacts, or small ones, go at once", async () => {
		const user = await setup("small-list@example.com", { neverMailed: 150, mailed: 50 });
		await as(user, () => m.campaigns.sendCampaign(user.campaignId, {}));
		assert.equal(await count(user, "held"), 0);
		assert.equal((await campaignOf(user)).firstSend?.slice, undefined);
		await runJobs();
		assert.equal((await campaignOf(user)).status, "sent");
	});
});
