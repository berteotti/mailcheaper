import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SEND_SPREAD, describeSpreadHours, getBatchStarts, getSpreadEnd, getSpreadHours, getSpreadMs, getWarmup } from "../lib/send-spread.js";
import { activate, as, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";

const HOUR_MS = 3_600_000;
const SPREAD_MS = SEND_SPREAD.hours * HOUR_MS;
const CLOUD = { MAILCHEAP_CLOUD: "true" };

test("spread sends: MailCheap Cloud only, from the first campaign until 30 days later or an admin ends them", () => {
	const now = new Date("2026-10-13T12:00:00Z");
	assert.equal(getSpreadMs({}, now, CLOUD), SPREAD_MS, "a new account, before its first campaign");
	assert.equal(getSpreadMs({ spreadUntil: new Date("2026-11-01T00:00:00Z") }, now, CLOUD), SPREAD_MS);
	assert.equal(getSpreadMs({ spreadUntil: "2026-11-01T00:00:00.000Z" }, now, CLOUD), SPREAD_MS, "serialized dates too");
	assert.equal(getSpreadMs({ spreadUntil: now }, now, CLOUD), 0, "over");
	assert.equal(getSpreadMs({}, now, { MAILCHEAP_CLOUD: "" }), 0, "self-hosted servers send at full speed");
	assert.equal(getSpreadEnd(now).toISOString(), "2026-11-12T12:00:00.000Z");
});

test("the first campaign goes out over 24 hours, the next two over 16 and 12, the others over 8", () => {
	assert.deepEqual([0, 1, 2, 3, 12].map(getSpreadHours), [24, 16, 12, 8, 8]);
	assert.equal(describeSpreadHours(), "the first over 24 hours, the next two over 16 and 12, then each over 8");
});

test("the warm-up shows the day and progress of the first 30 days, its next campaign's hours, and nothing once it's over", () => {
	const now = new Date("2026-10-13T12:00:00Z");
	assert.deepEqual(
		getWarmup({}, { now, env: CLOUD }),
		{ days: 30, hours: 8, firstHours: [24, 16, 12], nextHours: 24, hasStarted: false, day: 0, progress: 0, endsAt: null },
		"before the first campaign"
	);
	const started = getWarmup({ spreadUntil: getSpreadEnd(new Date("2026-10-11T00:00:00Z")) }, { place: 1, now, env: CLOUD });
	assert.equal(started.hasStarted, true);
	assert.equal(started.nextHours, 16, "one campaign out so far");
	assert.equal(started.day, 3, "two and a half days in");
	assert.equal(started.endsAt, "2026-11-10T00:00:00.000Z");
	assert.ok(Math.abs(started.progress - 2.5 / 30) < 1e-9);
	assert.equal(getWarmup({ spreadUntil: getSpreadEnd(now) }, { now, env: CLOUD }).day, 1, "the first campaign was just now");
	assert.equal(getWarmup({ spreadUntil: now }, { now, env: CLOUD }), null, "over, or ended by an admin");
	assert.equal(getWarmup({}, { now, env: { MAILCHEAP_CLOUD: "" } }), null, "no warm-up on a self-hosted server");
});

test("batches start evenly over the spread, the first right away", () => {
	const now = Date.parse("2026-10-13T12:00:00Z");
	const seconds = (hours) => (now + hours * HOUR_MS) / 1000;
	assert.deepEqual(getBatchStarts(4, SPREAD_MS, now), [null, seconds(2), seconds(4), seconds(6)]);
	assert.deepEqual(getBatchStarts(1, SPREAD_MS, now), [null], "one batch goes at once");
	assert.deepEqual(getBatchStarts(3, 0, now), [null, null, null], "no spread, back to back");
	assert.deepEqual(getBatchStarts(0, SPREAD_MS, now), []);
});

describe("a new account's campaigns go out over hours", () => {
	let app;
	let m;

	async function setup(email, contacts, { isMailed = false } = {}) {
		const user = await signIn(email);
		await activate(user, { limitOverrides: { emailsPerMonth: 100_000, subscribers: 100_000 } });
		await m.db.execute("UPDATE accounts SET spreadUntil = NULL WHERE _id = ?", [user.accountId]);
		const slug = email.split("@")[0];
		const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St" }))));
		user.newsletterId = url.split("/").at(-1);
		const db = await m.db.connectDb();
		await db.batch(
			Array.from({ length: contacts }, (_, index) =>
				m.records.insertStatement(db, "contacts", {
					accountId: user.accountId,
					newsletterId: user.newsletterId,
					email: `reader${index}@${slug}.example.org`,
					status: "active",
					subscribedAt: new Date(),
					...(isMailed && { lastSentAt: new Date(Date.now() - 86_400_000) }),
				})
			)
		);
		return user;
	}

	async function draft(user) {
		const draftUrl = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
		const campaignId = draftUrl.split("/").at(-1);
		await as(user, () => m.campaigns.saveCampaign(campaignId, { subject: "Issue", previewText: "Hi", body: "<p>Hello</p>" }));
		return campaignId;
	}

	// The outbox's jobs after a point, in the order they were written.
	const lastJob = async () => (await m.db.getValue("SELECT max(rowid) FROM job_outbox")) ?? 0;
	async function jobsSince(from) {
		const rows = await m.db.getAll("SELECT kind, payload, availableAt FROM job_outbox WHERE rowid > ? ORDER BY rowid", [from]);
		const jobs = rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
		return { batches: jobs.filter(({ kind }) => kind === "send"), checks: jobs.filter(({ kind }) => kind === "check-first-send") };
	}

	// What one send wrote to the outbox, in order.
	async function send(user, campaignId) {
		const from = await lastJob();
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(campaignId, {})), { ok: true });
		return jobsSince(from);
	}

	// As the queue consumer runs them (one at a time: the in-memory D1 has one connection).
	async function runBatches(batches) {
		for (const batch of batches) await m.sending.runSendJob(batch.payload);
	}

	// Each batch's start, in hours from the send.
	function startHours(batches, start) {
		return batches.map(({ availableAt }) => Math.max(0, Math.round(((availableAt.getTime() - start) / HOUR_MS) * 100) / 100));
	}

	const campaignOf = (user, campaignId) => m.db.getOne("SELECT * FROM campaigns WHERE accountId = ? AND _id = ?", [user.accountId, campaignId]);
	const countHeld = (user, campaignId) =>
		m.db.getValue("SELECT count(*) FROM messages WHERE accountId = ? AND campaignId = ? AND status = 'held'", [user.accountId, campaignId]);
	const findAccountRow = (user) => m.db.getOne("SELECT * FROM accounts WHERE _id = ?", [user.accountId]);

	before(async () => {
		app = await startTestApp({ SEND_RATE_PER_SECOND: "1000" });
		m = {
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			campaigns: await import("../app/(app)/campaigns/actions.js"),
			sending: await import("../lib/sending.js"),
			accounts: await import("../lib/accounts.js"),
			db: await import("../lib/db.js"),
			records: await import("../lib/records.js"),
		};
	});

	after(() => app?.stop());

	test("the first one goes over 24 hours: a slice of the new contacts, a check 3 hours after it, then the rest", async () => {
		const user = await setup("first-month@example.com", 450);
		const campaignId = await draft(user);
		const start = Date.now();
		const { batches, checks } = await send(user, campaignId);

		// 200 of 450 go first, over their share of the 24 hours: 24 × 200 / 450 ≈ 10.67 hours, 4 batches of 50.
		assert.deepEqual(startHours(batches, start), [0, 2.67, 5.33, 8]);
		assert.equal(await countHeld(user, campaignId), 250);
		assert.equal(checks.length, 1);
		assert.ok(Math.abs(checks[0].availableAt.getTime() - (start + (10.67 + 3) * HOUR_MS)) < 120_000, "3 hours after the slice's share");

		const account = await findAccountRow(user);
		assert.ok(Math.abs(account.spreadUntil.getTime() - getSpreadEnd(new Date(start)).getTime()) < 60_000, "30 days from the first campaign");
		const sending = await campaignOf(user, campaignId);
		assert.equal(sending.spreadHours, 24);
		assert.deepEqual({ slice: sending.firstSend.slice, held: sending.firstSend.held }, { slice: 200, held: 250 });
		assert.ok(Math.abs(sending.sendingUntil.getTime() - (start + 27 * HOUR_MS)) < 60_000, "24 hours, and the 3-hour check");

		await runBatches(batches);
		assert.equal((await campaignOf(user, campaignId)).status, "sending", "not sent while contacts are held");

		const from = await lastJob();
		const checkedAt = Date.now();
		const check = await m.sending.checkFirstSend(checks[0].payload);
		assert.equal(check.released, 250);
		// The rest over its own share: 24 × 250 / 450 ≈ 13.33 hours, 5 batches of 50.
		const rest = (await jobsSince(from)).batches;
		assert.deepEqual(startHours(rest, checkedAt), [0, 2.67, 5.33, 8, 10.67]);
		assert.equal(rest.reduce((sum, { payload }) => sum + payload.messageIds.length, 0), 250, "only the held contacts");
		assert.ok(Math.abs((await campaignOf(user, campaignId)).sendingUntil.getTime() - (checkedAt + 13.33 * HOUR_MS)) < 120_000);

		await runBatches(rest);
		const sent = await campaignOf(user, campaignId);
		assert.equal(sent.status, "sent");
		assert.equal(sent.stats.sent, 450);
		assert.equal(sent.sendingUntil, null, "cleared once sent");
	});

	test("the next ones go over 16, 12, then 8 hours, without a check when nobody is new", async () => {
		const user = await setup("next-sends@example.com", 300, { isMailed: true });
		for (const hours of [24, 16, 12, 8, 8]) {
			const campaignId = await draft(user);
			const start = Date.now();
			const { batches, checks } = await send(user, campaignId);
			assert.equal(checks.length, 0);
			const sending = await campaignOf(user, campaignId);
			assert.equal(sending.spreadHours, hours);
			assert.deepEqual(startHours(batches, start), [0, 1, 2, 3, 4, 5].map((step) => Math.round(((step * hours) / 6) * 100) / 100));
			assert.ok(Math.abs(sending.sendingUntil.getTime() - (start + hours * HOUR_MS)) < 60_000);
		}
	});

	test("ended early by an admin, sends go at full speed with the first-send slice; started again, they spread", async () => {
		const user = await setup("trusted@example.com", 450);
		assert.equal(await m.accounts.setSendSpread(user.accountId, false), true);
		const fullSpeed = await send(user, await draft(user));
		assert.ok(fullSpeed.batches.every(({ availableAt }) => availableAt.getTime() <= Date.now()), "back to back");
		assert.equal(fullSpeed.checks.length, 1, "new contacts go in steps");
		assert.equal((await findAccountRow(user)).spreadUntil <= new Date(), true);

		assert.equal(await m.accounts.setSendSpread(user.accountId, true), true);
		const spread = await send(user, await draft(user));
		assert.ok(spread.batches.slice(1).every(({ availableAt }) => availableAt.getTime() > Date.now()), "spread again");
		const { spreadUntil } = await findAccountRow(user);
		assert.ok(spreadUntil.getTime() > Date.now() + 29 * 24 * HOUR_MS, "for another 30 days");
	});
});
