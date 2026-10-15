import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";
import { decryptSecret } from "../lib/credentials.js";
import { execute, getAll, getOne, getValue, newId } from "../lib/db.js";
import { completeJob, publishPendingJobs, readJob } from "../lib/jobs.js";
import { insertRow } from "../lib/records.js";
import { activate, as, catchRedirect, findAccount, form, queued, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { POSTSHIBA, POSTSHIBA_ENV, createFakePostshiba } from "./helpers/postshiba.mjs";
import { dnsRecords } from "./stubs/dns-broker.mjs";

// PostShiba as the provider, through the real actions and jobs, with PostShiba answered in memory.
let app;
let fake;
let m;

// The jobs Worker's queue consumer, on the next published job or every one.
function consume(bodies) {
	return m.jobs.queue({ messages: bodies.map((body) => ({ body, attempts: 1, ack() {}, retry() {} })) });
}

async function runNextJob() {
	await consume(queued.splice(0, 1));
}

async function runJobs() {
	while (queued.length > 0) await consume(queued.splice(0));
}

// What the cron does once a deferred job's time comes.
async function releaseDeferredJobs() {
	await execute("UPDATE job_outbox SET availableAt = 0 WHERE publishedAt IS NULL");
	await publishPendingJobs();
}

const latestJob = () => getOne("SELECT * FROM job_outbox WHERE completedAt IS NULL ORDER BY createdAt DESC, rowid DESC LIMIT 1");
const findMessage = (user, where, params = []) => getOne(`SELECT * FROM messages WHERE accountId = ? AND ${where}`, [user.accountId, ...params]);
const countMessages = (user, campaignId, status) =>
	getValue("SELECT count(*) FROM messages WHERE accountId = ? AND campaignId = ? AND status = ?", [user.accountId, campaignId, status]);
const findCampaign = (user, id) => getOne("SELECT * FROM campaigns WHERE accountId = ? AND _id = ?", [user.accountId, id]);
const findDomain = (user, domain) => getOne("SELECT * FROM domains WHERE accountId = ? AND domain = ?", [user.accountId, domain]);
const findNewsletter = (user) => getOne("SELECT * FROM newsletters WHERE accountId = ? ORDER BY createdAt, _id LIMIT 1", [user.accountId]);

async function welcomeNewContact(user, email) {
	const newsletter = await getOne("SELECT * FROM newsletters WHERE accountId = ? AND _id = ?", [user.accountId, user.newsletterId]);
	const contact = await insertRow("contacts", { accountId: user.accountId, newsletterId: user.newsletterId, email, status: "active", subscribedAt: new Date() });
	return m.sending.queueWelcomeEmail({ newsletter, contact });
}

const subscription = (id) => ({
	id: `sub_${id}`,
	status: "active",
	customer: `cus_${id}`,
	items: { data: [{ price: { lookup_key: "starter_month" }, current_period_start: 1_790_000_000, current_period_end: 1_792_600_000 }] },
});

async function createNewsletter(user, slug, fields = {}) {
	const url = await as(user, () =>
		catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, fromName: "Jane", postalAddress: "1 Main St, Paris", ...fields })))
	);
	user.newsletterId = url.split("/").at(-1);
	user.slug = slug;
}

function saveFrom(user, fromEmail) {
	return as(user, () =>
		m.newsletters.saveNewsletter(null, form({ id: user.newsletterId, name: user.slug, slug: user.slug, fromName: "Jane", fromEmail, postalAddress: "1 Main St, Paris" }))
	);
}

async function draft(user, subject = "Issue") {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const id = url.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject, previewText: "This week", body: "<p>Hello {{ name }}</p>" }));
	return id;
}

async function loadAccount(user) {
	return findAccount(user.accountId);
}

// The webhook stores events; the jobs Worker applies them.
async function runEventJobs() {
	for (const { _id } of await getAll("SELECT _id FROM job_outbox WHERE kind = 'postshiba-event' AND completedAt IS NULL ORDER BY createdAt, rowid")) {
		await m.postshibaWebhook.handlePostshibaEvent((await readJob(_id)).payload);
		await completeJob(_id);
	}
}

// PostShiba's webhook as it posts in production: one signed event per request, naming the message by its own id.
async function postWebhook(event) {
	const response = await postWebhookOnly(event);
	await runEventJobs();
	return response;
}

