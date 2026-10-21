import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "./helpers/bindings.mjs";
import { accountId, database, newsletterId, seedAccount, seedNewsletter } from "./helpers/d1.mjs";
import { sent as sesSent, state as sesState } from "./stubs/ses.mjs";

Object.assign(process.env, {
	SENDING_ENABLED: "true",
	SEND_RATE_PER_SECOND: "1000",
	// Self-hosted: every account counts as paid and sends at full speed (no warm-up spread).
	MAILCHEAP_CLOUD: "",
	EMAIL_PROVIDER: "ses",
	SHARED_DOMAIN: "",
	BETTER_AUTH_SECRET: "test-secret-for-integration-tests-0123456789",
	APP_URL: "https://mail.example.com",
});
const { getAll, getOne } = await import("../lib/db.js");
const { completeJob, publishPendingJobs, readJob } = await import("../lib/jobs.js");
const { checkFirstSend, queueCampaign, recoverStalledSends, runSendJob, sendToMoreContacts } = await import("../lib/sending.js");
const { enqueueDueCampaigns, runScheduledSend } = await import("../lib/scheduling.js");
const { handleSesEvent } = await import("../lib/ses-events.js");

const campaignId = "c0000000000000000000000a";
const at = Date.parse("2026-10-01T12:00:00Z");
const TENANT = "mc-tenant";

// What worker/jobs.js does with each kind this area adds.
const HANDLERS = { send: runSendJob, "check-first-send": checkFirstSend, scheduled: runScheduledSend };

function setup(t, { contacts = 3, cleanup = false } = {}) {
	t.mock.method(console, "info", () => {});
	t.mock.method(console, "warn", () => {});
	const db = database(t);
	seedAccount(db);
	db.sqlite.prepare("UPDATE accounts SET ses = ? WHERE _id = ?").run(
		JSON.stringify({ tenantName: TENANT, configurationSet: TENANT, provisionedAt: new Date(at).toISOString() }),
		accountId
	);
	seedNewsletter(db);
	db.sqlite.prepare("UPDATE newsletters SET postalAddress = '1 Main St'").run();
	if (cleanup) db.sqlite.prepare(`UPDATE newsletters SET cleanup = '{"enabled":true,"issues":2,"days":30}'`).run();
	db.sqlite.prepare(`INSERT INTO domains (_id, accountId, domain, mailFromDomain, archiveHost, provider, verified, dkimStatus, mailFromStatus, createdAt, updatedAt)
		VALUES ('d0000000000000000000000d', ?, 'example.com', 'bounce.example.com', 'news.example.com', 'ses', 1, 'SUCCESS', 'SUCCESS', ?, ?)`).run(accountId, at, at);
	sesState.associations.set(TENANT, new Set(["identity/example.com", `configuration-set/${TENANT}`]));
	sesSent.length = 0;
	db.sqlite.prepare(`INSERT INTO campaigns (_id, accountId, newsletterId, subject, html, createdAt, updatedAt) VALUES (?, ?, ?, 'Hello', '<p>Hi there</p>', ?, ?)`)
		.run(campaignId, accountId, newsletterId, at, at);
	addContacts(db, contacts);
	const queue = { sent: [], async sendBatch(messages) { this.sent.push(...messages.map(({ body }) => body)); } };
	env.JOBS_QUEUE = queue;
	t.after(() => delete env.JOBS_QUEUE);
	return { db, queue };
}

