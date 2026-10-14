import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { getEventPlan } from "../lib/email-event-rules.js";
import { normalizePostshibaEvent, verifyPostshibaSignature } from "../lib/email-provider/postshiba-events.js";
import { execute, getOne, getValue, json } from "../lib/db.js";
import { completeJob, readJob } from "../lib/jobs.js";
import { insertRow } from "../lib/records.js";
import { activate, signIn, startTestApp } from "./helpers/app.mjs";
import { POSTSHIBA, POSTSHIBA_ENV } from "./helpers/postshiba.mjs";

const SECRET = POSTSHIBA.webhookSecret;
const ACCOUNT_ID = "64f1a2b3c4d5e6f7a8b9c0d1";
const MESSAGE_ID = "74f1a2b3c4d5e6f7a8b9c0d2";

function sign(body, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
	return { timestamp: String(timestamp), signature: `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}` };
}

function postshibaEvent(event, fields = {}) {
	return {
		event,
		email: "Reader@Example.org",
		timestamp: 1_790_000_000,
		sg_event_id: `capsule-${crypto.randomUUID()}`,
		sg_message_id: "abc@postshiba.test",
		"smtp-id": "<abc@postshiba.test>",
		tenant_id: `mc-${ACCOUNT_ID}`,
		account_id: ACCOUNT_ID,
		message_id: MESSAGE_ID,
		unique_args: { account_id: ACCOUNT_ID, message_id: MESSAGE_ID, kind: "campaign" },
		...fields,
	};
}

test("a signature is sha256= and the hex HMAC of the timestamp and the exact body, at most 5 minutes old", () => {
	const body = JSON.stringify([postshibaEvent("delivered")]);
	const now = Date.now();
	const { timestamp, signature } = sign(body);
	assert.equal(verifyPostshibaSignature({ body, timestamp, signature, secret: SECRET, now }), true);
	assert.equal(verifyPostshibaSignature({ body: Buffer.from(body), timestamp, signature, secret: SECRET, now }), true, "raw bytes too");

	assert.equal(verifyPostshibaSignature({ body, timestamp, signature, secret: "another-secret", now }), false, "bad secret");
	assert.equal(verifyPostshibaSignature({ body: body.replace("delivered", "bounce"), timestamp, signature, secret: SECRET, now }), false, "changed body");
	assert.equal(verifyPostshibaSignature({ body, timestamp, signature: signature.slice(7), secret: SECRET, now }), false, "no prefix");
	assert.equal(verifyPostshibaSignature({ body, timestamp, signature: "sha256=not-hex", secret: SECRET, now }), false);
	assert.equal(verifyPostshibaSignature({ body, timestamp: String(Number(timestamp) + 1), signature, secret: SECRET, now }), false, "the timestamp is signed");
	assert.equal(verifyPostshibaSignature({ body, timestamp, signature, secret: "", now }), false, "no secret, no trust");
	assert.equal(verifyPostshibaSignature({ body, timestamp: null, signature, secret: SECRET, now }), false);

	const stale = sign(body, { timestamp: Math.floor(now / 1000) - 301 });
	assert.equal(verifyPostshibaSignature({ body, ...stale, secret: SECRET, now }), false, "stale");
	const future = sign(body, { timestamp: Math.floor(now / 1000) + 301 });
	assert.equal(verifyPostshibaSignature({ body, ...future, secret: SECRET, now }), false, "from the future");
	const recent = sign(body, { timestamp: Math.floor(now / 1000) - 299 });
	assert.equal(verifyPostshibaSignature({ body, ...recent, secret: SECRET, now }), true);
});

