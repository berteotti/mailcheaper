import assert from "node:assert/strict";
import { test } from "node:test";
import { getAdminEmails, getConfigProblems, getPlatformEmailService, getRateLimitOverrides, isEmailAllowed } from "../lib/config.js";
import { register } from "../instrumentation.js";

const STRONG = { BETTER_AUTH_SECRET: "s".repeat(32) };
const CLOUD = { ...STRONG, MAILCHEAP_CLOUD: "true", STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x", RESEND_API_KEY: "re_x" };
const CLOUDFLARE = { CLOUDFLARE_EMAIL_API_TOKEN: "cf_x", CLOUDFLARE_EMAIL_ACCOUNT_ID: "0123456789abcdef" };

async function withEnv(values, run) {
	const previous = { ...process.env };
	try {
		for (const name of ["MAILCHEAP_CLOUD", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY"]) delete process.env[name];
		Object.assign(process.env, values);
		return await run();
	} finally {
		process.env = previous;
	}
}

test("BETTER_AUTH_SECRET needs 32 characters", () => {
	assert.deepEqual(getConfigProblems(STRONG), []);
	assert.match(getConfigProblems({ BETTER_AUTH_SECRET: "s".repeat(31) }).join(), /BETTER_AUTH_SECRET must be at least 32/);
	assert.equal(getConfigProblems({}).length, 1, "missing counts as too short");
});

test("the server doesn't start with a short secret", () =>
	withEnv(STRONG, () => {
		assert.doesNotThrow(register);
		process.env.BETTER_AUTH_SECRET = "short";
		assert.throws(register, /MailCheap can't start\. BETTER_AUTH_SECRET must be at least 32 characters/);
	}));

test("MailCheap Cloud needs both Stripe keys and Resend or Cloudflare; a self-hosted server needs none of them", () => {
	assert.deepEqual(getConfigProblems(CLOUD), []);
	for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) {
		const problems = getConfigProblems({ ...CLOUD, [name]: " " });
		assert.equal(problems.length, 1, name);
		assert.match(problems[0], new RegExp(`MAILCHEAP_CLOUD is true, so ${name} has to be set`));
	}
	assert.deepEqual(getConfigProblems({ ...CLOUD, ...CLOUDFLARE, RESEND_API_KEY: "" }), [], "Cloudflare instead of Resend");
	assert.match(
		getConfigProblems({ ...CLOUD, RESEND_API_KEY: " ", CLOUDFLARE_EMAIL_API_TOKEN: "cf_x" })[0],
		/RESEND_API_KEY, or CLOUDFLARE_EMAIL_API_TOKEN and CLOUDFLARE_EMAIL_ACCOUNT_ID, have to be set/,
		"a token without its account isn't enough"
	);
	assert.match(getConfigProblems({ ...CLOUD, PLATFORM_EMAIL_PROVIDER: "cloudflare" })[0], /PLATFORM_EMAIL_PROVIDER is cloudflare, but CLOUDFLARE_EMAIL_API_TOKEN and CLOUDFLARE_EMAIL_ACCOUNT_ID are not set/);
	assert.match(getConfigProblems({ ...CLOUD, PLATFORM_EMAIL_PROVIDER: "mailgun" })[0], /PLATFORM_EMAIL_PROVIDER must be resend or cloudflare, not "mailgun"/);
	const problems = getConfigProblems({ ...STRONG, MAILCHEAP_CLOUD: "true" });
	assert.match(problems[0], /so STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET have to be set: the cloud bills through Stripe/);
	assert.match(problems[1], /sends its own emails through Resend or Cloudflare Email Service/);
	assert.deepEqual(getConfigProblems(STRONG), [], "self-hosted: no Stripe, no Resend");
	assert.deepEqual(getConfigProblems({ ...STRONG, MAILCHEAP_CLOUD: "yes" }), [], "only exactly true is the cloud");
});

test("Resend or Cloudflare, whichever has its keys; PLATFORM_EMAIL_PROVIDER picks when both do", () => {
	const both = { RESEND_API_KEY: "re_x", ...CLOUDFLARE };
	assert.deepEqual(getPlatformEmailService({}), { service: null });
	assert.deepEqual(getPlatformEmailService({ RESEND_API_KEY: "re_x" }), { service: "resend" });
	assert.deepEqual(getPlatformEmailService(CLOUDFLARE), { service: "cloudflare" });
	assert.deepEqual(getPlatformEmailService({ CLOUDFLARE_EMAIL_API_TOKEN: "cf_x" }), { service: null }, "a token without its account");
	assert.deepEqual(getPlatformEmailService(both), { service: "resend" });
	assert.deepEqual(getPlatformEmailService({ ...both, PLATFORM_EMAIL_PROVIDER: " Cloudflare " }), { service: "cloudflare" });
	assert.deepEqual(getPlatformEmailService({ ...both, PLATFORM_EMAIL_PROVIDER: "resend" }), { service: "resend" });
	assert.match(getPlatformEmailService({ RESEND_API_KEY: "re_x", PLATFORM_EMAIL_PROVIDER: "cloudflare" }).problem, /CLOUDFLARE_EMAIL_API_TOKEN and CLOUDFLARE_EMAIL_ACCOUNT_ID are not set/);
	assert.match(getPlatformEmailService({ ...CLOUDFLARE, PLATFORM_EMAIL_PROVIDER: "resend" }).problem, /RESEND_API_KEY is not set/);
	assert.match(getPlatformEmailService({ ...both, PLATFORM_EMAIL_PROVIDER: "ses" }).problem, /must be resend or cloudflare, not "ses"/);
});

test("the cloud refuses to start without Stripe or Resend, and its health check fails with the reason", async () => {
	const { GET } = await import("../app/api/health/route.js");
	await withEnv(CLOUD, async () => {
		assert.doesNotThrow(register);
		const healthy = await GET();
		assert.equal(healthy.status, 200);
		assert.deepEqual(await healthy.json(), { ok: true });
		assert.equal(healthy.headers.get("cache-control"), "no-store");

		delete process.env.STRIPE_SECRET_KEY;
		assert.throws(register, /MailCheap can't start\. MAILCHEAP_CLOUD is true, so STRIPE_SECRET_KEY has to be set/);
		const failing = await GET();
		assert.equal(failing.status, 503);
		const body = await failing.json();
		assert.equal(body.ok, false);
		assert.match(body.problems[0], /STRIPE_SECRET_KEY has to be set/);
		assert.equal(JSON.stringify(body).includes("whsec_x") || JSON.stringify(body).includes("re_x"), false, "never a value");
	});
});

test("a self-hosted server signs in ALLOWED_EMAILS, its @domains and ADMIN_EMAILS, and nobody when both are empty", () => {
	const env = { ALLOWED_EMAILS: " Jane@Example.com, @Team.example.org ,", ADMIN_EMAILS: "ops@example.net" };
	for (const email of ["jane@example.com", "JANE@example.com ", "anyone@team.example.org", "ops@example.net"]) {
		assert.equal(isEmailAllowed(email, env), true, email);
	}
	for (const email of ["john@example.com", "x@sub.team.example.org", "team.example.org@evil.dev", "@team.example.org", "jane@example.com.evil.dev", "jane@", "", null]) {
		assert.equal(isEmailAllowed(email, env), false, String(email));
	}
	assert.equal(isEmailAllowed("jane@example.com", {}), false, "never open by default");
	assert.equal(isEmailAllowed("anyone@anywhere.dev", { MAILCHEAP_CLOUD: "true" }), true, "MailCheap Cloud takes anyone");
});

test("ADMIN_EMAILS is a comma-separated list, trimmed and lowercased", () => {
	const previous = process.env.ADMIN_EMAILS;
	try {
		process.env.ADMIN_EMAILS = " Owner@Example.com, ops@example.org ,,";
		assert.deepEqual(getAdminEmails(), ["owner@example.com", "ops@example.org"]);
		delete process.env.ADMIN_EMAILS;
		assert.deepEqual(getAdminEmails(), []);
	} finally {
		if (previous === undefined) delete process.env.ADMIN_EMAILS;
		else process.env.ADMIN_EMAILS = previous;
	}
});

test("RATE_LIMITS sets actions' limits by name, and ignores what isn't a whole number above 0", () => {
	const overrides = getRateLimitOverrides({ RATE_LIMITS: " Add_Domain = 50, send_test_email=100, upload_image=0, create_api_key=ten, check_domain=2.5, =4, list_domains" });
	assert.deepEqual([...overrides], [["add_domain", 50], ["send_test_email", 100]]);
	assert.equal(getRateLimitOverrides({}).size, 0);
});