function postWebhookOnly(event) {
	const body = JSON.stringify([event]);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = `sha256=${crypto.createHmac("sha256", POSTSHIBA.webhookSecret).update(`${timestamp}.${body}`).digest("hex")}`;
	return m.webhookRoute.POST(
		new Request("http://localhost:3000/api/webhooks/postshiba", {
			method: "POST",
			headers: { "content-type": "application/json", "x-capsule-timestamp": timestamp, "x-capsule-signature": signature },
			body,
		})
	);
}

// A paying customer whose newsletter sends from its own domain, verified at PostShiba.
async function customer(email, slug) {
	const user = await signIn(email);
	await activate(user);
	await createNewsletter(user, slug);
	const domain = `${slug}.dev`;
	assert.deepEqual(await as(user, () => m.domains.addDomainAction(null, form({ domain }))), { ok: true, domain });
	fake.verifyDomain(domain);
	await execute("UPDATE domains SET checkedAt = NULL WHERE accountId = ? AND domain = ?", [user.accountId, domain]);
	const stored = await findDomain(user, domain);
	assert.deepEqual(await as(user, () => m.domains.checkDomainAction(String(stored._id))), { ok: true, verified: true, archiveHostVerified: false });
	assert.equal((await saveFrom(user, `hello@${domain}`)).ok, true);
	user.account = await loadAccount(user);
	return user;
}

async function importContacts(user, emails) {
	await as(user, () =>
		m.contacts.importContacts({ newsletterId: user.newsletterId, consent: true, rows: emails.map((email) => ({ email, status: "active" })) })
	);
}

before(async () => {
	app = await startTestApp(POSTSHIBA_ENV);
	fake = createFakePostshiba();
	fake.install();
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		domains: await import("../app/(app)/domains/actions.js"),
		admin: await import("../app/admin/actions.js"),
		sending: await import("../lib/sending.js"),
		jobs: (await import("../worker/jobs.js")).default,
		webhookRoute: await import("../app/api/webhooks/postshiba/route.js"),
		postshibaWebhook: await import("../lib/postshiba-webhook.js"),
		billing: await import("../lib/billing.js"),
		accounts: await import("../lib/accounts.js"),
		tenants: await import("../lib/tenants.js"),
		providers: await import("../lib/email-provider/index.js"),
		postshibaAdapter: await import("../lib/email-provider/postshiba.js"),
	};
});

// A failure a test set up and didn't reach never lands on the next one.
afterEach(() => fake.state.failures.splice(0));

after(() => app?.stop());