test("PostShiba's events take the one event shape, with the account and message from unique args", () => {
	const delivered = normalizePostshibaEvent(postshibaEvent("delivered", { response: "250 2.0.0 OK" }));
	assert.equal(delivered.type, "delivered");
	assert.equal(delivered.accountId, ACCOUNT_ID);
	assert.equal(delivered.messageId, MESSAGE_ID);
	assert.equal(delivered.providerMessageId, "abc@postshiba.test");
	assert.match(delivered.providerEventId, /^capsule-/);
	assert.equal(delivered.tenant, `mc-${ACCOUNT_ID}`);
	assert.equal(delivered.email, "reader@example.org");
	assert.deepEqual(delivered.occurredAt, new Date(1_790_000_000_000));
	assert.deepEqual(getEventPlan(delivered).status, { to: "delivered", from: ["queued", "sent", "failed"] });

	const hard = getEventPlan(normalizePostshibaEvent(postshibaEvent("bounce", { type: "bounce", status: "5.1.1", reason: "550 5.1.1 user unknown", bounce_classification: "Invalid Address" })));
	assert.equal(hard.error, "Hard bounce: Invalid Address, 550 5.1.1 user unknown");
	assert.deepEqual(hard.suppression, {
		emails: ["reader@example.org"],
		reason: "bounce",
		detail: "bounce/5.1.1",
		contactStatus: "bounced",
		contactStatusFrom: ["active", "dormant", "unsubscribed"],
	});
	const blocked = getEventPlan(normalizePostshibaEvent(postshibaEvent("bounce", { type: "blocked", reason: "550 5.7.1 reputation" })));
	assert.deepEqual([blocked.suppression, blocked.error], [null, "Soft bounce: 550 5.7.1 reputation"]);
	assert.equal(getEventPlan(normalizePostshibaEvent(postshibaEvent("bounce", { type: "bounce", reason: "expired" }))).suppression, null, "expired isn't the address");
	assert.equal(getEventPlan(normalizePostshibaEvent(postshibaEvent("bounce", {}))).suppression, null, "no type: PostShiba suppresses it if it was hard");

	const complaint = getEventPlan(normalizePostshibaEvent(postshibaEvent("spamreport", { attribution: "verified" })));
	assert.deepEqual([complaint.suppression.reason, complaint.suppression.detail, complaint.status.to], ["complaint", "spamreport (verified)", "complained"]);
	assert.equal(getEventPlan(normalizePostshibaEvent(postshibaEvent("unsubscribe"))).unsubscribe, true);

	const dropped = getEventPlan(normalizePostshibaEvent(postshibaEvent("dropped", { reason: "Bounced Address" })));
	assert.equal(dropped.error, "Dropped by PostShiba: Bounced Address");
	assert.equal(dropped.suppression.reason, "provider");
	assert.equal(getEventPlan(normalizePostshibaEvent(postshibaEvent("dropped", { reason: "Invalid" }))).suppression, null);
	const deferred = getEventPlan(normalizePostshibaEvent(postshibaEvent("deferred", { reason: "421 try later", attempt: "2" })));
	assert.deepEqual([deferred.status, deferred.isRecorded], [null, true]);
	assert.equal(normalizePostshibaEvent(postshibaEvent("processed")).type, "sent");

	for (const value of [null, [], "bounce", { event: "open" }, { event: "click" }, { event: "constructor" }, { event: "__proto__" }]) {
		assert.equal(normalizePostshibaEvent(value), null, JSON.stringify(value));
	}
	const spoofed = normalizePostshibaEvent(postshibaEvent("delivered", { unique_args: { account_id: { $ne: null }, message_id: "../x" }, account_id: undefined, message_id: undefined }));
	assert.deepEqual([spoofed.accountId, spoofed.messageId], [null, null]);
});