// Already mailed by default, so no first-send slice applies; `neverMailed` contacts have no lastSentAt.
function addContacts(db, count, { from = 0, neverMailed = false } = {}) {
	const insert = db.sqlite.prepare(`INSERT INTO contacts (_id, accountId, newsletterId, email, subscribedAt, ignoredIssues, lastOpenAt, lastSentAt, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	for (let index = from; index < from + count; index++) {
		insert.run(`a${String(index).padStart(23, "0")}`, accountId, newsletterId, `reader${index}@example.com`, at, 0, at + index, neverMailed ? null : at, at, at);
	}
}

// The consumer: each published job once by kind, completed after it ran. Redelivered ids run again.
async function runQueue(queue) {
	const results = [];
	while (queue.sent.length) {
		for (const body of queue.sent.splice(0)) {
			const job = await readJob(body.id);
			if (!job || job.completedAt) continue;
			results.push({ kind: job.kind, result: await HANDLERS[job.kind](job.payload) });
			await completeJob(job._id);
		}
	}
	return results;
}

const recipients = () => sesSent.map(({ to }) => to);
const campaign = () => getOne("SELECT * FROM campaigns WHERE _id = ?", [campaignId]);
const statuses = async () => (await getAll("SELECT status, count(*) AS count FROM messages GROUP BY status ORDER BY status"))
	.map(({ status, count }) => `${status}:${count}`);
const failNextSend = (error) => { sesState.failNext = { name: "sendSesEmail", error }; };

test("starting a send commits its jobs with the status change and the consumer sends each message once", async (t) => {
	const { queue } = setup(t);
	const { recipients: count, batches } = await queueCampaign({ accountId, campaignId });
	assert.equal(count, 3);
	assert.equal(batches, 1);
	assert.equal((await getAll("SELECT json_type(stats, '$.recipients') AS type FROM campaigns"))[0].type, "integer");
	assert.equal(queue.sent.length, 1, "published right after the commit");
	const [body] = queue.sent;
	const job = await readJob(body.id);
	assert.deepEqual([job.kind, job.payload.accountId, job.payload.campaignId], ["send", accountId, campaignId]);
	queue.sent.push(body); // at-least-once delivery
	await runQueue(queue);
	assert.deepEqual(recipients(), ["reader2@example.com", "reader1@example.com", "reader0@example.com"], "most engaged first, each once");
	assert.deepEqual(await statuses(), ["sent:3"]);
	const done = await campaign();
	assert.equal(done.status, "sent");
	assert.equal(done.stats.sent, 3, "the trigger counted each send once");
	assert.ok((await readJob(body.id)).completedAt);
	const contact = await getOne("SELECT stats, ignoredIssues FROM contacts WHERE email = 'reader0@example.com'");
	assert.equal(contact.stats.sent, 1);
	assert.equal(contact.ignoredIssues, 1);
	assert.ok((await getOne("SELECT provider FROM messages LIMIT 1")).provider, "the mailbox provider is set at the claim");
	assert.equal(sesSent[0].tenantName, TENANT, "through the account's tenant");
});

test("a failed publish stays in the outbox until the cron publishes it", async (t) => {
	const { queue } = setup(t, { contacts: 1 });
	t.mock.method(console, "error", () => {});
	queue.sendBatch = async () => { throw new Error("queue unavailable"); };
	await queueCampaign({ accountId, campaignId });
	assert.equal((await campaign()).status, "sending");
	const [pending] = await getAll("SELECT attempts, lastError, publishedAt FROM job_outbox");
	assert.equal(pending.publishedAt, null);
	assert.match(pending.lastError, /queue unavailable/);
	queue.sendBatch = async function (messages) { this.sent.push(...messages.map(({ body }) => body)); };
	assert.equal(await publishPendingJobs(), 1);
	await runQueue(queue);
	assert.equal((await campaign()).status, "sent");
});

test("an unconfirmed send is kept out of every retry", async (t) => {
	const { queue } = setup(t);
	t.mock.method(console, "error", () => {});
	await queueCampaign({ accountId, campaignId });
	failNextSend(Object.assign(new Error("socket hang up"), { ambiguous: true }));
	await runQueue(queue);
	assert.deepEqual(await statuses(), ["ambiguous:1", "queued:2"], "the batch stops at the first unconfirmed send");
	const deferred = await getOne("SELECT availableAt FROM job_outbox WHERE publishedAt IS NULL");
	assert.ok(deferred.availableAt.getTime() > Date.now(), "the rest waits in the outbox");

	failNextSend(Object.assign(new Error("Daily quota"), { name: "TooManyRequestsException" }));
	await getAll("UPDATE job_outbox SET availableAt = 0");
	await publishPendingJobs();
	await runQueue(queue);
	assert.deepEqual(await statuses(), ["ambiguous:1", "queued:2"], "throttling puts the message back");

	await getAll("UPDATE job_outbox SET availableAt = 0");
	await publishPendingJobs();
	await runQueue(queue);
	assert.deepEqual(await statuses(), ["ambiguous:1", "sent:2"]);
	assert.equal(sesSent.length, 2, "the unconfirmed one was never sent again");
	assert.equal((await campaign()).status, "sent", "ambiguous attempts don't hold the campaign open");
	assert.equal((await campaign()).stats.sent, 2);

	// SES later reports the unconfirmed one: it was sent after all, and counts once.
	const ambiguous = await getOne("SELECT _id, email FROM messages WHERE status = 'ambiguous'");
	const delivery = { eventType: "Delivery", mail: { messageId: "ses-late", tags: { message_id: [ambiguous._id], account_id: [accountId] }, destination: [ambiguous.email] }, delivery: { timestamp: new Date().toISOString() } };
	await handleSesEvent(delivery);
	await handleSesEvent(delivery);
	const settled = await getOne("SELECT status, providerMessageId, sentAt FROM messages WHERE _id = ?", [ambiguous._id]);
	assert.equal(settled.status, "delivered");
	assert.equal(settled.providerMessageId, "ses-late");
	assert.ok(settled.sentAt);
	const stats = (await campaign()).stats;
	assert.equal(stats.sent, 3);
	assert.equal(stats.delivered, 1);
});

test("claims abandoned mid-send become ambiguous, and stalled campaigns get their queued messages again", async (t) => {
	const { queue } = setup(t, { contacts: 2 });
	t.mock.method(console, "error", () => {});
	await queueCampaign({ accountId, campaignId });
	queue.sent.length = 0; // the consumer died with the job
	const [first] = await getAll("SELECT _id FROM messages ORDER BY rowid");
	await getAll("UPDATE messages SET status = 'sending', claimedAt = 1 WHERE _id = ?", [first._id]);
	await getAll("UPDATE job_outbox SET createdAt = 1, availableAt = 1, publishedAt = 1");
	await getAll("UPDATE campaigns SET updatedAt = 1");
	const recovered = await recoverStalledSends();
	assert.deepEqual(recovered, { ambiguous: 1, republished: 1, checks: 0 });
	assert.equal((await getOne("SELECT count(*) AS count FROM alerts WHERE accountId = ? AND key = 'ambiguous-send'", [accountId])).count, 1);
	await runQueue(queue);
	assert.deepEqual(await statuses(), ["ambiguous:1", "sent:1"]);
});

test("a spread send's batches waiting for their time don't look stalled", async (t) => {
	const { queue } = setup(t, { contacts: 2 });
	await queueCampaign({ accountId, campaignId });
	queue.sent.length = 0;
	await getAll("UPDATE job_outbox SET createdAt = 1, availableAt = ?", [Date.now() + 3_600_000]);
	await getAll("UPDATE campaigns SET updatedAt = 1");
	assert.deepEqual(await recoverStalledSends(), { ambiguous: 0, republished: 0, checks: 0 });
});

test("last-chance emails wait until the issue has reached everyone else", async (t) => {
	const { db, queue } = setup(t, { contacts: 3, cleanup: true });
	db.sqlite.prepare("UPDATE contacts SET ignoredIssues = 5, lastOpenAt = NULL, subscribedAt = 1, createdAt = 1 WHERE email = 'reader0@example.com'").run();
	const { recipients: count } = await queueCampaign({ accountId, campaignId });
	assert.equal(count, 2);
	assert.equal((await campaign()).lastChance.recipients, 1);
	const bodies = queue.sent.splice(0);
	assert.equal(bodies.length, 2);
	const isLastChance = async ({ id }) => (await getOne("SELECT kind FROM messages WHERE _id = ?", [(await readJob(id)).payload.messageIds[0]])).kind === "last-chance";
	assert.equal(await isLastChance(bodies[1]), true, "published after the issue batch");
	// Delivered in reverse: the last-chance batch arrives first and is deferred.
	queue.sent.push(...bodies.reverse());
	await runQueue(queue);
	assert.deepEqual(recipients(), ["reader2@example.com", "reader1@example.com"], "most engaged first");
	await getAll("UPDATE job_outbox SET availableAt = 0");
	await publishPendingJobs();
	await runQueue(queue);
	assert.equal(recipients().at(-1), "reader0@example.com");
	assert.equal((await campaign()).status, "sent");
});

test("sending to more reaches the next contacts without resending", async (t) => {
	const { queue } = setup(t, { contacts: 5 });
	await getAll("UPDATE campaigns SET audienceLimit = 2");
	await queueCampaign({ accountId, campaignId });
	await runQueue(queue);
	assert.equal(sesSent.length, 2);
	const { added } = await sendToMoreContacts({ accountId, campaignId, additional: 2 });
	assert.equal(added, 2);
	await runQueue(queue);
	assert.equal(sesSent.length, 4);
	assert.equal(new Set(recipients()).size, 4);
});

test("suppressed or unsubscribed contacts are skipped at send time", async (t) => {
	const { queue } = setup(t);
	await queueCampaign({ accountId, campaignId });
	await getAll("INSERT INTO suppressions (_id, accountId, email, reason, createdAt, updatedAt) VALUES ('ffffffffffffffffffffffff', ?, 'reader0@example.com', 'complaint', 0, 0)", [accountId]);
	await getAll("UPDATE contacts SET status = 'unsubscribed' WHERE email = 'reader1@example.com'");
	await runQueue(queue);
	assert.equal(sesSent.length, 1);
	assert.deepEqual(await statuses(), ["sent:1", "suppressed:2"]);
});

test("each contact gets the edition in their language, and contacts in a language it has nothing in the newsletter's", async (t) => {
	const { db, queue } = setup(t, { contacts: 7 });
	const setLanguage = db.sqlite.prepare("UPDATE contacts SET language = ?, languageRegion = ? WHERE email = ?");
	// reader0 has none and reads the newsletter's English.
	for (const [index, language, region] of [[1, "en", "GB"], [2, "pt", "BR"], [3, "pt", null], [4, "pt", "PT"], [5, "de", null], [6, "fr", null]]) {
		setLanguage.run(language, region, `reader${index}@example.com`);
	}
	const insertEdition = db.sqlite.prepare(`INSERT INTO campaign_editions (_id, accountId, campaignId, language, languageRegion, subject, html, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	insertEdition.run("e0000000000000000000000a", accountId, campaignId, "pt", "BR", "Olá", "<p>Oi, tudo bem?</p>", at, at);
	insertEdition.run("e0000000000000000000000b", accountId, campaignId, "fr", null, "", "<p>Salut</p>", at, at);

	await assert.rejects(queueCampaign({ accountId, campaignId }), { code: "send_check_failed", message: "French edition: add a subject" });
	await getAll("DELETE FROM campaign_editions WHERE language = 'fr'");

	const { recipients: count } = await queueCampaign({ accountId, campaignId });
	assert.equal(count, 7);
	await runQueue(queue);
	const subjects = Object.fromEntries(sesSent.map(({ to, subject }) => [to, subject]));
	assert.deepEqual(subjects, {
		"reader0@example.com": "Hello",
		"reader1@example.com": "Hello",
		"reader2@example.com": "Olá",
		"reader3@example.com": "Olá",
		"reader4@example.com": "Olá",
		"reader5@example.com": "Hello",
		"reader6@example.com": "Hello",
	});
	const portuguese = sesSent.find(({ to }) => to === "reader2@example.com");
	assert.match(portuguese.html, /Oi, tudo bem\?/);
	assert.match(portuguese.html, /<html lang="pt-BR">/);
	const editionIds = await getAll("SELECT email, editionId FROM messages ORDER BY email");
	assert.deepEqual(editionIds.filter(({ editionId }) => editionId).map(({ email }) => email), ["reader2@example.com", "reader3@example.com", "reader4@example.com"]);
	const done = await campaign();
	assert.equal(done.status, "sent");
	assert.deepEqual([done.language, done.languageRegion], ["en", null], "the send pins the newsletter's language");
	await assert.rejects(getAll("DELETE FROM campaign_editions"), /FOREIGN KEY/, "a sent edition stays");
});

test("a campaign with nothing in its newsletter's language goes to its own languages' readers only", async (t) => {
	const { db, queue } = setup(t, { contacts: 3 });
	db.sqlite.prepare("UPDATE contacts SET language = 'pt' WHERE email = 'reader1@example.com'").run();
	db.sqlite.prepare("UPDATE campaigns SET language = 'pt', languageRegion = 'BR'").run();
	await queueCampaign({ accountId, campaignId });
	await runQueue(queue);
	assert.deepEqual(recipients(), ["reader1@example.com"]);
	assert.match(sesSent[0].html, /<html lang="pt-BR">/);

	db.sqlite.prepare("UPDATE contacts SET status = 'unsubscribed' WHERE email = 'reader1@example.com'").run();
	db.sqlite.prepare(`INSERT INTO campaigns (_id, accountId, newsletterId, subject, html, language, createdAt, updatedAt)
		VALUES ('c0000000000000000000000b', ?, ?, 'Olá', '<p>Oi</p>', 'pt', ?, ?)`).run(accountId, newsletterId, at, at);
	await assert.rejects(queueCampaign({ accountId, campaignId: "c0000000000000000000000b" }), { code: "no_recipients" });
});

test("a first send goes in steps: the slice, then the rest once its check passes", async (t) => {
	const { db, queue } = setup(t, { contacts: 50 });
	addContacts(db, 450, { from: 50, neverMailed: true });
	await queueCampaign({ accountId, campaignId });
	assert.deepEqual(await statuses(), ["held:250", "queued:250"], "a 200 slice of 450 new contacts, and the 50 mailed before");
	const check = await getOne("SELECT availableAt, publishedAt FROM job_outbox WHERE kind = 'check-first-send'");
	assert.ok(check.availableAt.getTime() >= Date.now() + 179 * 60_000, "checked 3 hours later");
	assert.equal(check.publishedAt, null, "waits in the outbox until then");
	assert.deepEqual({ slice: (await campaign()).firstSend.slice, held: (await campaign()).firstSend.held }, { slice: 200, held: 250 });
	await runQueue(queue);
	assert.equal(sesSent.length, 250);
	assert.equal((await campaign()).status, "sending", "not sent while contacts are held");

	await getAll("UPDATE job_outbox SET availableAt = 0 WHERE kind = 'check-first-send'");
	await publishPendingJobs();
	const [result] = (await runQueue(queue)).filter(({ kind }) => kind === "check-first-send");
	assert.equal(result.result.released, 250);
	assert.equal(sesSent.length, 500);
	assert.equal((await campaign()).status, "sent");
	assert.ok((await campaign()).firstSend.checkedAt instanceof Date);
});

test("a due schedule runs once per schedule version and stale jobs do nothing", async (t) => {
	const { queue } = setup(t, { contacts: 1 });
	t.mock.method(console, "error", () => {});
	const due = Date.now() - 1000;
	await getAll("UPDATE campaigns SET status = 'scheduled', scheduledAt = ?", [due]);
	assert.equal(await enqueueDueCampaigns(), 1);
	assert.equal(await enqueueDueCampaigns(), 1, "the next tick finds it still due");
	assert.equal((await getAll("SELECT _id FROM job_outbox WHERE kind = 'scheduled'")).length, 1, "but adds no second job");
	assert.deepEqual(await runScheduledSend({ accountId, campaignId, scheduledAt: new Date(due - 60_000).toISOString() }), { skipped: "not scheduled for this time anymore" });
	await runQueue(queue);
	assert.equal((await campaign()).status, "sent");
	assert.equal(await enqueueDueCampaigns(), 0);
});

test("a send that fails before reaching the provider fails instead of becoming ambiguous", async (t) => {
	const { queue } = setup(t, { contacts: 1 });
	t.mock.method(console, "error", () => {});
	failNextSend(Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" }));
	await queueCampaign({ accountId, campaignId });
	await runQueue(queue);
	assert.deepEqual(await statuses(), ["failed:1"]);
	assert.equal((await campaign()).stats.failed, 1);
});

test("signs of life reset the ignored count and only move engagement dates forward", async (t) => {
	setup(t, { contacts: 1 });
	const contactId = "a00000000000000000000000";
	await getAll("UPDATE contacts SET ignoredIssues = 4, lastEngagedAt = ?, lastOpenAt = ?", [at + 10_000, at + 10_000]);
	await getAll(`INSERT INTO messages (_id, accountId, kind, campaignId, newsletterId, contactId, email, status, sentAt, createdAt, updatedAt)
		VALUES ('d0000000000000000000000a', ?, 'campaign', ?, ?, ?, 'reader0@example.com', 'sent', ?, ?, ?)`, [accountId, campaignId, newsletterId, contactId, at, at, at]);
	const open = (timestamp) => handleSesEvent({ eventType: "Open", mail: { messageId: "m", tags: { message_id: ["d0000000000000000000000a"], account_id: [accountId] } }, open: { timestamp: new Date(timestamp).toISOString() } });
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