describe("PostShiba tenants", () => {
	test("a plan starting creates one tenant with a credential on each cluster, and the SMTP password stays encrypted", async () => {
		const user = await signIn("ps-tenant@example.com");
		await m.billing.applySubscription(await loadAccount(user), subscription("ps-tenant"));
		await m.billing.applySubscription(await loadAccount(user), subscription("ps-tenant"));

		const slug = `mc-${user.accountId}`;
		const tenants = [...fake.state.tenants.values()].filter((tenant) => tenant.slug === slug);
		assert.equal(tenants.length, 1, "only once");
		const credentials = [...fake.state.credentials.values()].filter((item) => item.tenant_id === tenants[0].id);
		assert.deepEqual(credentials.map(({ cluster_id }) => cluster_id).sort(), [POSTSHIBA.bulkClusterId, POSTSHIBA.transactionalClusterId].sort());

		const { postshiba } = await loadAccount(user);
		assert.equal(postshiba.tenantId, tenants[0].id);
		assert.equal(postshiba.tenantSlug, slug);
		assert.equal(postshiba.tenantStatus, "active");
		assert.ok(postshiba.provisionedAt);
		assert.equal(postshiba.bulkCredential.clusterId, POSTSHIBA.bulkClusterId);
		assert.equal(postshiba.bulkCredential.password, undefined, "reads leave the password out");
		assert.equal(postshiba.transactionalCredential.password, undefined, "never stored for the transactional cluster");

		// Kept apart from the account row, in account_secrets, encrypted.
		const raw = await getOne("SELECT * FROM accounts WHERE _id = ?", [user.accountId]);
		const { postshibaPassword } = await getOne("SELECT postshibaPassword FROM account_secrets WHERE accountId = ?", [user.accountId]);
		const bulk = credentials.find(({ cluster_id }) => cluster_id === POSTSHIBA.bulkClusterId);
		assert.match(postshibaPassword, /^v1\./);
		assert.ok(!JSON.stringify(raw).includes(bulk.password) && !postshibaPassword.includes(bulk.password), "never in plain text");
		assert.equal(raw.postshiba.bulkCredential.password, undefined, "not in the account row");
		assert.equal(await decryptSecret(postshibaPassword, { context: `postshiba-smtp:${user.accountId}:${POSTSHIBA.bulkClusterId}` }), bulk.password);

		const listed = (await m.accounts.listAccountsForAdmin()).find(({ _id }) => String(_id) === String(user.accountId));
		assert.equal(listed.postshiba.tenantId, tenants[0].id);
		assert.equal(listed.postshiba.bulkCredential.password, undefined, "the admin list leaves it out too");
		const provider = m.providers.getEmailProvider();
		assert.equal(provider.name, "PostShiba");
		assert.deepEqual(provider.describeTenant(listed), { id: tenants[0].id, slug, status: "active", detail: null }, "what the admin page shows");
		assert.equal(provider.describeTenant({}), null);
		assert.deepEqual(
			m.providers.getProvider("ses").describeTenant({ ses: { tenantName: "mc-x", provisionedAt: new Date(), tenantStatus: "DISABLED", lastFinding: "Bounce (high impact)" } }),
			{ id: "mc-x", status: "DISABLED", detail: "Bounce (high impact)" }
		);
	});

	test("the admin page reads both clusters' plans and caps", async () => {
		const clusters = await m.postshibaAdapter.getClusters({ fresh: true });
		assert.deepEqual([clusters.bulk.classification, clusters.bulk.plan, clusters.bulk.emails_per_hour], ["bulk", "small", 40_000]);
		assert.deepEqual([clusters.transactional.classification, clusters.transactional.plan], ["transactional", "micro"]);
		fake.fail({ method: "GET", path: /\/clusters\//, status: 500, body: { error: "boom" } });
		assert.match((await m.postshibaAdapter.getClusters({ fresh: true })).error, /PostShiba GET/);
	});

	test("a setup that failed halfway finishes later, with no second tenant", async () => {
		const user = await signIn("ps-retry@example.com");
		fake.fail({ method: "POST", path: /\/smtp_credentials$/, status: 503, body: { error: "unavailable" } });
		await m.billing.applySubscription(await loadAccount(user), subscription("ps-retry"));
		let account = await loadAccount(user);
		assert.equal(account.subscriptionStatus, "active", "the plan starts anyway");
		assert.ok(account.postshiba.tenantId);
		assert.equal(account.postshiba.provisionedAt, undefined);

		// A lost write: PostShiba has the tenant, MailCheap forgot it.
		await execute("UPDATE accounts SET postshiba = json_remove(postshiba, '$.tenantId') WHERE _id = ?", [user.accountId]);
		await m.tenants.provisionTenant(user.accountId);
		account = await loadAccount(user);
		const tenants = [...fake.state.tenants.values()].filter((tenant) => tenant.slug === `mc-${user.accountId}`);
		assert.equal(tenants.length, 1);
		assert.equal(account.postshiba.tenantId, tenants[0].id, "found by its slug");
		assert.ok(account.postshiba.provisionedAt);
	});
});

describe("PostShiba domains", () => {
	test("an own domain gets PostShiba's DKIM and rp. CNAMEs, in the account's tenant, and Check now stays within the budget", async () => {
		const user = await signIn("ps-domain@example.com");
		await activate(user);
		assert.deepEqual(await as(user, () => m.domains.addDomainAction(null, form({ domain: "letters.dev" }))), { ok: true, domain: "letters.dev" });
		const domain = await findDomain(user, "letters.dev");
		const atPostshiba = fake.state.domains.get(domain.providerDomainId);
		assert.equal(atPostshiba.tenant_id, (await loadAccount(user)).postshiba.tenantId, "in the account's own tenant");
		assert.equal(domain.provider, "postshiba");
		assert.equal(domain.mailFromDomain, "rp.letters.dev");
		assert.deepEqual(domain.records, [
			{ purpose: "dkim", type: "CNAME", name: "ps1._domainkey.letters.dev", value: `${domain.providerDomainId}.customers.postshiba.test` },
			{ purpose: "mail-from", type: "CNAME", name: "rp.letters.dev", value: "rp.postshiba.test" },
		]);
		const verifyCalls = () => fake.callsTo("POST", new RegExp(`/sending_domains/${domain.providerDomainId}/verify$`)).length;
		const reads = () => fake.callsTo("GET", new RegExp(`/sending_domains/${domain.providerDomainId}$`)).length;
		assert.equal(verifyCalls(), 0, "PostShiba checks a new domain on its own");

		const readsBefore = reads();
		assert.deepEqual(await as(user, () => m.domains.checkDomainAction(String(domain._id))), { ok: true, verified: false, archiveHostVerified: false });
		assert.deepEqual([verifyCalls(), reads()], [0, readsBefore], "checked a moment ago: no call");

		fake.verifyDomain("letters.dev");
		for (let index = 0; index < 6; index++) {
			await execute("UPDATE domains SET checkedAt = ? WHERE accountId = ? AND _id = ?", [Date.now() - 120_000, user.accountId, domain._id]);
			assert.equal((await as(user, () => m.domains.checkDomainAction(String(domain._id)))).verified, true);
		}
		assert.equal(verifyCalls(), 6);
		await execute("UPDATE domains SET checkedAt = ? WHERE accountId = ? AND _id = ?", [Date.now() - 120_000, user.accountId, domain._id]);
		await as(user, () => m.domains.checkDomainAction(String(domain._id)));
		assert.deepEqual([verifyCalls(), reads()], [6, readsBefore + 1], "over the account's share: a read instead");

		assert.deepEqual(await as(user, () => m.domains.removeDomainAction(String(domain._id))), { ok: true, removed: "letters.dev" });
		assert.equal(fake.state.domains.has(domain.providerDomainId), false);
	});

	test("a domain stays in its own account and tenant: another can't add, check or remove it", async () => {
		const owner = await customer("ps-owner@example.com", "ps-owner");
		const other = await customer("ps-other@example.com", "ps-other");
		const domain = await findDomain(owner, "ps-owner.dev");
		const domainsBefore = fake.state.domains.size;
		assert.deepEqual(await as(other, () => m.domains.addDomainAction(null, form({ domain: "ps-owner.dev" }))), {
			error: "ps-owner.dev is used by another MailCheap account",
		});
		assert.equal(fake.state.domains.size, domainsBefore, "PostShiba never heard of the second claim");
		assert.deepEqual(await as(other, () => m.domains.checkDomainAction(String(domain._id))), { error: "Domain not found" });
		assert.deepEqual(await as(other, () => m.domains.removeDomainAction(String(domain._id))), { error: "Domain not found" });
		assert.equal(fake.state.domains.get(domain.providerDomainId).tenant_id, owner.account.postshiba.tenantId);
		assert.match((await saveFrom(other, "hi@ps-owner.dev")).error, /Add ps-owner.dev on the Domains page first/);
	});

	test("a domain verified at SES before the switch sends again once its PostShiba records are in", async () => {
		const user = await customer("ps-switch@example.com", "switched");
		await insertRow("domains", { accountId: user.accountId, domain: "old-ses.dev", archiveHost: "news.old-ses.dev", mailFromDomain: "bounce.old-ses.dev", verified: true, dkimStatus: "SUCCESS" });
		assert.equal((await saveFrom(user, "hi@old-ses.dev")).ok, true);
		const id = await draft(user);
		assert.match((await as(user, () => m.campaigns.sendTestCampaign(id))).error, /old-ses.dev isn't verified yet/);

		const domain = await findDomain(user, "old-ses.dev");
		await as(user, () => m.domains.checkDomainAction(String(domain._id)));
		const moved = await findDomain(user, "old-ses.dev");
		assert.equal(moved.provider, "postshiba");
		assert.equal(moved.mailFromDomain, "rp.old-ses.dev");
		assert.equal(moved.verified, false);
		assert.ok(fake.state.domains.has(moved.providerDomainId));
		fake.verifyDomain("old-ses.dev");
		await execute("UPDATE domains SET checkedAt = NULL WHERE accountId = ? AND _id = ?", [user.accountId, domain._id]);
		await as(user, () => m.domains.checkDomainAction(String(domain._id)));
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
	});
});

describe("PostShiba on one cluster", () => {
	test("without a transactional cluster, each tenant gets one credential and every email goes out on the bulk cluster", async () => {
		await withEnv({ POSTSHIBA_TRANSACTIONAL_CLUSTER_ID: "" }, async () => {
			const user = await customer("ps-single@example.com", "ps-single");
			const { postshiba } = await loadAccount(user);
			const credentials = [...fake.state.credentials.values()].filter((item) => item.tenant_id === postshiba.tenantId);
			assert.deepEqual(credentials.map(({ cluster_id }) => cluster_id), [POSTSHIBA.bulkClusterId], "one credential, on the one cluster");
			assert.equal(postshiba.transactionalCredential.credentialId, postshiba.bulkCredential.credentialId);
			assert.equal(postshiba.transactionalCredential.clusterId, POSTSHIBA.bulkClusterId);

			const id = await draft(user);
			assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
			assert.equal(fake.state.sends.at(-1).clusterId, POSTSHIBA.bulkClusterId, "test emails too");

			const clusters = await m.postshibaAdapter.getClusters({ fresh: true });
			assert.equal(clusters.isSingle, true);
			assert.equal(clusters.transactional.id, POSTSHIBA.bulkClusterId);
		});
	});
});

describe("PostShiba sending", () => {
	test("test emails go through POST /sends on the transactional cluster, with the message id as Idempotency-Key", async () => {
		const user = await customer("ps-test@example.com", "ps-test");
		const id = await draft(user, "Issue 7");
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });

		const message = await findMessage(user, "kind = 'test'");
		const { clusterId, key, body, response } = fake.state.sends.at(-1);
		assert.equal(clusterId, POSTSHIBA.transactionalClusterId);
		assert.equal(key, String(message._id));
		assert.equal(body.tenant, user.account.postshiba.tenantId);
		assert.equal(body.from, '"Jane" <hello@ps-test.dev>');
		assert.deepEqual(body.to, ["ps-test@example.com"]);
		assert.equal(body.subject, "[Test] Issue 7");
		assert.match(body.headers["List-Unsubscribe"], /\/api\/unsubscribe\?token=/);
		assert.equal(body.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
		assert.equal(body.headers["Feedback-ID"], undefined, "PostShiba sets its own");
		assert.deepEqual(body.unique_args, { account_id: String(user.accountId), message_id: String(message._id), kind: "test", campaign_id: id });
		assert.ok(response.message_id);
		assert.equal(message.providerMessageId, null, "the Message-ID /sends answers with isn't the id PostShiba's events carry");
		assert.equal(message.status, "sent");
	});

	test("a test email's events from PostShiba, under PostShiba's own message id, mark it delivered", async () => {
		const user = await customer("ps-delivered@example.com", "ps-delivered");
		const id = await draft(user, "Issue 8");
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
		const { body } = fake.state.sends.at(-1);
		const sgMessageId = crypto.randomBytes(16).toString("hex");
		const event = (type, fields = {}) => ({
			event: type,
			email: "ps-delivered@example.com",
			timestamp: Math.floor(Date.now() / 1000),
			sg_event_id: `capsule-${crypto.randomUUID()}`,
			sg_message_id: sgMessageId,
			"smtp-id": `<${fake.state.sends.at(-1).response.message_id}>`,
			tenant_id: user.account.postshiba.tenantSlug,
			...body.unique_args,
			unique_args: body.unique_args,
			...fields,
		});

		for (const type of ["processed", "delivered"]) {
			const response = await postWebhook(event(type, type === "delivered" && { response: "250 2.0.0 OK gsmtp" }));
			assert.deepEqual(await response.json(), { ok: true, queued: 1 }, type);
		}
		const message = await findMessage(user, "kind = 'test' AND campaignId = ?", [id]);
		assert.equal(message.status, "delivered");
		assert.ok(message.deliveredAt);
		assert.equal(message.providerMessageId, sgMessageId, "matched from then on by PostShiba's id");
	});

	test("campaigns go out over HTTP inject on the bulk cluster with the tenant's SMTP login", async () => {
		const user = await customer("ps-campaign@example.com", "ps-campaign");
		await importContacts(user, ["one@example.org", "two@example.org"]);
		const id = await draft(user, "Weekly");
		const before = fake.state.injects.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		await runJobs();

		const injects = fake.state.injects.slice(before);
		assert.deepEqual(injects.map(({ body }) => body.recipients[0].email).sort(), ["one@example.org", "two@example.org"]);
		assert.ok(injects.every(({ username, tenantId }) => username === user.account.postshiba.bulkCredential.username && tenantId === user.account.postshiba.tenantId));
		const [{ body }] = injects;
		assert.equal(body.envelope_sender, "hello@ps-campaign.dev");
		assert.equal(body.template_dialect, "Static");
		assert.match(body.content.html_body, /Hello \{\{ name \}\}/, "a {{ stays as written");
		const args = JSON.parse(body.content.headers["X-Capsule-Unique-Args"]);
		assert.deepEqual(Object.keys(args).sort(), ["account_id", "campaign_id", "kind", "message_id"]);
		assert.equal(args.account_id, String(user.accountId));
		assert.equal(args.kind, "campaign");
		assert.ok(await findMessage(user, "_id = ? AND status = 'sent'", [args.message_id]));
		assert.equal((await findCampaign(user, id)).status, "sent");
	});

	test("a full bulk cluster puts the batch back, and the outbox brings it after the cap resets", async () => {
		const user = await customer("ps-full@example.com", "ps-full");
		await importContacts(user, ["full1@example.org", "full2@example.org"]);
		const id = await draft(user, "Capped");
		fake.fail({ path: /^\/inject$/, status: 429, body: { error: "hourly send limit reached" } });
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		await runNextJob();
		assert.equal(await countMessages(user, id, "queued"), 2, "nothing lost");

		const retry = await latestJob();
		assert.deepEqual(JSON.parse(retry.payload).messageIds.length, 2);
		assert.equal(retry.publishedAt, null, "waits in the outbox");
		assert.ok(retry.availableAt.getTime() >= Date.now() + 59_000, "after the cap resets, not in a loop");
		await releaseDeferredJobs();
		await runJobs();
		assert.equal(await countMessages(user, id, "sent"), 2);
	});

	test("an address PostShiba suppresses is skipped and kept out of the account's next sends", async () => {
		const user = await customer("ps-suppressed@example.com", "ps-suppressed");
		fake.suppress(user.account.postshiba.tenantId, "gone@example.org");
		await importContacts(user, ["gone@example.org", "here@example.org"]);
		const id = await draft(user, "Hello");
		await as(user, () => m.campaigns.sendCampaign(id, {}));
		await runJobs();

		const messages = await getAll("SELECT email, status FROM messages WHERE accountId = ? AND campaignId = ?", [user.accountId, id]);
		assert.deepEqual(Object.fromEntries(messages.map(({ email, status }) => [email, status])), { "gone@example.org": "suppressed", "here@example.org": "sent" });
		const suppression = await getOne("SELECT reason FROM suppressions WHERE accountId = ? AND email = ?", [user.accountId, "gone@example.org"]);
		assert.equal(suppression.reason, "provider");
		assert.equal((await findCampaign(user, id)).status, "sent");
	});

	test("before PostShiba approves production sending, a campaign pauses with the reason", async () => {
		const user = await customer("ps-kyc@example.com", "ps-kyc");
		await importContacts(user, ["kyc@example.org"]);
		const id = await draft(user, "Waiting");
		fake.fail({ path: /^\/inject$/, status: 200, body: { success_count: 0, fail_count: 1, failed_recipients: ["kyc@example.org"], errors: ["550 kyc_required"] } });
		await as(user, () => m.campaigns.sendCampaign(id, {}));
		await runJobs();
		const campaign = await findCampaign(user, id);
		assert.equal(campaign.status, "paused");
		assert.match(campaign.pauseReason, /hasn't approved production sending/);
		assert.equal(await countMessages(user, id, "queued"), 1, "waits for the resume");

		fake.fail({ method: "POST", path: /\/sends$/, status: 403, body: { error: "kyc_required", field: "to" } });
		assert.match((await as(user, () => m.campaigns.sendTestCampaign(id))).error, /hasn't approved production sending/);
	});

	test("a welcome email PostShiba throttles is retried later with the same Idempotency-Key", async () => {
		const user = await customer("ps-welcome@example.com", "ps-welcome");
		await as(user, () =>
			m.newsletters.saveNewsletter(
				null,
				form({
					id: user.newsletterId,
					name: user.slug,
					slug: user.slug,
					fromName: "Jane",
					fromEmail: "hello@ps-welcome.dev",
					postalAddress: "1 Main St",
					welcomeEnabled: "on",
					welcomeSubject: "Welcome",
					welcomeMarkdown: "Thanks for joining.",
				})
			)
		);
		fake.fail({ method: "POST", path: /\/sends$/, status: 429, body: { error: "throttled", field: "base", message: "This cluster hit its hourly send limit" } });
		const sendsBefore = fake.state.sends.length;
		const welcome = await welcomeNewContact(user, "new-reader@example.org");
		assert.equal(welcome.retry, true);
		const message = await findMessage(user, "kind = 'welcome'");
		assert.equal(message.status, "queued", "kept for later");
		assert.equal(fake.state.sends.length, sendsBefore);
		const retry = await latestJob();
		assert.deepEqual(JSON.parse(retry.payload).messageIds, [String(message._id)]);
		assert.ok(retry.availableAt.getTime() > Date.now() + 60_000);

		await releaseDeferredJobs();
		await runJobs();
		assert.equal(fake.state.sends.at(-1).key, String(message._id));
		assert.equal((await findMessage(user, "_id = ?", [message._id])).status, "sent");
	});
});

describe("clusters", () => {
	test("last-chance emails go out like issues, over HTTP inject on the bulk cluster with the tenant's SMTP login", async () => {
		const user = await customer("ps-last-chance@example.com", "ps-last-chance");
		const provider = m.postshibaAdapter.postshibaProvider;
		const tenant = await provider.ensureTenant(user.account);
		const message = { _id: newId(), accountId: user.accountId, kind: "last-chance", campaignId: newId() };
		const email = { from: '"Jane" <hello@ps-last-chance.dev>', to: "cold@example.org", subject: "Still want it?", html: "<p>Keep it?</p>", text: "Keep it?", headers: {} };
		const before = { injects: fake.state.injects.length, sends: fake.state.sends.length };

		await provider.sendEmail({ tenant, message, email });
		assert.equal(fake.state.injects.length, before.injects + 1);
		assert.equal(fake.state.sends.length, before.sends, "nothing on the transactional cluster");
		const injected = fake.state.injects.at(-1);
		assert.deepEqual([injected.tenantId, injected.body.recipients], [tenant.tenantId, [{ email: "cold@example.org" }]]);
		assert.equal(JSON.parse(injected.body.content.headers["X-Capsule-Unique-Args"]).kind, "last-chance");
		assert.equal(provider.getSendLane("last-chance").name, "postshiba-bulk", "paced with the issues");
	});
});

describe("the shared address on PostShiba", () => {
	test("a newsletter without its own domain gets its own subdomain in its own tenant, with PostShiba's CNAMEs on Vercel DNS", async () => {
		const user = await signIn("ps-shared@example.com");
		await activate(user);
		await createNewsletter(user, "ps-shared");
		const newsletter = await findNewsletter(user);
		const subdomain = "ps-shared.mailcheapmail.com";
		assert.equal(newsletter.fromEmail, `hello@${subdomain}`);
		const atPostshiba = fake.state.domains.get(newsletter.sharedSender.providerDomainId);
		assert.equal(atPostshiba.name, subdomain);
		assert.equal(atPostshiba.tenant_id, (await loadAccount(user)).postshiba.tenantId, "a domain belongs to one tenant: the account's");
		assert.deepEqual(
			newsletter.sharedSender.dnsRecordIds.map((id) => dnsRecords.get(id)).map(({ type, name, value }) => [type, name, value]),
			[
				["CNAME", `ps1._domainkey.${subdomain}`, `${atPostshiba.id}.customers.postshiba.test`],
				["CNAME", `rp.${subdomain}`, "rp.postshiba.test"],
				["CNAME", subdomain, "cname.mailcheap.ai"],
			]
		);
		assert.equal(fake.callsTo("POST", /\/verify$/).filter(({ path }) => path.includes(atPostshiba.id)).length, 0, "no verification budget used");

		const id = await draft(user, "From the shared address");
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
		const { body } = fake.state.sends.at(-1);
		assert.equal(body.from, `"Jane" <hello@${subdomain}>`);
		assert.equal(body.reply_to, "ps-shared@example.com", "replies go to the owner");
		assert.match(body.headers["List-Unsubscribe"], /^<https:\/\/ps-shared\.mailcheapmail\.com\/api\/unsubscribe\?token=/);
		assert.equal((await findNewsletter(user)).sharedSender.verified, true);
	});

	test("a newsletter set up before the plan gets nothing at PostShiba or in DNS, then its subdomain when the plan starts", async () => {
		const user = await signIn("ps-early@example.com");
		const before = { tenants: fake.state.tenants.size, domains: fake.state.domains.size, records: dnsRecords.size };
		await createNewsletter(user, "ps-early");
		let newsletter = await findNewsletter(user);
		assert.equal(newsletter.fromEmail, "hello@ps-early.mailcheapmail.com");
		assert.equal(newsletter.sharedSender?.domain, undefined);
		assert.deepEqual({ tenants: fake.state.tenants.size, domains: fake.state.domains.size, records: dnsRecords.size }, before);

		await m.billing.applySubscription(await loadAccount(user), subscription("ps-early"));
		newsletter = await findNewsletter(user);
		assert.equal(newsletter.sharedSender.domain, "ps-early.mailcheapmail.com");
		assert.equal(fake.state.domains.get(newsletter.sharedSender.providerDomainId).tenant_id, (await loadAccount(user)).postshiba.tenantId);
		assert.equal(newsletter.sharedSender.dnsRecordIds.length, 3);
	});

	test("a setup that failed is done again by the next send, which waits until PostShiba finds the records", async () => {
		const user = await signIn("ps-waiting@example.com");
		await activate(user);
		fake.fail({ method: "POST", path: /\/sending_domains$/, status: 503, body: { error: "unavailable" } });
		await createNewsletter(user, "ps-waiting");
		assert.equal((await findNewsletter(user)).sharedSender, null, "the newsletter is saved anyway");

		fake.state.isDnsVisible = false;
		try {
			const id = await draft(user);
			assert.match((await as(user, () => m.campaigns.sendTestCampaign(id))).error, /hello@ps-waiting.mailcheapmail.com is still being set up/);
			const { sharedSender } = await findNewsletter(user);
			assert.equal(sharedSender.domain, "ps-waiting.mailcheapmail.com", "set up again by the send");
			assert.equal(sharedSender.verified, false);

			fake.state.isDnsVisible = true;
			assert.match((await as(user, () => m.campaigns.sendTestCampaign(id))).error, /still being set up/, "looked at once a minute at most");
			await execute("UPDATE newsletters SET sharedSender = json_set(sharedSender, '$.checkedAt', ?) WHERE accountId = ? AND _id = ?", [
				new Date(Date.now() - 120_000).toISOString(),
				user.accountId,
				user.newsletterId,
			]);
			assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });

			await execute("UPDATE newsletters SET fromEmail = 'hello@ps-shared.mailcheapmail.com' WHERE accountId = ? AND _id = ?", [user.accountId, user.newsletterId]);
			assert.match((await as(user, () => m.campaigns.sendTestCampaign(id))).error, /The shared address for this newsletter is hello@ps-waiting/, "never another account's");
		} finally {
			fake.state.isDnsVisible = true;
		}
	});
});

describe("PostShiba blocks", () => {
	test("blocking an account suspends its tenant: nothing it sends goes out until an admin unblocks it", async () => {
		const user = await customer("ps-pause@example.com", "ps-pause");
		const id = await draft(user);
		await execute("UPDATE newsletters SET welcome = ? WHERE accountId = ? AND _id = ?", [
			JSON.stringify({ enabled: true, subject: "Hi", markdown: "Welcome." }),
			user.accountId,
			user.newsletterId,
		]);
		const admin = await signIn("admin@example.com");
		assert.deepEqual(await as(admin, () => m.admin.blockAccountAction(String(user.accountId), "Review")), { ok: true });
		const tenantId = user.account.postshiba.tenantId;
		assert.equal(fake.state.tenants.get(tenantId).suspended, true);
		assert.equal((await loadAccount(user)).postshiba.tenantStatus, "suspended");

		const sendsBefore = fake.state.sends.length;
		assert.match((await as(user, () => m.campaigns.sendTestCampaign(id))).error, /This account is blocked: Review/);
		assert.deepEqual(await welcomeNewContact(user, "paused-reader@example.org"), { skipped: "account is blocked" });
		assert.equal(fake.state.sends.length, sendsBefore, "no call to a suspended tenant");

		assert.deepEqual(await as(admin, () => m.admin.unblockAccountAction(String(user.accountId))), { ok: true });
		assert.equal(fake.state.tenants.get(tenantId).suspended, false);
		const resumed = await loadAccount(user);
		assert.deepEqual([resumed.status, resumed.postshiba.tenantStatus], ["active", "active"]);
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
	});

	test("PostShiba's abuse team holding a tenant blocks its account, and unblocking waits for PostShiba", async () => {
		const user = await customer("ps-hold@example.com", "ps-hold");
		const other = await customer("ps-hold-other@example.com", "ps-hold-other");
		fake.hold(user.account.postshiba.tenantId);
		const id = await draft(user);
		assert.match((await as(user, () => m.campaigns.sendTestCampaign(id))).error, /operator_hold/);

		const blocked = await loadAccount(user);
		assert.equal(blocked.status, "paused");
		assert.equal(blocked.pausedBy, "postshiba");
		assert.equal(blocked.pauseReason, "Our email provider stopped this account's sending", "PostShiba's own words go to the admins");
		assert.equal(blocked.postshiba.tenantStatus, "operator_hold", "the suspend that followed didn't hide the hold");
		assert.equal((await loadAccount(other)).status, "active", "other accounts keep sending");

		const admin = await signIn("admin@example.com");
		const result = await as(admin, () => m.admin.unblockAccountAction(String(user.accountId)));
		assert.match(result.error, /^Still blocked, the tenant wasn't resumed: .*holds this tenant \(operator_hold\)/);
		assert.equal((await loadAccount(user)).status, "paused");

		fake.state.tenants.get(user.account.postshiba.tenantId).held = false;
		assert.equal((await loadAccount(user)).status, "paused", "PostShiba lifting its hold doesn't unblock the account");
		assert.deepEqual(await as(admin, () => m.admin.unblockAccountAction(String(user.accountId))), { ok: true });
		assert.equal((await loadAccount(user)).status, "active");
	});
});
