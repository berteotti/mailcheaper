import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { execute, getAll, getOne, getValue, newId } from "../lib/db.js";
import { completeJob, readJob } from "../lib/jobs.js";
import { insertRow } from "../lib/records.js";
import { getAccountRateProblem } from "../lib/sending-rules.js";
import { getSesEventPlan } from "../lib/ses-event-mapping.js";
import { buildSigningString } from "../lib/sns.js";
import { getTenantEventPlan, getTenantName } from "../lib/tenant-event-rules.js";
import { activate, as, findAccount, jsonRequest, platformEmails, signIn, startTestApp } from "./helpers/app.mjs";
import { state } from "./stubs/ses.mjs";

const TENANT_ARN = (name) => `arn:aws:ses:us-east-1:111122223333:tenant/${name}/tn-0123`;

function tenantEvent(type, name, detail = {}) {
	return { source: "aws.ses", "detail-type": type, time: "2026-10-12T08:00:00Z", resources: [TENANT_ARN(name)], detail };
}

test("tenant events name their tenant in the resources", () => {
	assert.equal(getTenantName({ resources: ["arn:aws:ses:us-east-1:111122223333:configuration-set/x", TENANT_ARN("mc-abc")] }), "mc-abc");
	assert.equal(getTenantName({ resources: ["arn:aws:ses:us-east-1:111122223333:tenant/../x"] }), null);
	assert.equal(getTenantName({}), null);
});

test("disabled sending and high-impact findings pause; the rest is recorded", () => {
	const disabled = getTenantEventPlan(tenantEvent("Sending Status Disabled", "mc-a", { data: { record: { status: "DISABLED", cause: "Bounce rate over 15%" } } }));
	assert.deepEqual({ status: disabled.status, pause: disabled.pause }, { status: "DISABLED", pause: "SES paused sending: Bounce rate over 15%" });
	assert.equal(getTenantEventPlan(tenantEvent("Sending Status Enabled", "mc-a")).pause, undefined);

	const high = getTenantEventPlan(tenantEvent("Advisor Recommendation Status Open", "mc-a", { metadata: { impact: "HIGH", type: "BOUNCE" } }));
	assert.equal(high.pause, "SES finding: BOUNCE (high impact)");
	const low = getTenantEventPlan(tenantEvent("Advisor Recommendation Status Open", "mc-a", { metadata: { impact: "LOW", type: "DMARC" } }));
	assert.deepEqual({ finding: low.finding, pause: low.pause }, { finding: "DMARC (low impact)", pause: undefined });
	assert.equal(getTenantEventPlan(tenantEvent("Advisor Recommendation Status Closed", "mc-a")).finding, null);

	assert.equal(getTenantEventPlan({ ...tenantEvent("Sending Status Disabled", "mc-a"), source: "aws.s3" }), null);
	assert.equal(getTenantEventPlan(tenantEvent("Something else", "mc-a")), null);
});

test("the 7-day check holds a send's levels over the account's last 7 days", () => {
	const level = (counts) => getAccountRateProblem(counts)?.level ?? null;
	assert.equal(level({ sent: 1000, delivered: 980, bounced: 20, complained: 1 }), null, "exactly 2%, and one complaint");
	assert.equal(level({ sent: 1000, delivered: 970, bounced: 21 }), "pause");
	assert.equal(level({ sent: 200, delivered: 200, complained: 2 }), "pause", "2 complaints warn, they don't block");
	assert.equal(getAccountRateProblem({ sent: 200, complained: 3 }).reason, "Complaint rate of 1.50% over the last 7 days (limit 0.30%)");
	assert.equal(level({ sent: 5000, delivered: 4900, complained: 3 }), null, "3 in 5,000 is under both");
});

test("SES events carry their account in a tag", () => {
	const id = "64f1a2b3c4d5e6f7a8b9c0d1";
	const plan = getSesEventPlan({ eventType: "Delivery", mail: { messageId: "x", tags: { account_id: [id.toUpperCase()], message_id: [id] } } });
	assert.equal(plan.accountId, id);
	assert.equal(getSesEventPlan({ eventType: "Delivery", mail: { tags: { account_id: ["{}"] } } }).accountId, null);
});

