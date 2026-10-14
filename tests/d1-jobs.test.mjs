import assert from "node:assert/strict";
import { test } from "node:test";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { env } from "./helpers/bindings.mjs";
import { database, newsletterId, seedNewsletter } from "./helpers/d1.mjs";

Object.assign(process.env, {
	SENDING_ENABLED: "true",
	SEND_RATE_PER_SECOND: "14",
	SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
	APP_URL: "https://mail.example.com",
});
const { getAll, getOne } = await import("../lib/db.js");
const { publishPendingJobs, readJob } = await import("../lib/jobs.js");
const { queueCampaign, recoverStalledSends, sendMessageBatch, sendToMoreContacts } = await import("../lib/sending.js");
const { enqueueDueCampaigns, runScheduledSend } = await import("../lib/scheduling.js");
const { handleSesEvent } = await import("../lib/ses-events.js");
const { default: jobs } = await import("../worker/jobs.js");

const campaignId = "c0000000000000000000000a";
const at = Date.parse("2026-10-01T12:00:00Z");

function setup(t, { contacts = 3, cleanup = false } = {}) {
	t.mock.method(console, "info", () => {});
	t.mock.method(console, "warn", () => {});
	const db = database(t);
	seedNewsletter(db);
	if (cleanup) db.sqlite.prepare(`UPDATE newsletters SET cleanup = '{"enabled":true,"issues":2,"days":30}'`).run();
	db.sqlite.prepare(`INSERT INTO campaigns (_id, newsletterId, subject, html, createdAt, updatedAt) VALUES (?, ?, 'Hello', '<p>Hi there</p>', ?, ?)`)
		.run(campaignId, newsletterId, at, at);
	const insert = db.sqlite.prepare(`INSERT INTO contacts (_id, newsletterId, email, subscribedAt, ignoredIssues, lastOpenAt, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
	for (let index = 0; index < contacts; index++) {
		insert.run(`a${String(index).padStart(23, "0")}`, newsletterId, `reader${index}@example.com`, at, 0, at + index, at, at);
	}
	const queue = { sent: [], async sendBatch(messages) { this.sent.push(...messages.map(({ body }) => body)); } };
	env.JOBS_QUEUE = queue;
	t.after(() => delete env.JOBS_QUEUE);
	return { db, queue };
}

function mockSes(t, respond = async () => ({ MessageId: `ses-${Math.random().toString(16).slice(2)}` })) {
	const calls = [];
	t.mock.method(SESv2Client.prototype, "send", async (command) => {
		calls.push(command.input);
		return respond(command.input, calls.length);
	});
	return calls;
}

async function runQueue(queue) {
	const results = [];
	while (queue.sent.length) {
		const bodies = queue.sent.splice(0);
		await jobs.queue({ messages: bodies.map((body) => ({ body, attempts: 1, ack: () => results.push("ack"), retry: () => results.push("retry") })) });
	}
	return results;
}

const campaign = () => getOne("SELECT * FROM campaigns WHERE _id = ?", [campaignId]);
const statuses = async () => (await getAll("SELECT status, count(*) AS count FROM messages GROUP BY status ORDER BY status"))
	.map(({ status, count }) => `${status}:${count}`);

test("starting a send commits its jobs with the status change and the consumer sends each message once", async (t) => {
	const { queue } = setup(t);
	const calls = mockSes(t);
	const { recipients, batches } = await queueCampaign(campaignId);
	assert.equal(recipients, 3);
	assert.equal(batches, 1);
	assert.equal((await getAll("SELECT json_type(stats, '$.recipients') AS type FROM campaigns"))[0].type, "integer");
	assert.equal(queue.sent.length, 1, "published right after the commit");
	const [body] = queue.sent;
	queue.sent.push(body); // at-least-once delivery
	await runQueue(queue);
	assert.equal(calls.length, 3, "a redelivered job sends nothing again");
	assert.deepEqual(calls.map(({ Destination }) => Destination.ToAddresses[0]), ["reader2@example.com", "reader1@example.com", "reader0@example.com"], "most engaged first");
	assert.deepEqual(await statuses(), ["sent:3"]);
	const done = await campaign();
	assert.equal(done.status, "sent");
	assert.equal(done.stats.sent, 3, "the trigger counted each send once");
	assert.ok((await readJob(body.id)).completedAt);
	const contact = await getOne("SELECT stats, ignoredIssues FROM contacts WHERE email = 'reader0@example.com'");
	assert.equal(contact.stats.sent, 1);
	assert.equal(contact.ignoredIssues, 1);
});

test("a failed publish stays in the outbox until the cron publishes it", async (t) => {
	const { queue } = setup(t, { contacts: 1 });
	t.mock.method(console, "error", () => {});
	queue.sendBatch = async () => { throw new Error("queue unavailable"); };
	await queueCampaign(campaignId);
	assert.equal((await campaign()).status, "sending");
	const [pending] = await getAll("SELECT attempts, lastError, publishedAt FROM job_outbox");
	assert.equal(pending.publishedAt, null);
	assert.match(pending.lastError, /queue unavailable/);
	queue.sendBatch = async function (messages) { this.sent.push(...messages.map(({ body }) => body)); };
	assert.equal(await publishPendingJobs(), 1);
	mockSes(t);
	await runQueue(queue);
	assert.equal((await campaign()).status, "sent");
});

test("a send SES never answered becomes ambiguous and is never resent", async (t) => {
	const { queue } = setup(t);
	t.mock.method(console, "error", () => {});
	const calls = mockSes(t, async (_input, call) => {
		if (call === 2) throw Object.assign(new Error("socket hang up"), { $metadata: {} });
		if (call === 3) throw Object.assign(new Error("Daily quota"), { name: "TooManyRequestsException", $metadata: { httpStatusCode: 429 } });
		return { MessageId: `ses-${call}` };
	});
	await queueCampaign(campaignId);
	const [body] = queue.sent.splice(0);
	await jobs.queue({ messages: [{ body, attempts: 1, ack() {}, retry() {} }] });
	assert.deepEqual(await statuses(), ["ambiguous:1", "queued:1", "sent:1"], "throttling puts the message back");
	assert.equal(queue.sent.length, 0, "the deferred retry waits in the outbox");
	const deferred = await getOne("SELECT availableAt FROM job_outbox WHERE publishedAt IS NULL");
	assert.ok(deferred.availableAt.getTime() > Date.now());

	await getAll("UPDATE job_outbox SET availableAt = 0");
	await publishPendingJobs();
	await runQueue(queue);
	assert.equal(calls.length, 4);
	assert.deepEqual(await statuses(), ["ambiguous:1", "sent:2"]);
	assert.equal((await campaign()).status, "sent", "ambiguous attempts don't hold the campaign open");

	// SES later reports the unconfirmed one: it was sent after all, and counts once.
	const ambiguous = await getOne("SELECT _id FROM messages WHERE status = 'ambiguous'");
	const delivery = { eventType: "Delivery", mail: { messageId: "ses-late", tags: { message_id: [ambiguous._id] }, destination: ["reader1@example.com"] }, delivery: { timestamp: new Date().toISOString() } };
	await handleSesEvent(delivery);
	await handleSesEvent(delivery);
	const settled = await getOne("SELECT status, sesMessageId, sentAt FROM messages WHERE _id = ?", [ambiguous._id]);
	assert.equal(settled.status, "delivered");
	assert.equal(settled.sesMessageId, "ses-late");
	assert.ok(settled.sentAt);
	const stats = (await campaign()).stats;
	assert.equal(stats.sent, 3);
	assert.equal(stats.delivered, 1);
});

test("claims abandoned mid-send become ambiguous, and stalled campaigns get their queued messages again", async (t) => {
	const { queue } = setup(t, { contacts: 2 });
	t.mock.method(console, "error", () => {});
	await queueCampaign(campaignId);
	queue.sent.length = 0; // the consumer died with the job
	const [first] = await getAll("SELECT _id FROM messages ORDER BY _id");
	await getAll("UPDATE messages SET status = 'sending', claimedAt = 1 WHERE _id = ?", [first._id]);
	await getAll("UPDATE job_outbox SET createdAt = 1");
	await getAll("UPDATE campaigns SET updatedAt = 1");
	const recovered = await recoverStalledSends();
	assert.deepEqual(recovered, { ambiguous: 1, republished: 1 });
	mockSes(t);
	await runQueue(queue);
	assert.deepEqual(await statuses(), ["ambiguous:1", "sent:1"]);
});

test("last-chance emails wait until the issue has reached everyone else", async (t) => {
	const { db, queue } = setup(t, { contacts: 3, cleanup: true });
	db.sqlite.prepare("UPDATE contacts SET ignoredIssues = 5, lastOpenAt = NULL, subscribedAt = 1, createdAt = 1 WHERE email = 'reader0@example.com'").run();
	const calls = mockSes(t);
	const { recipients } = await queueCampaign(campaignId);
	assert.equal(recipients, 2);
	assert.equal((await campaign()).lastChance.recipients, 1);
	const bodies = queue.sent.splice(0);
	assert.equal(bodies.length, 2);
	const isLastChance = async ({ id }) => (await getOne("SELECT kind FROM messages WHERE _id = ?", [(await readJob(id)).payload.messageIds[0]])).kind === "last-chance";
	assert.equal(await isLastChance(bodies[1]), true, "published after the issue batch");
	// Delivered in reverse: the last-chance batch arrives first and is deferred.
	await jobs.queue({ messages: bodies.reverse().map((body) => ({ body, attempts: 1, ack() {}, retry() {} })) });
	assert.deepEqual(calls.map(({ Destination }) => Destination.ToAddresses[0]), ["reader2@example.com", "reader1@example.com"], "most engaged first");
	await getAll("UPDATE job_outbox SET availableAt = 0");
	await publishPendingJobs();
	await runQueue(queue);
	assert.equal(calls.at(-1).Destination.ToAddresses[0], "reader0@example.com");
	assert.equal((await campaign()).status, "sent");
});

test("sending to more reaches the next contacts without resending", async (t) => {
	const { queue } = setup(t, { contacts: 5 });
	const calls = mockSes(t);
	await getAll("UPDATE campaigns SET audienceLimit = 2");
	await queueCampaign(campaignId);
	await runQueue(queue);
	assert.equal(calls.length, 2);
	const { added } = await sendToMoreContacts(campaignId, 2);
	assert.equal(added, 2);
	await runQueue(queue);
	assert.equal(calls.length, 4);
	assert.equal(new Set(calls.map(({ Destination }) => Destination.ToAddresses[0])).size, 4);
});

test("suppressed or unsubscribed contacts are skipped at send time", async (t) => {
	const { queue } = setup(t);
	const calls = mockSes(t);
	await queueCampaign(campaignId);
	await getAll("INSERT INTO suppressions (_id, email, reason, createdAt, updatedAt) VALUES ('ffffffffffffffffffffffff', 'reader0@example.com', 'complaint', 0, 0)");
	await getAll("UPDATE contacts SET status = 'unsubscribed' WHERE email = 'reader1@example.com'");
	await runQueue(queue);
	assert.equal(calls.length, 1);
	assert.deepEqual(await statuses(), ["sent:1", "suppressed:2"]);
});

test("a due schedule is enqueued once per schedule version and stale jobs do nothing", async (t) => {
	const { queue } = setup(t, { contacts: 1 });
	mockSes(t);
	t.mock.method(console, "error", () => {});
	const due = Date.now() - 1000;
	await getAll("UPDATE campaigns SET status = 'scheduled', scheduledAt = ?", [due]);
	assert.equal(await enqueueDueCampaigns(), 1);
	assert.equal(await enqueueDueCampaigns(), 1, "the next tick finds it still due");
	assert.equal((await getAll("SELECT _id FROM job_outbox WHERE kind = 'scheduled'")).length, 1, "but adds no second job");
	assert.deepEqual(await runScheduledSend({ campaignId, scheduledAt: due - 60_000 }), { skipped: "not scheduled for this time anymore" });
	await runQueue(queue);
	assert.equal((await campaign()).status, "sent");
	assert.equal(await enqueueDueCampaigns(), 0);
});

test("SES feedback suppresses globally, keeps complaint precedence and records early events", async (t) => {
	setup(t, { contacts: 1 });
	t.mock.method(console, "error", () => {});
	const email = "reader0@example.com";
	await handleSesEvent({ eventType: "Bounce", mail: { messageId: "unknown", destination: [email] }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: email }] } });
	assert.equal((await getOne("SELECT status FROM contacts")).status, "bounced");
	await handleSesEvent({ eventType: "Complaint", mail: { messageId: "unknown", destination: [email] }, complaint: { complainedRecipients: [{ emailAddress: email }] } });
	await handleSesEvent({ eventType: "Bounce", mail: { messageId: "unknown", destination: [email] }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: email }] } });
	assert.equal((await getOne("SELECT reason FROM suppressions")).reason, "complaint");
	assert.equal((await getOne("SELECT status FROM contacts")).status, "complained");
	assert.equal((await getAll("SELECT _id FROM events WHERE messageId IS NULL")).length, 3, "kept even before the message is known");
});

test("signs of life reset the ignored count and only move engagement dates forward", async (t) => {
	setup(t, { contacts: 1 });
	const contactId = "a00000000000000000000000";
	await getAll("UPDATE contacts SET ignoredIssues = 4, lastEngagedAt = ?, lastOpenAt = ?", [at + 10_000, at + 10_000]);
	await getAll(`INSERT INTO messages (_id, kind, campaignId, newsletterId, contactId, email, status, sentAt, createdAt, updatedAt)
		VALUES ('d0000000000000000000000a', 'campaign', ?, ?, ?, 'reader0@example.com', 'sent', ?, ?, ?)`, [campaignId, newsletterId, contactId, at, at, at]);
	const open = (timestamp) => handleSesEvent({ eventType: "Open", mail: { messageId: "m", tags: { message_id: ["d0000000000000000000000a"] } }, open: { timestamp: new Date(timestamp).toISOString() } });
	await open(at + 5_000);
	let contact = await getOne("SELECT ignoredIssues, lastOpenAt, lastEngagedAt, stats FROM contacts");
	assert.equal(contact.ignoredIssues, 0);
	assert.equal(contact.lastOpenAt.getTime(), at + 10_000, "an older open never moves the date back");
	assert.equal(contact.stats.opens, 1);
	await open(at + 20_000);
	contact = await getOne("SELECT lastOpenAt, lastEngagedAt, stats FROM contacts");
	assert.equal(contact.lastOpenAt.getTime(), at + 20_000, "repeat opens still move it forward");
	assert.equal(contact.lastEngagedAt.getTime(), at + 20_000);
	assert.equal(contact.stats.opens, 1, "but count once per message");
	assert.equal((await campaign()).stats.opened, 1);
});

test("a send that fails before reaching SES (no credentials) fails instead of becoming ambiguous", async (t) => {
	const { queue } = setup(t, { contacts: 1 });
	t.mock.method(console, "error", () => {});
	mockSes(t, async () => { throw Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" }); });
	await queueCampaign(campaignId);
	await runQueue(queue);
	assert.deepEqual(await statuses(), ["failed:1"]);
});
