import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { execute, getAll, getOne, getValue } from "../lib/db.js";
import { insertRow, updateRows } from "../lib/records.js";
import { env as bindings } from "./helpers/bindings.mjs";
import { activate, addVerifiedDomain, as, callApi, catchRedirect, findAccount, form, platformEmails, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { POSTSHIBA_ENV, createFakePostshiba } from "./helpers/postshiba.mjs";
import { RedirectError } from "./stubs/next-navigation.mjs";
import { state as ses } from "./stubs/ses.mjs";
import { dnsRecords } from "./stubs/dns-broker.mjs";

// Deleting an account from its page, through the real actions and the purge job, with the outbox, SES and R2 in
// memory: what blocks it, the code it takes, what stops at once, restoring it, and what the purge removes and keeps.
const DELETION_SUBJECT = /^(\d{6}) is your code to delete your MailCheap account$/;
const BLOCKED = { error: "Your account can't be deleted yet. This page says what to do first." };
const WRONG_CODE = { error: "This code is wrong or expired" };
const DAY_MS = 24 * 60 * 60 * 1000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const OAUTH_TABLES = ["oauthConsent", "oauthAccessToken", "oauthRefreshToken"];

let app;
let m;

async function sendCode(user) {
	assert.deepEqual(await as(user, () => m.account.sendDeletionCode()), { sent: true });
	const { subject } = platformEmails.findLast(({ to, subject }) => to.includes(user.email) && DELETION_SUBJECT.test(subject));
	return DELETION_SUBJECT.exec(subject)[1];
}

// The action's answer, or where it sent the browser.
function deleteWith(user, fields) {
	return as(user, () => m.account.deleteAccount(null, form({ email: user.email, ...fields }))).catch((error) => {
		if (error instanceof RedirectError) return { redirect: error.url };
		throw error;
	});
}

async function deleteAccount(user) {
	assert.deepEqual(await deleteWith(user, { code: await sendCode(user) }), { redirect: "/signin?deleted=1" });
}

// The account's latest purge job in the outbox.
async function findPurgeJob(user) {
	const job = await getOne(
		"SELECT * FROM job_outbox WHERE kind = 'purge-account' AND json_extract(payload, '$.accountId') = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1",
		[String(user.accountId)]
	);
	return job && { ...job, body: JSON.parse(job.payload) };
}

// What the queue consumer calls for a "purge-account" job.
function runPurgeJob(body) {
	return m.purge.runPurge(body);
}

// The grace period over: the account's purge time moves to the past, and the job for that time runs.
async function purgeNow(user) {
	const purgeAt = new Date(Date.now() - 1000);
	await updateRows("accounts", { where: "_id = ?", params: [user.accountId] }, { set: { "deletion.purgeAt": purgeAt } });
	return runPurgeJob({ accountId: String(user.accountId), purgeAt: purgeAt.toISOString() });
}

// What Stripe's webhook writes once the plan is canceled in the billing portal.
function cancelPlan(user) {
	return execute("UPDATE accounts SET subscriptionStatus = 'canceled' WHERE _id = ?", [user.accountId]);
}

async function createNewsletter(user, slug) {
	const url = await as(user, () =>
		catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St, Paris", archiveEnabled: "on" })))
	);
	user.newsletterId = url.split("/").at(-1);
	user.slug = slug;
	return user.newsletterId;
}

async function createCampaign(user, subject = "Issue") {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const id = url.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject, previewText: "This week", body: "<p>Hello readers</p>" }));
	return id;
}

function setCampaign(user, id, set) {
	return updateRows("campaigns", { where: "accountId = ? AND _id = ?", params: [user.accountId, id] }, { set });
}

async function uploadImage(user) {
	const request = new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { "content-type": "image/png", "x-file-name": "cover" }, body: PNG });
	const response = await as(user, () => m.uploadsRoute.POST(request));
	assert.equal(response.status, 200);
	return (await response.json()).url;
}

