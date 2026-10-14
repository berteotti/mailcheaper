import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { execute, getOne, getValue } from "../lib/db.js";
import { activate, addVerifiedDomain, as, callApi, catchRedirect, findAccount, form, platformEmails, queued, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { cnames } from "./stubs/dns-check.mjs";
import { calls, sent, state } from "./stubs/ses.mjs";
import { dnsRecords } from "./stubs/dns-broker.mjs";

// From addresses, SES tenants and domains, through the real actions with SES, DNS and Vercel in memory.
let app;
let m;

// The jobs Worker's queue consumer, on every job published so far.
async function runJobs() {
	while (queued.length > 0) {
		const bodies = queued.splice(0);
		await m.jobs.queue({ messages: bodies.map((body) => ({ body, attempts: 1, ack() {}, retry() {} })) });
	}
}

const findNewsletter = (user) => getOne("SELECT * FROM newsletters WHERE accountId = ? ORDER BY createdAt, _id LIMIT 1", [user.accountId]);
const findDomain = (user, domain) => getOne("SELECT * FROM domains WHERE accountId = ? AND domain = ?", [user.accountId, domain]);

async function createNewsletter(user, slug, fields = {}) {
	const url = await as(user, () =>
		catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St, Paris", archiveEnabled: "on", ...fields })))
	);
	user.newsletterId = url.split("/").at(-1);
	return getOne("SELECT * FROM newsletters WHERE accountId = ? AND _id = ?", [user.accountId, user.newsletterId]);
}

function saveFrom(user, slug, fromEmail) {
	return as(user, () =>
		m.newsletters.saveNewsletter(null, form({ id: user.newsletterId, name: slug, slug, fromEmail, postalAddress: "1 Main St, Paris", archiveEnabled: "on" }))
	);
}

function switchTo(user, domain, localPart) {
	return as(user, () => m.domains.switchToDomainAction(null, form({ newsletterId: user.newsletterId, domainId: String(domain._id), localPart })));
}

async function draft(user) {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const id = url.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "This week", body: '<p>Hello <a href="https://example.org">link</a></p>' }));
	return id;
}

async function customer(email, slug) {
	const user = await signIn(email);
	await activate(user);
	await createNewsletter(user, slug);
	return user;
}

before(async () => {
	app = await startTestApp();
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		domains: await import("../app/(app)/domains/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		jobs: (await import("../worker/jobs.js")).default,
		billing: await import("../lib/billing.js"),
		hostRouting: await import("../lib/host-routing.js"),
	};
});

after(() => app?.stop());

describe("SES tenants", () => {
	test("a plan starting creates the account's tenant once, with its configuration set", async () => {
		const user = await signIn("tenant@example.com");
		const subscription = {
			id: "sub_tenant",
			status: "active",
			customer: "cus_tenant",
			items: { data: [{ price: { lookup_key: "starter_month" }, current_period_start: 1_790_000_000, current_period_end: 1_792_600_000 }] },
		};
		const account = await findAccount(user.accountId);
		await m.billing.applySubscription(account, subscription);
		await m.billing.applySubscription(await findAccount(user.accountId), subscription);

		const name = `mc-${user.accountId}`;
		const { ses } = await findAccount(user.accountId);
		assert.equal(ses.tenantName, name);
		assert.equal(ses.configurationSet, name);
		assert.ok(ses.provisionedAt && ses.tenantArn.includes(`tenant/${name}/`));
		assert.equal(calls.filter((call) => call.name === "createTenant" && call.args.name === name).length, 1, "only once");
		assert.deepEqual(state.tenants.get(name), { accountId: user.accountId, policy: "standard", suppression: "TENANT" });
		assert.deepEqual([...state.associations.get(name)], [`configuration-set/${name}`], "no shared domain: each newsletter gets its own subdomain");
	});

	test("a failed setup doesn't stop the plan, and the first send finishes it", async () => {
		const user = await signIn("tenant-retry@example.com");
		state.failNext = { name: "createTenant", error: new Error("Throttled") };
		await m.billing.applySubscription(await findAccount(user.accountId), {
			id: "sub_retry",
			status: "active",
			customer: "cus_retry",
			items: { data: [{ price: { lookup_key: "starter_month" } }] },
		});
		const account = await findAccount(user.accountId);
		assert.equal(account.subscriptionStatus, "active");
		assert.equal(account.ses?.provisionedAt, undefined);

		await createNewsletter(user, "retry-news");
		const id = await draft(user);
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
		assert.equal(sent.at(-1).tenantName, `mc-${user.accountId}`);
	});
});

