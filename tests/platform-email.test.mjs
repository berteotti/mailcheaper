import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { activate, addVerifiedDomain, as, catchRedirect, form, platformEmails, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { POSTSHIBA, POSTSHIBA_ENV, createFakePostshiba } from "./helpers/postshiba.mjs";
import { platformSent, sent as sesEmails } from "./stubs/ses.mjs";

// Who carries MailCheap's own emails (sign-in codes, alerts): on MailCheap Cloud always Resend, never the
// email provider; on a self-hosted server Resend when it's set up, else the provider. Customers' emails
// (issues, welcome, confirmation, last-chance, tests) always go through the provider.
const SELF_HOSTED = { MAILCHEAP_CLOUD: "", EMAIL_FROM: "MailCheap <login@mail.selfhost.dev>" };
const CODE_SUBJECT = /^\d{6} is your MailCheap code$/;

let app;
let fake;
let m;
let visitors = 0;

function requestCode(email) {
	const visitor = { jar: new Map(), ip: `203.0.113.${++visitors}` };
	return as(visitor, () => m.signin.sendSigninCode(null, form({ email })));
}

// What the server logged on the way, without printing it.
async function capturingErrors(run) {
	const logged = [];
	const error = console.error;
	console.error = (...args) => logged.push(args.join(" "));
	try {
		return { result: await run(), logged: logged.join("\n") };
	} finally {
		console.error = error;
	}
}

function counts() {
	return { resend: platformEmails.length, ses: platformSent.length, postshiba: fake.state.sends.length, customer: sesEmails.length };
}

function added(before) {
	const now = counts();
	return Object.fromEntries(Object.entries(now).map(([key, value]) => [key, value - before[key]]));
}

before(async () => {
	app = await startTestApp({ ADMIN_EMAILS: "admin@example.com" });
	fake = createFakePostshiba();
	fake.install();
	m = {
		signin: await import("../app/signin/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		alerts: await import("../lib/alerts.js"),
		platform: await import("../lib/platform-email.js"),
	};
});

after(() => app?.stop());

describe("MailCheap Cloud", () => {
	test("sign-in codes and alerts go through Resend, never through the email provider, even with SES or PostShiba set up", async () => {
		const before = counts();
		assert.deepEqual(await requestCode("cloud@example.com"), { email: "cloud@example.com" });
		await m.alerts.sendAlert({ accountId: null, key: "cloud-split", title: "Cloud alert", detail: "For the admins" });
		await withEnv(POSTSHIBA_ENV, async () => assert.deepEqual(await requestCode("cloud-ps@example.com"), { email: "cloud-ps@example.com" }));
		assert.deepEqual(added(before), { resend: 3, ses: 0, postshiba: 0, customer: 0 });
		assert.deepEqual(platformEmails.at(-3).to, ["cloud@example.com"]);
		assert.equal(platformEmails.at(-3).from, "MailCheap <hello@r.mailcheap.ai>", "from a subdomain, apart from mailcheap.ai");
		assert.equal(platformEmails.at(-3).reply_to, "hello@mailcheap.ai", "replies reach support");
		assert.deepEqual(platformEmails.at(-2).to, ["admin@example.com"]);
		assert.equal(platformEmails.at(-2).subject, "[MailCheap] Cloud alert");
	});

	test("without RESEND_API_KEY nothing goes out: the cloud never falls back to the email provider", async () => {
		const before = counts();
		await withEnv({ RESEND_API_KEY: "" }, async () => {
			const { result, logged } = await capturingErrors(() => requestCode("no-resend@example.com"));
			assert.equal(result.error, "Couldn't send the code. Try again in a minute.");
			assert.match(logged, /RESEND_API_KEY is not set: MailCheap Cloud sends its own emails through Resend only/);
			assert.equal(m.platform.canSendPlatformEmail(), false, "alerts stay in the logs");
			await m.alerts.sendAlert({ accountId: null, key: "cloud-no-resend", title: "Unsent", detail: "Logged only" });
		});
		assert.deepEqual(added(before), { resend: 0, ses: 0, postshiba: 0, customer: 0 });
	});

	test("a customer's test email goes through the email provider, not Resend", async () => {
		const user = await signIn("customer@example.com");
		await activate(user);
		await addVerifiedDomain(user, "customer-news.dev");
		const url = await as(user, () =>
			catchRedirect(m.newsletters.saveNewsletter(null, form({ name: "News", slug: "customer-news", fromName: "Jo", fromEmail: "hello@customer-news.dev", postalAddress: "1 Main St, Paris" })))
		);
		const draftUrl = await as(user, () => catchRedirect(m.campaigns.createCampaign(url.split("/").at(-1))));
		const id = draftUrl.split("/").at(-1);
		await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "This week", body: "<p>Hello</p>" }));

		const before = counts();
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
		assert.deepEqual(added(before), { resend: 0, ses: 0, postshiba: 0, customer: 1 });
		assert.equal(sesEmails.at(-1).tenantName, `mc-${user.accountId}`, "in the account's own tenant");
		assert.equal(sesEmails.at(-1).subject, "[Test] Issue");
	});
});