describe("per-account events", () => {
	let app;
	let m;
	let alice;
	let bob;
	const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
	const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem";
	const TOPIC = "arn:aws:sns:us-east-1:111122223333:mailcheap-ses-tenants";

	function signed(message) {
		const unsigned = { SigningCertURL: CERT_URL, SignatureVersion: "2", ...message };
		return { ...unsigned, Signature: crypto.createSign("RSA-SHA256").update(buildSigningString(unsigned)).sign(privateKey, "base64") };
	}

	function snsNotification(event, overrides = {}) {
		return signed({
			Type: "Notification",
			MessageId: crypto.randomUUID(),
			TopicArn: TOPIC,
			Message: JSON.stringify(event),
			Timestamp: new Date().toISOString(),
			...overrides,
		});
	}

	async function customer(email, slug) {
		const user = await signIn(email);
		await activate(user);
		// The newsletter as saving one stores it: these tests are about events, not newsletters.
		const newsletter = await insertRow("newsletters", { accountId: user.accountId, name: slug, slug, fromEmail: `hello@${slug}.example.com`, postalAddress: "1 Main St" });
		user.newsletterId = newsletter._id;
		await m.tenants.provisionTenant(user.accountId);
		return user;
	}

	function bounce({ user, message, email = message.email }) {
		return m.events.handleSesEvent({
			eventType: "Bounce",
			mail: { messageId: message.providerMessageId, destination: [email], tags: { account_id: [String(user.accountId)], message_id: [String(message._id)] } },
			bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: email }] },
		});
	}

	// Sent and delivered messages of one campaign, each to a contact of its own.
	async function sentMessages(user, count, fields = () => ({})) {
		const now = Date.now();
		const campaign = await insertRow("campaigns", { accountId: user.accountId, newsletterId: user.newsletterId, subject: "Issue", status: "sent" });
		const { sqlite } = app.db;
		const insertContact = sqlite.prepare("INSERT INTO contacts (_id, accountId, newsletterId, email, subscribedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)");
		const insertMessage = sqlite.prepare(`INSERT INTO messages (_id, accountId, kind, campaignId, newsletterId, contactId, email, status,
			providerMessageId, sentAt, deliveredAt, bouncedAt, createdAt, updatedAt) VALUES (?, ?, 'campaign', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		const messages = Array.from({ length: count }, (_, index) => {
			const message = {
				_id: newId(),
				accountId: user.accountId,
				campaignId: campaign._id,
				contactId: newId(),
				email: `r${index}@${user.newsletterId}.example.org`,
				status: "delivered",
				providerMessageId: `ses-${user.accountId}-${index}-${now}`,
				sentAt: now - 3_600_000,
				deliveredAt: now - 3_500_000,
				bouncedAt: null,
				...fields(index),
			};
			insertContact.run(message.contactId, user.accountId, user.newsletterId, message.email, now, now, now);
			insertMessage.run(message._id, user.accountId, campaign._id, user.newsletterId, message.contactId, message.email, message.status,
				message.providerMessageId, message.sentAt, message.deliveredAt, message.bouncedAt, now, now);
			return message;
		});
		return messages;
	}

	// What the jobs Worker does with the tenant events the webhook stored.
	async function runTenantJobs() {
		for (const { _id } of await getAll("SELECT _id FROM job_outbox WHERE kind = 'ses-tenant-event' AND completedAt IS NULL ORDER BY createdAt, rowid")) {
			await m.tenantEvents.handleTenantEvent((await readJob(_id)).payload);
			await completeJob(_id);
		}
	}

	async function postTenantEvent(body) {
		const response = await m.tenantRoute.POST(jsonRequest("/api/webhooks/ses-tenants", { method: "POST", body }));
		await runTenantJobs();
		return response;
	}

	before(async () => {
		app = await startTestApp({ SES_TENANT_SNS_TOPIC_ARN: TOPIC });
		m = {
			admin: await import("../app/admin/actions.js"),
			events: await import("../lib/ses-events.js"),
			tenants: await import("../lib/tenants.js"),
			tenantEvents: await import("../lib/tenant-events.js"),
			tenantRoute: await import("../app/api/webhooks/ses-tenants/route.js"),
		};
		const fetch = globalThis.fetch;
		globalThis.fetch = async (input, init) =>
			String(input) === CERT_URL ? new Response(publicKey.export({ type: "spki", format: "pem" })) : fetch(input, init);
		alice = await customer("alice-events@example.com", "alice-events");
		bob = await customer("bob-events@example.com", "bob-events");
	});

	after(() => app?.stop());

	test("a bounce is recorded in the account its tag names, and suppressed there only", async () => {
		const [message] = await sentMessages(alice, 1);
		const spoofed = await m.events.handleSesEvent({
			eventType: "Bounce",
			mail: { messageId: message.providerMessageId, destination: [message.email], tags: { account_id: [String(bob.accountId)], message_id: [String(message._id)] } },
			bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: message.email }] },
		});
		assert.deepEqual(spoofed, { handled: true, messageId: null }, "another account's tag finds nothing");
		const untagged = await m.events.handleSesEvent({ eventType: "Bounce", mail: { messageId: message.providerMessageId }, bounce: { bounceType: "Permanent" } });
		assert.deepEqual(untagged, { handled: true, messageId: null });

		assert.deepEqual(await bounce({ user: alice, message }), { handled: true, messageId: String(message._id) });
		assert.equal((await getOne("SELECT status FROM messages WHERE accountId = ? AND _id = ?", [alice.accountId, message._id])).status, "bounced");
		assert.ok(await getValue("SELECT 1 FROM suppressions WHERE accountId = ? AND email = ?", [alice.accountId, message.email]));
		assert.equal(await getValue("SELECT count(*) FROM suppressions WHERE accountId = ?", [bob.accountId]), 0);
		assert.equal(await getValue("SELECT count(*) FROM events WHERE accountId = ?", [bob.accountId]), 0);
	});

	test("bounces over 7 days warn the owner at the pause level, and block the account at the block level", async () => {
		const user = await customer("bouncy@example.com", "bouncy");
		const messages = await sentMessages(user, 600, (index) => (index < 12 ? { bouncedAt: Date.now(), status: "bounced" } : {}));
		await execute("UPDATE accounts SET health = '{}' WHERE _id = ?", [user.accountId]);
		const emailsBefore = platformEmails.length;
		await bounce({ user, message: messages[599] });

		const warned = await findAccount(user.accountId);
		assert.equal(warned.status, "active", "13 bounces of 600, at 2.17%: nothing stops");
		assert.equal(warned.health.sent, 600);
		assert.ok(Math.abs(warned.health.bounceRate - 13 / 600) < 1e-9);
		const emails = platformEmails.slice(emailsBefore);
		const warning = emails.find(({ subject }) => subject === "[MailCheap] Bounces or complaints are high");
		assert.deepEqual(warning.to, ["bouncy@example.com"]);
		assert.match(warning.text, /Bounce rate of 2.17% over the last 7 days \(limit 2.00%\)\. Nothing is paused, but at 5.00% with 10 bounces the account is blocked/);
		assert.equal(emails.some(({ to }) => to.includes("admin@example.com")), false, "the admins only hear of blocks");

		await execute("UPDATE messages SET bouncedAt = ?, status = 'bounced' WHERE accountId = ? AND _id IN (SELECT value FROM json_each(?))", [
			Date.now(),
			user.accountId,
			JSON.stringify(messages.slice(12, 36).map(({ _id }) => _id)),
		]);
		await execute("UPDATE accounts SET health = json_remove(health, '$.checkedAt') WHERE _id = ?", [user.accountId]);
		await bounce({ user, message: messages[598] });
		const account = await findAccount(user.accountId);
		assert.equal(account.status, "paused");
		assert.equal(account.pausedBy, "rates");
		assert.equal(account.pauseReason, "Bounce rate of 6.33% over the last 7 days (limit 5.00%)", "38 bounces of 600");

		const admin = await signIn("admin@example.com");
		assert.deepEqual(await as(admin, () => m.admin.unblockAccountAction(String(user.accountId))), { ok: true });
		const resumed = await findAccount(user.accountId);
		assert.equal(resumed.status, "active");
		assert.equal(resumed.pausedBy, null);
		assert.equal(state.reinstated.includes(resumed.ses.tenantArn), false, "only SES pauses need SES to reinstate");
	});

	test("SES pausing a tenant blocks its account; enabling it again doesn't, and unblocking reinstates the tenant", async () => {
		const name = `mc-${bob.accountId}`;
		const notification = snsNotification(tenantEvent("Sending Status Disabled", name, { data: { record: { status: "DISABLED", cause: "Complaint rate" } } }));
		const response = await m.tenantRoute.POST(jsonRequest("/api/webhooks/ses-tenants", { method: "POST", body: notification }));
		assert.equal(response.status, 200);
		assert.equal((await findAccount(bob.accountId)).status, "active", "stored first, applied by the jobs Worker");
		assert.equal((await postTenantEvent(notification)).status, 200, "a redelivery");
		assert.equal(await getValue("SELECT count(*) FROM job_outbox WHERE _id = ?", [`ses-tenant-event:${notification.MessageId}`]), 1, "one job for it");
		const paused = await findAccount(bob.accountId);
		assert.equal(paused.status, "paused");
		assert.equal(paused.pausedBy, "ses");
		assert.equal(paused.pauseReason, "SES paused sending: Complaint rate");
		assert.equal(paused.ses.tenantStatus, "DISABLED");
		assert.equal((await findAccount(alice.accountId)).status, "active", "other accounts keep sending");

		const enabled = await postTenantEvent(snsNotification(tenantEvent("Sending Status Enabled", name, { data: { record: { status: "ENABLED" } } })));
		assert.equal(enabled.status, 200);
		const stillBlocked = await findAccount(bob.accountId);
		assert.deepEqual([stillBlocked.status, stillBlocked.ses.tenantStatus], ["paused", "ENABLED"], "only an admin unblocks it");

		const admin = await signIn("admin@example.com");
		assert.deepEqual(await as(admin, () => m.admin.unblockAccountAction(String(bob.accountId))), { ok: true });
		assert.ok(state.reinstated.includes(paused.ses.tenantArn));
		assert.equal((await findAccount(bob.accountId)).ses.tenantStatus, "REINSTATED");
	});

	test("the tenant route only takes signed messages from its topic", async () => {
		const event = tenantEvent("Sending Status Disabled", `mc-${alice.accountId}`);
		const post = postTenantEvent;
		assert.equal((await post(snsNotification(event, { TopicArn: "arn:aws:sns:us-east-1:111122223333:other" }))).status, 403);
		assert.equal((await post({ ...snsNotification(event), Message: JSON.stringify({ ...event, detail: { forged: true } }) })).status, 400);
		assert.equal((await findAccount(alice.accountId)).status, "active");
	});
});