// Better Auth's rows for an app the user connected: the app, its consent and its tokens.
async function connectApp(user, clientId = "app-client") {
	const now = new Date().toISOString();
	const later = new Date(Date.now() + DAY_MS).toISOString();
	await execute("INSERT OR IGNORE INTO oauthClient (id, clientId, redirectUris, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)", [
		`client-${clientId}`,
		clientId,
		JSON.stringify(["https://app.example/callback"]),
		now,
		now,
	]);
	const id = `${clientId}-${user.userId}`;
	await execute("INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)", [
		`consent-${id}`,
		clientId,
		user.userId,
		JSON.stringify(["mailcheap:full"]),
		now,
		now,
	]);
	await execute("INSERT INTO oauthRefreshToken (id, token, clientId, userId, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)", [
		`refresh-${id}`,
		`rt-${id}`,
		clientId,
		user.userId,
		later,
		now,
		"mailcheap:full",
	]);
	await execute("INSERT INTO oauthAccessToken (id, token, clientId, userId, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)", [
		`access-${id}`,
		`at-${id}`,
		clientId,
		user.userId,
		later,
		now,
		"mailcheap:full",
	]);
}

// A paying customer with one of everything: Google as a sign-in method, a newsletter on the shared address, contacts
// from an import, a campaign with a test sent, a verified domain, an image on R2, an API key, a connected app, problem
// events, suppressions and an alert.
async function customer(email, slug) {
	const user = await signIn(email);
	const now = new Date().toISOString();
	await execute("INSERT INTO auth_accounts (id, userId, providerId, accountId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)", [
		`google-${slug}`,
		user.userId,
		"google",
		`google-${slug}`,
		now,
		now,
	]);
	await activate(user);
	await createNewsletter(user, slug);
	await as(user, () =>
		m.contacts.importContacts({
			newsletterId: user.newsletterId,
			consent: true,
			rows: [
				{ email: `reader@${slug}.org`, status: "active" },
				{ email: `other@${slug}.org`, status: "active" },
			],
		})
	);
	user.campaignId = await createCampaign(user);
	assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(user.campaignId)), { ok: true });
	user.domain = `${slug}.dev`;
	await addVerifiedDomain(user, user.domain);
	user.imageUrl = await uploadImage(user);
	user.apiKey = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site", level: "full" })))).key;
	await connectApp(user);
	await insertRow("events", { accountId: user.accountId, type: "bounce", email: `reader@${slug}.org`, occurredAt: new Date() });
	await insertRow("suppressions", { accountId: user.accountId, email: `gone@${slug}.org`, reason: "bounce" });
	await insertRow("alerts", { accountId: user.accountId, key: `test-${slug}`, title: "Test", lastSentAt: new Date() });
	user.account = await findAccount(user.accountId);
	return user;
}

// Each table an account's rows are in, by the name upstream's model had.
const ACCOUNT_TABLES = {
	Newsletter: "newsletters",
	Contact: "contacts",
	ContactImport: "contact_imports",
	Campaign: "campaigns",
	Message: "messages",
	Event: "events",
	Suppression: "suppressions",
	Upload: "uploads",
	Domain: "domains",
	ApiKey: "api_keys",
	Alert: "alerts",
};

function countRows(table, where, params) {
	return getValue(`SELECT count(*) FROM ${table} WHERE ${where}`, params);
}

async function countData(user) {
	const counts = {};
	for (const [name, table] of Object.entries(ACCOUNT_TABLES)) counts[name] = await countRows(table, "accountId = ?", [user.accountId]);
	for (const table of OAUTH_TABLES) counts[table] = await countRows(table, "userId = ?", [user.userId]);
	counts.sessions = await countRows("sessions", "userId = ?", [user.userId]);
	counts.signInMethods = await countRows("auth_accounts", "userId = ?", [user.userId]);
	counts.user = await countRows("users", "id = ?", [user.userId]);
	counts.account = await countRows("accounts", "_id = ?", [user.accountId]);
	return counts;
}

const hasObject = (key) => bindings.ASSETS_BUCKET.objects.has(key);