describe("the PostShiba webhook", () => {
	let app;
	let m;
	let alice;
	let bob;

	async function customer(email, slug) {
		const user = await signIn(email);
		await activate(user);
		// The newsletter as saving one stores it: these tests are about events, not newsletters.
		const newsletter = await insertRow("newsletters", { accountId: user.accountId, name: slug, slug, fromEmail: `hello@${slug}.example.com`, postalAddress: "1 Main St" });
		user.newsletterId = newsletter._id;
		user.tenantSlug = `mc-${user.accountId}`;
		await execute("UPDATE accounts SET postshiba = ? WHERE _id = ?", [
			json({ tenantId: `Tn-${slug}`, tenantSlug: user.tenantSlug, tenantStatus: "active" }),
			user.accountId,
		]);
		return user;
	}

	function createContact(user, email) {
		return insertRow("contacts", { accountId: user.accountId, newsletterId: user.newsletterId, email, status: "active", subscribedAt: new Date() });
	}

	const findMessage = (user, id) => getOne("SELECT * FROM messages WHERE accountId = ? AND _id = ?", [user.accountId, id]);
	const findContact = (user, id) => getOne("SELECT * FROM contacts WHERE accountId = ? AND _id = ?", [user.accountId, id]);
	const countRows = async (table, where, params) => getValue(`SELECT count(*) FROM ${table} WHERE ${where}`, params);

	// What the jobs Worker does with the events the webhook stored.
	async function runEventJobs() {
		const rows = await m.db.getAll("SELECT _id FROM job_outbox WHERE kind = 'postshiba-event' AND completedAt IS NULL ORDER BY createdAt, rowid");
		for (const { _id } of rows) {
			await m.webhook.handlePostshibaEvent((await readJob(_id)).payload);
			await completeJob(_id);
		}
		return rows.length;
	}

	async function sentMessage(user, email, fields = {}) {
		const contact = await createContact(user, email);
		const campaign = await insertRow("campaigns", { accountId: user.accountId, newsletterId: user.newsletterId, subject: "Issue", status: "sent", startedAt: new Date() });
		const campaignId = campaign._id;
		const message = await insertRow("messages", {
			kind: "campaign",
			accountId: user.accountId,
			newsletterId: user.newsletterId,
			campaignId,
			contactId: contact._id,
			email,
			status: "sent",
			sentAt: new Date(),
			...fields,
		});
		return { message, contact, campaignId };
	}

	function eventFor(user, message, event, fields = {}) {
		const args = message ? { account_id: String(user.accountId), message_id: String(message._id), kind: "campaign" } : {};
		return {
			event,
			email: message?.email ?? fields.email,
			timestamp: Math.floor(Date.now() / 1000),
			sg_event_id: `capsule-${crypto.randomUUID()}`,
			sg_message_id: `${crypto.randomUUID()}@postshiba.test`,
			tenant_id: user.tenantSlug,
			...args,
			unique_args: args,
			...fields,
		};
	}

	async function post(events, options) {
		const response = await postOnly(events, options);
		await runEventJobs();
		return response;
	}

	function postOnly(events, { secret = SECRET, timestamp, body = JSON.stringify(events), headers } = {}) {
		const signed = sign(body, { secret, ...(timestamp && { timestamp }) });
		return m.route.POST(
			new Request("http://localhost:3000/api/webhooks/postshiba", {
				method: "POST",
				headers: headers ?? { "content-type": "application/json", "x-capsule-timestamp": signed.timestamp, "x-capsule-signature": signed.signature },
				body,
			})
		);
	}

	before(async () => {
		app = await startTestApp(POSTSHIBA_ENV);
		m = {
			route: await import("../app/api/webhooks/postshiba/route.js"),
			webhook: await import("../lib/postshiba-webhook.js"),
			db: await import("../lib/db.js"),
		};
		alice = await customer("alice-ps@example.com", "alice-ps");
		bob = await customer("bob-ps@example.com", "bob-ps");
	});

	after(() => app?.stop());

	test("only signed, fresh requests are read", async () => {
		const { message } = await sentMessage(alice, "signed@example.org");
		const events = [eventFor(alice, message, "delivered")];
		assert.equal((await post(events, { secret: "forged" })).status, 401);
		assert.equal((await post(events, { timestamp: Math.floor(Date.now() / 1000) - 600 })).status, 401, "stale");
		assert.equal((await post(events, { headers: { "content-type": "application/json" } })).status, 401, "unsigned");
		assert.equal((await findMessage(alice, message._id)).status, "sent", "nothing changed");
		assert.equal((await post({ event: "delivered" })).status, 400, "an array of events");

		const response = await postOnly(events);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true, queued: 1 });
		assert.equal((await findMessage(alice, message._id)).status, "sent", "stored first, applied by the jobs Worker");
		assert.equal(await runEventJobs(), 1);
		const delivered = await findMessage(alice, message._id);
		assert.equal(delivered.status, "delivered");
		assert.equal(delivered.providerMessageId, events[0].sg_message_id, "matched from then on by PostShiba's id");

		const secret = process.env.POSTSHIBA_WEBHOOK_SECRET;
		delete process.env.POSTSHIBA_WEBHOOK_SECRET;
		try {
			assert.equal((await post(events)).status, 503);
		} finally {
			process.env.POSTSHIBA_WEBHOOK_SECRET = secret;
		}
	});

	test("a hard bounce lands in its account only: message, contact, suppression and the account check", async () => {
		const { message, contact } = await sentMessage(alice, "shared-reader@example.org");
		const bobContact = await createContact(bob, "shared-reader@example.org");
		const bounce = eventFor(alice, message, "bounce", { type: "bounce", status: "5.1.1", reason: "550 5.1.1 unknown user" });
		assert.equal((await post([bounce])).status, 200);
		assert.equal((await post([bounce])).status, 200, "redelivered");
		assert.equal(await countRows("job_outbox", "_id = ?", [`postshiba-event:${bounce.sg_event_id}`]), 1, "one job for the event");
		await m.webhook.handlePostshibaEvent(bounce);

		assert.equal((await findMessage(alice, message._id)).status, "bounced");
		assert.equal((await findContact(alice, contact._id)).status, "bounced");
		assert.equal(await countRows("suppressions", "accountId = ? AND email = ? AND reason = 'bounce'", [alice.accountId, "shared-reader@example.org"]), 1);
		assert.equal(await countRows("events", "accountId = ? AND providerEventId = ?", [alice.accountId, bounce.sg_event_id]), 1, "recorded once");
		assert.ok((await getOne("SELECT health FROM accounts WHERE _id = ?", [alice.accountId])).health.checkedAt, "the 7-day check ran");

		assert.equal((await findContact(bob, bobContact._id)).status, "active", "Bob's contact with the same address stays");
		assert.equal(await countRows("suppressions", "accountId = ?", [bob.accountId]), 0);
		assert.equal(await countRows("events", "accountId = ?", [bob.accountId]), 0);
	});

	test("an event whose tenant isn't the account its unique args name is ignored", async () => {
		const { message } = await sentMessage(alice, "spoof@example.org");
		const spoofed = eventFor(alice, message, "bounce", { type: "bounce", tenant_id: bob.tenantSlug });
		assert.equal((await post([spoofed])).status, 200);
		assert.equal((await findMessage(alice, message._id)).status, "sent");
		assert.equal(await countRows("suppressions", "email = ?", ["spoof@example.org"]), 0, "in no account");

		const { message: bobMessage } = await sentMessage(bob, "bob-only@example.org");
		const crossed = eventFor(alice, bobMessage, "spamreport");
		assert.equal((await post([crossed])).status, 200);
		assert.equal((await findMessage(bob, bobMessage._id)).status, "sent", "Bob's message isn't in Alice's account");
		assert.equal(await countRows("suppressions", "accountId = ?", [bob.accountId]), 0);
	});

	test("without unique args the tenant names the account, and suppressions still apply there", async () => {
		await createContact(bob, "no-args@example.org");
		const aliceContact = await createContact(alice, "no-args@example.org");
		const spam = eventFor(bob, null, "spamreport", { email: "no-args@example.org" });
		assert.equal((await post([spam])).status, 200);
		assert.equal(await countRows("suppressions", "accountId = ? AND email = ? AND reason = 'complaint'", [bob.accountId, "no-args@example.org"]), 1);
		assert.equal((await getOne("SELECT status FROM contacts WHERE accountId = ? AND email = ?", [bob.accountId, "no-args@example.org"])).status, "complained");
		assert.equal((await findContact(alice, aliceContact._id)).status, "active");

		assert.equal((await post([eventFor({ tenantSlug: "mc-000000000000000000000000" }, null, "bounce", { email: "x@example.org", type: "bounce" })])).status, 200);
		assert.equal((await post([{ event: "delivered", email: "test@example.com", timestamp: 1, test: true }])).status, 200, "PostShiba's test event");
	});

	test("PostShiba's own unsubscribe link unsubscribes the address across the account, and a drop of a suppressed address suppresses it", async () => {
		const { message, contact, campaignId } = await sentMessage(alice, "leaving@example.org");
		assert.equal((await post([eventFor(alice, message, "unsubscribe")])).status, 200);
		const left = await findContact(alice, contact._id);
		assert.equal(left.status, "unsubscribed");
		assert.ok(left.unsubscribedAt);
		const campaign = () => getOne("SELECT stats FROM campaigns WHERE accountId = ? AND _id = ?", [alice.accountId, campaignId]);
		assert.equal((await campaign()).stats.unsubscribed, 1);
		await m.webhook.handlePostshibaEvent(eventFor(alice, message, "unsubscribe"));
		assert.equal((await campaign()).stats.unsubscribed, 1, "counted once");

		const { message: dropped } = await sentMessage(alice, "dropped@example.org");
		assert.equal((await post([eventFor(alice, dropped, "dropped", { reason: "Bounced Address" })])).status, 200);
		const failed = await findMessage(alice, dropped._id);
		assert.deepEqual([failed.status, failed.error], ["failed", "Dropped by PostShiba: Bounced Address"]);
		assert.equal((await getOne("SELECT reason FROM suppressions WHERE accountId = ? AND email = ?", [alice.accountId, "dropped@example.org"])).reason, "provider");
	});
});