describe("from addresses", () => {
	test("newsletters default to the shared address on their own subdomain, set up with its DNS records; replies go to the owner", async () => {
		const user = await customer("shared@example.com", "shared-news");
		const newsletter = await findNewsletter(user);
		assert.equal(newsletter.fromEmail, "hello@shared-news.mailcheapmail.com");
		const subdomain = "shared-news.mailcheapmail.com";
		assert.deepEqual(
			calls.findLast((call) => call.name === "createDomainIdentity").args,
			{ domain: subdomain, configurationSet: `mc-${user.accountId}`, mailFromDomain: `bounce.${subdomain}` }
		);
		assert.ok(state.associations.get(`mc-${user.accountId}`).has(`identity/${subdomain}`), "in the account's own tenant");
		const published = newsletter.sharedSender.dnsRecordIds.map((id) => dnsRecords.get(id));
		assert.deepEqual(
			published.map(({ slug, type, name, value }) => [slug, type, name, value]),
			[
				["shared-news", "CNAME", `tok1._domainkey.${subdomain}`, "tok1.dkim.amazonses.com"],
				["shared-news", "CNAME", `tok2._domainkey.${subdomain}`, "tok2.dkim.amazonses.com"],
				["shared-news", "CNAME", `tok3._domainkey.${subdomain}`, "tok3.dkim.amazonses.com"],
				["shared-news", "MX", `bounce.${subdomain}`, "10 feedback-smtp.us-east-1.amazonses.com"],
				["shared-news", "TXT", `bounce.${subdomain}`, "v=spf1 include:amazonses.com ~all"],
				["shared-news", "CNAME", subdomain, "cname.mailcheap.ai"],
			]
		);
		assert.deepEqual([newsletter.sharedSender.domain, newsletter.sharedSender.provider], [subdomain, "ses"]);

		const id = await draft(user);
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
		const email = sent.at(-1);
		assert.equal(email.from, "hello@shared-news.mailcheapmail.com");
		assert.equal(email.replyTo, "shared@example.com");
		assert.equal(email.tenantName, `mc-${user.accountId}`);
		assert.equal(email.configurationSet, `mc-${user.accountId}`);
		assert.match(email.html, /https:\/\/shared-news\.mailcheapmail\.com\/c\//, "tracked links on the shared subdomain");
		assert.match(email.headers["List-Unsubscribe"], /^<https:\/\/shared-news\.mailcheapmail\.com\/api\/unsubscribe\?token=/);
		assert.equal((await findNewsletter(user)).sharedSender.verified, true, "SES found the records");
	});

	test("the shared address follows the slug, its old subdomain goes, and it can't be another newsletter's", async () => {
		const user = await customer("slug-follow@example.com", "first-slug");
		const first = (await findNewsletter(user)).sharedSender;
		assert.equal((await saveFrom(user, "second-slug", "hello@first-slug.mailcheapmail.com")).ok, true);
		const newsletter = await findNewsletter(user);
		assert.equal(newsletter.fromEmail, "hello@second-slug.mailcheapmail.com");
		assert.equal(newsletter.sharedSender.domain, "second-slug.mailcheapmail.com");
		assert.equal(state.identities.has("first-slug.mailcheapmail.com"), false, "the old subdomain is free for anyone");
		assert.equal(state.associations.get(`mc-${user.accountId}`).has("identity/first-slug.mailcheapmail.com"), false);
		assert.ok(first.dnsRecordIds.every((recordId) => !dnsRecords.has(recordId)), "and so are its DNS records");
		assert.ok(state.identities.has("second-slug.mailcheapmail.com"));

		const other = await customer("slug-taker@example.com", "first-slug");
		assert.equal((await findNewsletter(other)).sharedSender.domain, "first-slug.mailcheapmail.com");
		assert.ok(state.associations.get(`mc-${other.accountId}`).has("identity/first-slug.mailcheapmail.com"), "in the new owner's tenant");
		assert.equal((await saveFrom(user, "second-slug", "hello@first-slug.mailcheapmail.com")).ok, true);
		assert.equal((await findNewsletter(user)).fromEmail, "hello@second-slug.mailcheapmail.com", "rewritten to its own");
	});

	test("before the provider's keys are in, the shared address waits without an alert; once they are, a failure alerts the admins", async () => {
		const alerts = () => platformEmails.filter(({ subject }) => subject === "[MailCheap] Shared address not set up").length;
		const before = { alerts: alerts(), calls: calls.length };
		const user = await withEnv({ SES_ACCESS_KEY_ID: "", SES_SECRET_ACCESS_KEY: "" }, () => customer("no-provider@example.com", "no-provider"));
		const waiting = await findNewsletter(user);
		assert.equal(waiting.fromEmail, "hello@no-provider.mailcheapmail.com", "saved with its shared address");
		assert.equal(waiting.sharedSender, null);
		assert.equal(calls.slice(before.calls).some(({ name }) => name === "createDomainIdentity"), false, "nothing tried at SES");
		assert.equal(alerts(), before.alerts, "no alert");

		assert.equal((await saveFrom(user, "no-provider", "hello@no-provider.mailcheapmail.com")).ok, true);
		assert.equal((await findNewsletter(user)).sharedSender.domain, "no-provider.mailcheapmail.com", "set up once the keys are in");

		state.failNext = { name: "createDomainIdentity", error: new Error("SES didn't answer") };
		const error = console.error;
		console.error = () => {};
		try {
			await customer("ses-down@example.com", "ses-down");
		} finally {
			console.error = error;
		}
		assert.equal(alerts(), before.alerts + 1);
	});

	test("a domain the account didn't add is refused at save and at delivery", async () => {
		const user = await customer("stranger@example.com", "stranger-news");
		assert.match((await saveFrom(user, "stranger-news", "hi@example.com")).error, /Add example.com on the Domains page first/);

		const id = await draft(user);
		await as(user, () => m.contacts.importContacts({ newsletterId: user.newsletterId, consent: true, rows: [{ email: "reader@example.org", status: "active" }] }));
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
		// Changed behind the dashboard's back: the send itself refuses it.
		await execute("UPDATE newsletters SET fromEmail = 'ceo@bigbank.com' WHERE accountId = ? AND _id = ?", [user.accountId, user.newsletterId]);
		const before = sent.length;
		await runJobs();
		assert.equal(sent.length, before, "nothing went out");
		const campaign = await getOne("SELECT * FROM campaigns WHERE accountId = ? AND _id = ?", [user.accountId, id]);
		assert.equal(campaign.status, "paused");
		assert.match(campaign.pauseReason, /bigbank.com isn't one of your domains/);
	});
});

describe("own domains", () => {
	test("adding a domain creates its identity in the tenant, with DKIM, a return path and an archive subdomain", async () => {
		const user = await customer("owner@example.com", "owner-news");
		const result = await as(user, () => m.domains.addDomainAction(null, form({ domain: "https://Owner-Mail.com/", archiveHost: "" })));
		assert.deepEqual(result, { ok: true, domain: "owner-mail.com" });

		const domain = await findDomain(user, "owner-mail.com");
		assert.equal(domain.mailFromDomain, "bounce.owner-mail.com");
		assert.equal(domain.archiveHost, "news.owner-mail.com");
		assert.equal(domain.verified, false);
		assert.equal(domain.records.filter(({ purpose }) => purpose === "dkim").length, 3);
		assert.deepEqual(
			calls.findLast((call) => call.name === "createDomainIdentity").args,
			{ domain: "owner-mail.com", configurationSet: `mc-${user.accountId}`, mailFromDomain: "bounce.owner-mail.com" }
		);
		assert.equal(state.identities.get("owner-mail.com").keyLength, "RSA_2048_BIT");
		assert.ok(state.associations.get(`mc-${user.accountId}`).has("identity/owner-mail.com"));

		// Saved before verification, but nothing sends from it until the records are in.
		assert.deepEqual((await saveFrom(user, "owner-news", "hi@owner-mail.com")).error, undefined);
		const id = await draft(user);
		assert.match((await as(user, () => m.campaigns.sendTestCampaign(id))).error, /owner-mail.com isn't verified yet/);

		state.identities.get("owner-mail.com").verified = true;
		cnames.set("news.owner-mail.com", ["cname.mailcheap.ai"]);
		assert.deepEqual(await as(user, () => m.domains.checkDomainAction(String(domain._id))), { ok: true, verified: true, archiveHostVerified: true });
		assert.equal((await findNewsletter(user)).archiveHost, "news.owner-mail.com");

		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
		const email = sent.at(-1);
		assert.equal(email.from, "hi@owner-mail.com");
		assert.equal(email.tenantName, `mc-${user.accountId}`);
		assert.match(email.html, /https:\/\/news\.owner-mail\.com\/c\//);
		assert.match(email.headers["List-Unsubscribe"], /^<https:\/\/news\.owner-mail\.com\/api\/unsubscribe/);
	});

	test("an address or a link pasted as the domain adds the domain alone, from the dashboard and the API", async () => {
		const user = await customer("paste@example.com", "paste-news");
		const pasted = await as(user, () => m.domains.addDomainAction(null, form({ domain: "Jane Doe <jane@Pasted-Mail.com>", archiveHost: "" })));
		assert.deepEqual(pasted, { ok: true, domain: "pasted-mail.com" });
		assert.equal((await findDomain(user, "pasted-mail.com")).archiveHost, "news.pasted-mail.com");
		assert.ok(state.identities.has("pasted-mail.com"), "added at the provider under the domain alone");

		const { key } = await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })));
		const linked = await callApi("POST", "/api/v1/domains", { key, body: { domain: "https://www.linked-mail.com/about", archiveHost: "letters.linked-mail.com" } });
		assert.equal(linked.status, 201);
		assert.deepEqual([linked.body.domain, linked.body.archiveHost], ["linked-mail.com", "letters.linked-mail.com"]);
		const plain = await callApi("POST", "/api/v1/domains", { key, body: { domain: "plain-mail.com" } });
		assert.deepEqual([plain.status, plain.body.domain, plain.body.archiveHost], [201, "plain-mail.com", "news.plain-mail.com"], "a plain domain, as before");
	});

	test("the Domains page switches the newsletter to a verified domain, with the same checks as its settings", async () => {
		const user = await customer("switch@example.com", "switch-news");
		const domain = await addVerifiedDomain(user, "switch-mail.com");
		assert.deepEqual(await switchTo(user, domain, "not valid"), { error: "From email is invalid" });
		assert.deepEqual(await switchTo(user, domain, " Jane "), { ok: true, fromEmail: "jane@switch-mail.com" });
		const newsletter = await findNewsletter(user);
		assert.deepEqual([newsletter.fromEmail, newsletter.archiveHost], ["jane@switch-mail.com", "news.switch-mail.com"], "its archive and links move too");
	});

	test("a domain still being verified, or another account's, can't be switched to", async () => {
		const user = await customer("switch-pending@example.com", "switch-pending");
		await as(user, () => m.domains.addDomainAction(null, form({ domain: "pending-mail.com" })));
		const pending = await findDomain(user, "pending-mail.com");
		assert.deepEqual(await switchTo(user, pending, "hi"), { error: "pending-mail.com isn't verified yet" });
		assert.equal((await findNewsletter(user)).fromEmail, "hello@switch-pending.mailcheapmail.com");

		const other = await customer("switch-other@example.com", "switch-other");
		const theirs = await addVerifiedDomain(other, "their-mail.com");
		assert.deepEqual(await switchTo(user, theirs, "hi"), { error: "Domain not found" });
	});

	test("a domain belongs to one account: a second one is refused", async () => {
		const first = await customer("first-owner@example.com", "first-owner");
		const second = await customer("second-owner@example.com", "second-owner");
		await addVerifiedDomain(first, "taken.com");
		const result = await as(second, () => m.domains.addDomainAction(null, form({ domain: "taken.com" })));
		assert.deepEqual(result, { error: "taken.com is used by another MailCheap account" });
		assert.match((await saveFrom(second, "second-owner", "hi@taken.com")).error, /Add taken.com on the Domains page first/);
		assert.equal(await getValue("SELECT count(*) FROM domains WHERE accountId = ?", [second.accountId]), 0);
		assert.deepEqual(await as(first, () => m.domains.addDomainAction(null, form({ domain: "taken.com" }))), { error: "taken.com is already added" });
	});

	test("another account's domain can't be checked or removed", async () => {
		const owner = await customer("guarded@example.com", "guarded");
		const attacker = await customer("attacker@example.com", "attacker");
		const domain = await addVerifiedDomain(owner, "guarded.com");
		assert.deepEqual(await as(attacker, () => m.domains.checkDomainAction(String(domain._id))), { error: "Domain not found" });
		assert.deepEqual(await as(attacker, () => m.domains.removeDomainAction(String(domain._id))), { error: "Domain not found" });
		assert.ok(await getValue("SELECT 1 FROM domains WHERE accountId = ? AND _id = ?", [owner.accountId, domain._id]));
	});

	test("a domain with a campaign on its way can't be removed; afterwards it goes everywhere", async () => {
		const user = await customer("remove@example.com", "remove-news");
		const domain = await addVerifiedDomain(user, "leaving.com");
		await saveFrom(user, "remove-news", "hi@leaving.com");
		const id = await draft(user);
		await execute("UPDATE campaigns SET status = 'scheduled', scheduledAt = ? WHERE accountId = ? AND _id = ?", [Date.now() + 3_600_000, user.accountId, id]);
		assert.match((await as(user, () => m.domains.removeDomainAction(String(domain._id)))).error, /A campaign is sending or scheduled from leaving.com/);

		await execute("UPDATE campaigns SET status = 'draft', scheduledAt = NULL WHERE accountId = ? AND _id = ?", [user.accountId, id]);
		assert.deepEqual(await as(user, () => m.domains.removeDomainAction(String(domain._id))), { ok: true, removed: "leaving.com" });
		assert.equal(state.identities.has("leaving.com"), false);
		assert.equal(state.associations.get(`mc-${user.accountId}`).has("identity/leaving.com"), false);
		assert.equal((await findNewsletter(user)).archiveHost, null);
		assert.match((await as(user, () => m.campaigns.sendTestCampaign(id))).error, /leaving.com isn't one of your domains/);
	});
});

describe("hosts", () => {
	test("each host resolves to its newsletter; the app host and unknown hosts don't", async () => {
		const user = await customer("hosts@example.com", "hosts-news");
		await addVerifiedDomain(user, "hosts.dev", { archiveHost: "letters.hosts.dev" });
		await saveFrom(user, "hosts-news", "hi@hosts.dev");
		const resolve = m.hostRouting.resolveArchiveHost;
		assert.deepEqual(await resolve("hosts-news.mailcheapmail.com"), { isArchiveHost: true, slug: "hosts-news" });
		assert.deepEqual(await resolve("Letters.Hosts.dev:443"), { isArchiveHost: true, slug: "hosts-news" });
		assert.deepEqual(await resolve("unknown.example.net"), { isArchiveHost: true, slug: null });
		assert.deepEqual(await resolve("localhost:3000"), { isArchiveHost: false, slug: null });

		// Unsubscribe and tracking keep working after the plan ends.
		await execute("UPDATE accounts SET subscriptionStatus = 'canceled' WHERE _id = ?", [user.accountId]);
		assert.deepEqual(await resolve("hosts-news.mailcheapmail.com"), { isArchiveHost: true, slug: "hosts-news" });
	});
});