before(async () => {
	app = await startTestApp();
	m = {
		account: await import("../app/(account)/account/actions.js"),
		restore: await import("../app/restore/actions.js"),
		signin: await import("../app/signin/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		domains: await import("../app/(app)/domains/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		uploadsRoute: await import("../app/api/uploads/route.js"),
		purge: await import("../lib/account-purge.js"),
		auth: await import("../lib/auth.js"),
		deletion: await import("../lib/account-deletion.js"),
		state: await import("../lib/account-state.js"),
		billing: await import("../lib/billing.js"),
		archive: await import("../lib/archive-data.js"),
		publicNewsletters: await import("../lib/public-newsletters.js"),
		sending: await import("../lib/sending.js"),
		registry: await import("../lib/actions/registry.js"),
	};
});

after(() => app?.stop());

describe("what blocks a deletion", () => {
	test("a plan that's active, trialing or past due: no code goes out, and a code from before doesn't delete either", async () => {
		const user = await signIn("paying@example.com");
		const codeBeforePlan = await sendCode(user);
		for (const subscriptionStatus of ["active", "trialing", "past_due"]) {
			await activate(user, { subscriptionStatus });
			const blockers = await m.deletion.getDeletionBlockers(user.account);
			assert.deepEqual({ hasPlan: blockers.hasPlan, campaigns: blockers.campaigns.length }, { hasPlan: true, campaigns: 0 }, subscriptionStatus);
			const emails = platformEmails.length;
			assert.deepEqual(await as(user, () => m.account.sendDeletionCode()), BLOCKED, subscriptionStatus);
			assert.equal(platformEmails.length, emails, "no code sent");
			assert.deepEqual(await deleteWith(user, { code: codeBeforePlan }), BLOCKED, subscriptionStatus);
		}
		assert.deepEqual((await findAccount(user.accountId)).deletion, {});

		await cancelPlan(user);
		assert.equal(await m.deletion.getDeletionBlockers(await findAccount(user.accountId)), null);
		assert.deepEqual(await deleteWith(user, { code: codeBeforePlan }), { redirect: "/signin?deleted=1" }, "the code wasn't used up while blocked");
	});

	test("a campaign sending or scheduled, until it's paused or unscheduled; drafts, paused and sent ones don't block", async () => {
		const user = await signIn("campaigns@example.com");
		await createNewsletter(user, "campaign-news");
		const scheduled = await createCampaign(user, "Next week");
		const sending = await createCampaign(user, "Going out");
		const others = await Promise.all(["Draft", "Paused", "Sent"].map((subject) => createCampaign(user, subject)));
		await setCampaign(user, scheduled, { status: "scheduled", scheduledAt: new Date(Date.now() + DAY_MS) });
		await setCampaign(user, sending, { status: "sending" });
		await setCampaign(user, others[1], { status: "paused" });
		await setCampaign(user, others[2], { status: "sent", sentAt: new Date() });

		const blockers = await m.deletion.getDeletionBlockers(user.account);
		assert.equal(blockers.hasPlan, false);
		assert.deepEqual(blockers.campaigns.map(({ subject, status }) => `${subject}: ${status}`).sort(), ["Going out: sending", "Next week: scheduled"]);
		assert.deepEqual(await as(user, () => m.account.sendDeletionCode()), BLOCKED);

		await activate(user);
		assert.deepEqual(await as(user, () => m.campaigns.pauseCampaign(sending)), { ok: true });
		assert.deepEqual(await as(user, () => m.campaigns.unscheduleCampaign(scheduled)), { ok: true });
		await cancelPlan(user);
		assert.equal(await m.deletion.getDeletionBlockers(await findAccount(user.accountId)), null);
		await deleteAccount(user);
	});
});

describe("the confirmation", () => {
	test("takes a fresh code sent for deleting, never a sign-in code, someone else's code, an old one or a mistyped email", async () => {
		const user = await signIn("code@example.com");
		const someone = await signIn("someone-else@example.com");

		assert.deepEqual(await deleteWith(user, { code: "123456" }), WRONG_CODE, "no code asked for yet");
		await as(user, () => m.signin.sendSigninCode(null, form({ email: user.email })));
		const signinCode = platformEmails.findLast(({ to }) => to.includes(user.email)).subject.slice(0, 6);
		assert.deepEqual(await deleteWith(user, { code: signinCode }), WRONG_CODE, "a sign-in code doesn't delete");
		assert.deepEqual(await deleteWith(user, { code: await sendCode(someone) }), WRONG_CODE, "someone else's code");

		const code = await sendCode(user);
		const email = platformEmails.at(-1);
		assert.deepEqual(email.to, [user.email]);
		assert.match(email.text, /If you didn't ask for it, don't share it/);
		const stored = await getOne("SELECT * FROM verifications WHERE identifier = ?", [`email-verification-otp-${user.email}`]);
		assert.equal(stored.value.includes(code), false, "stored hashed");

		assert.deepEqual(await deleteWith(user, { code, email: "code@example.org" }), { error: "Type your email address to confirm" });
		assert.deepEqual(await deleteWith(user, { code: "12345" }), { error: "Enter the 6-digit code" });
		await execute("UPDATE verifications SET expiresAt = ? WHERE id = ?", [new Date(Date.now() - 1000).toISOString(), stored.id]);
		assert.deepEqual(await deleteWith(user, { code }), WRONG_CODE, "expired after 5 minutes");
		assert.deepEqual((await findAccount(user.accountId)).deletion, {});

		const fresh = await sendCode(user);
		assert.deepEqual(await deleteWith(user, { code: fresh, email: "  Code@Example.com " }), { redirect: "/signin?deleted=1" });
		const again = await signIn(user.email);
		assert.equal(await as(again, () => catchRedirect(m.restore.restoreDeletedAccount())), "/");
		assert.deepEqual(await deleteWith(again, { code: fresh }), WRONG_CODE, "a code works once");
	});

	test("a wrong code three times ends it, and codes are limited per account", async () => {
		const user = await signIn("tries@example.com");
		const code = await sendCode(user);
		const wrong = code === "000000" ? "111111" : "000000";
		for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(await deleteWith(user, { code: wrong }), WRONG_CODE);
		assert.deepEqual(await deleteWith(user, { code }), WRONG_CODE, "dead after 3 wrong tries");
		await sendCode(user);
		await sendCode(user);
		assert.deepEqual(await as(user, () => m.account.sendDeletionCode()), { error: "Too many codes. Try again in 15 minutes." });
	});

	test("isn't an action, so no API key or connected app can delete an account or change its profile", () => {
		for (const { name } of m.registry.ACTIONS) assert.doesNotMatch(name, /account|profile|user/, name);
	});
});

describe("a deleted account", () => {
	test("stops at once: every session, its API keys, its connected apps, its signups and archive, even where there's no billing", async () => {
		const user = await signIn("stopped@example.com");
		const otherDevice = await signIn("stopped@example.com");
		const bystander = await signIn("bystander@example.com");
		await activate(user);
		await createNewsletter(user, "stopped-news");
		const { key } = await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site", level: "full" })));
		await connectApp(user);
		await connectApp(bystander);
		await cancelPlan(user);
		const newsletter = await getOne("SELECT * FROM newsletters WHERE accountId = ? AND _id = ?", [user.accountId, user.newsletterId]);
		assert.ok(await withEnv({ MAILCHEAP_CLOUD: "" }, () => m.publicNewsletters.findOpenNewsletter({ slug: user.slug })), "open before");

		const before = Date.now();
		await deleteAccount(user);

		assert.equal(await as(user, () => m.auth.getCurrentAccount()), null, "signed out here");
		assert.equal(await as(otherDevice, () => m.auth.getCurrentAccount()), null, "and on the other device");
		assert.equal((await callApi("GET", "/api/v1/newsletters", { key })).status, 401);
		assert.ok((await getOne("SELECT revokedAt FROM api_keys WHERE accountId = ?", [user.accountId])).revokedAt, "the key is revoked");
		for (const table of OAUTH_TABLES) {
			assert.equal(await countRows(table, "userId = ?", [user.userId]), 0, table);
			assert.equal(await countRows(table, "userId = ?", [bystander.userId]), 1, `someone else's ${table} stays`);
		}

		const account = await findAccount(user.accountId);
		assert.equal(m.state.isDeletionPending(account), true);
		assert.equal(m.state.getAccountStatus(account), "deleting");
		for (const cloud of ["true", ""]) {
			await withEnv({ MAILCHEAP_CLOUD: cloud }, async () => {
				assert.equal(m.state.hasActiveSubscription(account), false, `MAILCHEAP_CLOUD=${cloud}`);
				assert.equal(await m.publicNewsletters.findOpenNewsletter({ slug: user.slug }), null, "no more signups");
				assert.equal(await m.archive.getArchiveNewsletter(user.slug), null, "the archive is offline");
				const contact = await insertRow("contacts", {
					accountId: user.accountId,
					newsletterId: user.newsletterId,
					email: `late-${cloud || "self"}@example.org`,
					subscribedAt: new Date(),
				});
				const welcome = { ...newsletter, welcome: { enabled: true, subject: "Hi", markdown: "Welcome" } };
				assert.deepEqual(await m.sending.queueWelcomeEmail({ newsletter: welcome, contact }), { skipped: "no active plan" });
			});
		}

		const job = await findPurgeJob(user);
		const purgeAt = new Date(job.body.purgeAt).getTime();
		assert.ok(Math.abs(purgeAt - (before + 30 * DAY_MS)) < 60_000, "purged in 30 days");
		assert.equal(new Date(account.deletion.purgeAt).getTime(), purgeAt);
		assert.equal(job.availableAt.getTime(), purgeAt, "the outbox keeps the job until then");
		assert.equal(job.publishedAt, null, "and doesn't hand it to the queue before");
		assert.deepEqual(await runPurgeJob(job.body), { waiting: true }, "delivered early, it does nothing");
		const again = await findPurgeJob(user);
		assert.notEqual(again._id, job._id);
		assert.equal(again.body.purgeAt, job.body.purgeAt, "and waits again for the same time");
		assert.equal(again.availableAt.getTime(), purgeAt);

		const record = await getOne("SELECT * FROM deletion_records WHERE accountId = ?", [user.accountId]);
		assert.ok(record.emailHash && record.requestedAt && !record.purgedAt);
		assert.doesNotMatch(JSON.stringify(record), /stopped/);
	});

	test("can be restored by signing in within the grace period, and the purge job then does nothing", async () => {
		const user = await signIn("restored@example.com");
		await createNewsletter(user, "restored-news");
		await deleteAccount(user);
		const job = await findPurgeJob(user);

		const again = await signIn(user.email);
		assert.equal(await as(again, () => catchRedirect(m.auth.requireAccount())), "/restore", "the dashboard waits for the answer");
		assert.equal(await as(again, () => catchRedirect(m.restore.restoreDeletedAccount())), "/");
		const { account } = await as(again, () => m.auth.requireAccount());
		assert.equal(String(account._id), String(user.accountId), "the same account");
		assert.deepEqual(account.deletion, {});
		assert.equal(await countRows("newsletters", "accountId = ?", [user.accountId]), 1, "with its data");
		assert.equal(await countRows("deletion_records", "accountId = ?", [user.accountId]), 0, "it wasn't deleted after all");
		assert.ok(await withEnv({ MAILCHEAP_CLOUD: "" }, () => m.archive.getArchiveNewsletter(user.slug)), "the archive is back where no plan is needed");

		assert.deepEqual(await runPurgeJob(job.body), { skipped: "not set to be purged at this time" });
		assert.equal((await countData(user)).account, 1);
	});

	test("once its purge has started, can't be restored", async () => {
		const user = await signIn("too-late@example.com");
		await deleteAccount(user);
		await updateRows("accounts", { where: "_id = ?", params: [user.accountId] }, { set: { "deletion.purgeStartedAt": new Date() } });
		const again = await signIn(user.email);
		assert.deepEqual(await as(again, () => m.restore.restoreDeletedAccount()), { error: "Your account is being deleted, so it can't be restored anymore." });
		assert.equal(await as(again, () => catchRedirect(m.auth.requireAccount())), "/restore");
	});
});

describe("the purge", () => {
	test("deletes that account's data, at the provider, in DNS and on R2 too, keeps everyone else's, and keeps a deletion record", async () => {
		const doomed = await customer("doomed@example.com", "doomed-news");
		const kept = await customer("kept@example.com", "kept-news");
		const [doomedNewsletter, keptNewsletter] = await Promise.all(
			[doomed, kept].map((user) => getOne("SELECT * FROM newsletters WHERE accountId = ? AND _id = ?", [user.accountId, user.newsletterId]))
		);
		const [doomedUpload, keptUpload] = await Promise.all([doomed, kept].map((user) => getOne("SELECT * FROM uploads WHERE accountId = ?", [user.accountId])));
		const [doomedDomain, keptDomain] = await Promise.all([doomed, kept].map((user) => getOne("SELECT * FROM domains WHERE accountId = ?", [user.accountId])));
		const keptCounts = await countData(kept);
		assert.deepEqual(Object.keys(keptCounts).filter((name) => keptCounts[name] === 0), [], "one of everything");
		assert.ok(doomedNewsletter.sharedSender.dnsRecordIds.length > 0 && hasObject(doomedUpload.pathname));

		await cancelPlan(doomed);
		await deleteAccount(doomed);
		assert.deepEqual(await purgeNow(doomed), { purged: true });

		assert.deepEqual(
			await countData(doomed),
			Object.fromEntries(Object.keys(keptCounts).map((name) => [name, 0])),
			"nothing of it stays in the database"
		);
		assert.equal(await countRows("account_secrets", "accountId = ?", [doomed.accountId]), 0, "nor its secrets");
		assert.equal(await countRows("verifications", "identifier LIKE ?", [`%${doomed.email}%`]), 0, "nor its codes");
		assert.equal(hasObject(doomedUpload.pathname), false, "its image is gone from R2");
		assert.equal(ses.identities.has(doomedDomain.domain), false, "its domain is gone from SES");
		assert.equal(ses.identities.has(doomedNewsletter.sharedSender.domain), false, "and its shared address's subdomain");
		assert.equal(ses.tenants.has(`mc-${doomed.accountId}`), false, "and its tenant");
		assert.equal(ses.configurationSets.has(`mc-${doomed.accountId}`), false);
		for (const id of doomedNewsletter.sharedSender.dnsRecordIds) assert.equal(dnsRecords.has(id), false, "its DNS records are gone");

		assert.deepEqual(await countData(kept), keptCounts, "everyone else's data stays");
		assert.ok(hasObject(keptUpload.pathname));
		assert.ok(ses.identities.has(keptDomain.domain) && ses.identities.has(keptNewsletter.sharedSender.domain) && ses.tenants.has(`mc-${kept.accountId}`));
		for (const id of keptNewsletter.sharedSender.dnsRecordIds) assert.ok(dnsRecords.has(id));
		assert.equal((await callApi("GET", "/api/v1/newsletters", { key: kept.apiKey })).status, 200);

		const record = await getOne("SELECT * FROM deletion_records WHERE accountId = ?", [doomed.accountId]);
		assert.deepEqual(Object.keys(record).sort(), ["_id", "accountCreatedAt", "accountId", "emailHash", "purgedAt", "requestedAt"]);
		assert.equal(String(record.accountCreatedAt), String(doomed.account.createdAt));
		assert.doesNotMatch(JSON.stringify(record), /doomed/, "a hash, never the email or anything the account held");

		const admins = platformEmails.length;
		const returning = await signIn(doomed.email);
		assert.notEqual(String(returning.accountId), String(doomed.accountId), "signing in again opens a new account");
		assert.ok(
			platformEmails.slice(admins).some(({ to, subject }) => to.includes("admin@example.com") && subject === "[MailCheap] A deleted account's email signed up again"),
			"and the admins hear of it"
		);
	});

	test("waits while a plan is active again, and a step that fails is tried again the next day", async () => {
		const user = await customer("stuck@example.com", "stuck-news");
		await cancelPlan(user);
		await deleteAccount(user);

		await activate(user);
		const held = await purgeNow(user);
		assert.match(held.postponed, /plan is active again/);
		assert.equal((await countData(user)).Contact, 2, "nothing deleted");
		await cancelPlan(user);

		const upload = await getOne("SELECT * FROM uploads WHERE accountId = ?", [user.accountId]);
		const bucket = bindings.ASSETS_BUCKET;
		const remove = bucket.delete;
		bucket.delete = async (keys) => {
			if ([keys].flat().includes(upload.pathname)) throw new Error("R2 refused to delete the object");
			return remove(keys);
		};
		let failed;
		try {
			failed = await purgeNow(user);
		} finally {
			bucket.delete = remove;
		}
		assert.match(failed.postponed, /the purge stopped: R2 refused to delete the object/);
		const retry = await findPurgeJob(user);
		assert.ok(retry.availableAt.getTime() > Date.now() + DAY_MS - 60_000, "tomorrow");
		assert.equal(await countRows("uploads", "accountId = ?", [user.accountId]), 1, "kept, so the next try deletes the file");
		assert.equal((await countData(user)).user, 0, "the rest went ahead");
		assert.ok(
			platformEmails.some(({ to, subject }) => to.includes("admin@example.com") && subject === "[MailCheap] Account purge postponed"),
			"the admins hear of it"
		);

		assert.deepEqual(await runPurgeJob(retry.body), { purged: true });
		assert.equal((await countData(user)).Upload, 0);
		assert.equal(hasObject(upload.pathname), false);
	});

	test("an account with nothing but an image and its sign-in is purged whole, its rows children first", async () => {
		const user = await signIn("small@example.com");
		await uploadImage(user);
		await deleteAccount(user);
		assert.deepEqual(await purgeNow(user), { purged: true });
		assert.equal((await countData(user)).account, 0);
		assert.deepEqual(await getAll("SELECT _id FROM uploads WHERE accountId = ?", [user.accountId]), []);
	});

	test("on PostShiba: the tenant is suspended at once, resumed on restore, and deleted with its domains by the purge", async () => {
		const fake = createFakePostshiba();
		const uninstall = fake.install();
		try {
			await withEnv(POSTSHIBA_ENV, async () => {
				const user = await signIn("ps-delete@example.com");
				await m.billing.applySubscription(user.account, {
					id: "sub_ps_delete",
					status: "active",
					customer: "cus_ps_delete",
					items: { data: [{ price: { lookup_key: "starter_month" }, current_period_start: 1_790_000_000, current_period_end: 1_792_600_000 }] },
				});
				await createNewsletter(user, "ps-delete-news");
				assert.deepEqual(await as(user, () => m.domains.addDomainAction(null, form({ domain: "ps-delete.dev" }))), { ok: true, domain: "ps-delete.dev" });
				const { tenantId } = (await findAccount(user.accountId)).postshiba;
				const tenantDomains = () => [...fake.state.domains.values()].filter((domain) => domain.tenant_id === tenantId).map(({ name }) => name).sort();
				assert.deepEqual(tenantDomains(), ["ps-delete-news.mailcheapmail.com", "ps-delete.dev"]);
				await cancelPlan(user);

				await deleteAccount(user);
				assert.equal(fake.state.tenants.get(tenantId).suspended, true, "PostShiba refuses its mail at once");
				const again = await signIn(user.email);
				await as(again, () => catchRedirect(m.restore.restoreDeletedAccount()));
				assert.equal(fake.state.tenants.get(tenantId).suspended, false, "and sends it again once restored");

				await deleteAccount(again);
				assert.deepEqual(await purgeNow(user), { purged: true });
				assert.equal(fake.state.tenants.has(tenantId), false, "the tenant is gone");
				assert.deepEqual(tenantDomains(), []);
				assert.equal([...fake.state.domains.values()].some(({ name }) => name.includes("ps-delete")), false, "deleted, not moved to the team's default tenant");
			});
		} finally {
			uninstall();
		}
	});
});