describe("self-hosted server", () => {
	test("with RESEND_API_KEY, Resend sends them from EMAIL_FROM", async () => {
		const before = counts();
		await withEnv({ ...SELF_HOSTED, ALLOWED_EMAILS: "self-resend@example.com" }, async () => {
			assert.deepEqual(await requestCode("self-resend@example.com"), { email: "self-resend@example.com" });
		});
		assert.deepEqual(added(before), { resend: 1, ses: 0, postshiba: 0, customer: 0 });
		assert.equal(platformEmails.at(-1).from, "MailCheap <login@mail.selfhost.dev>");
		assert.equal(platformEmails.at(-1).reply_to, undefined, "no MailCheap support address on a self-hosted server");
	});

	test("without it, codes and alerts go through SES outside every tenant, even with sending off", async () => {
		const before = counts();
		await withEnv({ ...SELF_HOSTED, RESEND_API_KEY: "", SENDING_ENABLED: "false", ALLOWED_EMAILS: "self-ses@example.com" }, async () => {
			assert.deepEqual(await requestCode("self-ses@example.com"), { email: "self-ses@example.com" });
			await m.alerts.sendAlert({ accountId: null, key: "self-ses", title: "Self-hosted alert", detail: "For the admins" });
		});
		assert.deepEqual(added(before), { resend: 0, ses: 2, postshiba: 0, customer: 0 });
		const [code, alert] = platformSent.slice(-2);
		assert.deepEqual([code.from, code.to, code.tenantName, code.configurationSet], ["MailCheap <login@mail.selfhost.dev>", "self-ses@example.com", undefined, undefined]);
		assert.match(code.subject, CODE_SUBJECT);
		assert.deepEqual([alert.to, alert.subject], ["admin@example.com", "[MailCheap] Self-hosted alert"]);
	});

	test("without it on PostShiba, a tenant of their own sends them once EMAIL_FROM's domain is verified there", async () => {
		const env = { ...SELF_HOSTED, ...POSTSHIBA_ENV, RESEND_API_KEY: "", ALLOWED_EMAILS: "self-ps@example.com" };
		await withEnv(env, async () => {
			const { result, logged } = await capturingErrors(() => requestCode("self-ps@example.com"));
			assert.equal(result.error, "Couldn't send the code. Try again in a minute.");
			assert.match(logged, /PostShiba can't send from mail\.selfhost\.dev yet: add CNAME ps1\._domainkey\.mail\.selfhost\.dev \S+ and CNAME rp\.mail\.selfhost\.dev \S+ to its DNS/);

			const tenants = [...fake.state.tenants.values()].filter(({ slug }) => slug === "mc-platform");
			assert.equal(tenants.length, 1);
			const credentials = () => [...fake.state.credentials.values()].filter((credential) => credential.tenant_id === tenants[0].id);
			assert.deepEqual(credentials().map(({ cluster_id }) => cluster_id), [POSTSHIBA.transactionalClusterId]);
			assert.equal([...fake.state.domains.values()].find(({ name }) => name === "mail.selfhost.dev").tenant_id, tenants[0].id);

			fake.verifyDomain("mail.selfhost.dev");
			const before = counts();
			assert.deepEqual(await requestCode("self-ps@example.com"), { email: "self-ps@example.com" });
			assert.deepEqual(added(before), { resend: 0, ses: 0, postshiba: 1, customer: 0 });
			const { clusterId, body } = fake.state.sends.at(-1);
			assert.equal(clusterId, POSTSHIBA.transactionalClusterId);
			assert.deepEqual([body.tenant, body.from, body.to], [tenants[0].id, "MailCheap <login@mail.selfhost.dev>", ["self-ps@example.com"]]);
			assert.match(body.subject, CODE_SUBJECT);
			assert.deepEqual(body.unique_args, { kind: "platform" });
			assert.equal(credentials().length, 1, "the credential is made once");
			assert.equal([...fake.state.tenants.values()].filter(({ slug }) => slug === "mc-platform").length, 1);
		});
	});

	test("without EMAIL_FROM, or without Resend and a provider, nothing is sent and alerts are only logged", async () => {
		const before = counts();
		await withEnv({ ...SELF_HOSTED, EMAIL_FROM: "", ALLOWED_EMAILS: "no-from@example.com" }, async () => {
			const { result, logged } = await capturingErrors(() => requestCode("no-from@example.com"));
			assert.equal(result.error, "Couldn't send the code. Try again in a minute.");
			assert.match(logged, /EMAIL_FROM is not set/);
			assert.equal(m.platform.canSendPlatformEmail(), false);
		});
		await withEnv({ ...SELF_HOSTED, RESEND_API_KEY: "", SES_ACCESS_KEY_ID: "" }, async () => {
			assert.equal(m.platform.canSendPlatformEmail(), false);
			await m.alerts.sendAlert({ accountId: null, key: "self-nothing", title: "Nowhere to go", detail: "Logged only" });
		});
		assert.deepEqual(added(before), { resend: 0, ses: 0, postshiba: 0, customer: 0 });
	});
});
