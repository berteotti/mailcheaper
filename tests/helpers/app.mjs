import assert from "node:assert/strict";
import { execute, getOne, json } from "../../lib/db.js";
import { runWithRequest } from "../stubs/next-headers.mjs";
import { NotFoundError, RedirectError } from "../stubs/next-navigation.mjs";
import { env as bindings } from "./bindings.mjs";
import { createDatabase } from "./d1.mjs";

// Platform emails sent through Resend's API, newest last.
export const platformEmails = [];
// Platform emails sent through Cloudflare Email Service's API, with the account and token, newest last.
export const cloudflareEmails = [];
let stripeHandler = null;
let visitor = 0;

// No test talks to the network: Resend and Cloudflare Email Service are recorded and Stripe answers from mockStripe's handler.
function installFetch() {
	globalThis.fetch = async (input, init = {}) => {
		const url = String(input?.url ?? input);
		if (url === "https://api.resend.com/emails") {
			platformEmails.push(JSON.parse(init.body));
			return Response.json({ id: `email_${platformEmails.length}` });
		}
		const cloudflare = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([^/]+)\/email\/sending\/send$/.exec(url);
		if (cloudflare) {
			const body = JSON.parse(init.body);
			cloudflareEmails.push({ accountId: cloudflare[1], authorization: init.headers.Authorization, body });
			return Response.json({ success: true, errors: [], messages: [], result: { message_id: `cf_${cloudflareEmails.length}`, delivered: body.to, queued: [], permanent_bounces: [] } });
		}
		if (url.startsWith("https://api.stripe.com/")) {
			if (!stripeHandler) throw new Error(`Unexpected Stripe request: ${init.method ?? "GET"} ${url}`);
			const { pathname, searchParams } = new URL(url);
			const body = new URLSearchParams(typeof init.body === "string" ? init.body : "");
			const result = await stripeHandler({ method: init.method ?? "GET", path: pathname, query: searchParams, body });
			return Response.json(result?.error ? { error: result.error } : result, {
				status: result?.error ? (result.status ?? 400) : 200,
				headers: { "request-id": "req_test" },
			});
		}
		throw new Error(`Unexpected request to ${url}`);
	};
}

export function mockStripe(handler) {
	stripeHandler = handler;
}

// An in-memory R2 bucket: objects by key, with their HTTP metadata.
export function memoryBucket() {
	const objects = new Map();
	return {
		objects,
		async put(key, value, options = {}) {
			const body = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value instanceof ArrayBuffer ? value : await new Response(value).arrayBuffer());
			objects.set(key, { key, body, httpMetadata: options.httpMetadata ?? {}, size: body.byteLength });
			return { key };
		},
		async get(key) {
			const object = objects.get(key);
			return object ? { ...object, arrayBuffer: async () => object.body.buffer, text: async () => new TextDecoder().decode(object.body) } : null;
		},
		async head(key) {
			return objects.get(key) ?? null;
		},
		async delete(keys) {
			for (const key of [keys].flat()) objects.delete(key);
		},
		async list({ prefix = "" } = {}) {
			return { objects: [...objects.values()].filter(({ key }) => key.startsWith(prefix)), truncated: false };
		},
	};
}

// The jobs queue: published job ids, newest last. Tests run jobs by calling the consumer's code.
export const queued = [];

// MailCheap Cloud by default; a self-hosted server with { MAILCHEAP_CLOUD: "" }.
export async function startTestApp(env = {}) {
	const db = createDatabase();
	Object.assign(bindings, {
		ASSETS_BUCKET: memoryBucket(),
		BACKUPS_BUCKET: memoryBucket(),
		JOBS_QUEUE: {
			async send(body) { queued.push(body); },
			async sendBatch(messages) { queued.push(...messages.map(({ body }) => body)); },
		},
	});
	Object.assign(process.env, {
		NODE_ENV: "test",
		MAILCHEAP_CLOUD: "true",
		BETTER_AUTH_SECRET: "test-secret-for-integration-tests-0123456789",
		APP_URL: "http://localhost:3000",
		RESEND_API_KEY: "re_test",
		SENDING_ENABLED: "true",
		SEND_RATE_PER_SECOND: "14",
		STRIPE_SECRET_KEY: "sk_test_mailcheap",
		STRIPE_WEBHOOK_SECRET: "whsec_test_mailcheap",
		ADMIN_EMAILS: "admin@example.com",
		SHARED_DOMAIN: "mailcheapmail.com",
		ARCHIVE_CNAME_TARGET: "cname.mailcheap.ai",
		SES_AWS_ACCOUNT_ID: "111122223333",
		SES_ACCESS_KEY_ID: "test-ses-key-id",
		SES_SECRET_ACCESS_KEY: "test-ses-secret",
		...env,
	});
	installFetch();
	return { db, stop: async () => db.close() };
}

export function findAccount(accountId) {
	return getOne("SELECT * FROM accounts WHERE _id = ?", [String(accountId)]);
}

// Runs code with some environment variables changed, and puts them back after.
export async function withEnv(values, run) {
	const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	Object.assign(process.env, values);
	try {
		return await run();
	} finally {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

export function form(fields) {
	const data = new FormData();
	for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
	return data;
}

export async function catchRedirect(promise) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof RedirectError) return error.url;
		throw error;
	}
	throw new Error("Expected a redirect");
}

export async function catchNotFound(promise) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof NotFoundError) return true;
		throw error;
	}
	return false;
}

// Runs code as the signed-in user: their cookies go with the request, and new ones land in their jar.
export function as(user, run) {
	return runWithRequest({ jar: user.jar, headers: { "x-forwarded-for": user.ip } }, run);
}

export function anonymous(run) {
	return runWithRequest({ jar: new Map() }, run);
}

// The real sign-in: a code by email (through the Resend API), then the code.
export async function signIn(email) {
	const { sendSigninCode, verifySigninCode } = await import("../../app/signin/actions.js");
	const user = { email, jar: new Map(), ip: `198.51.100.${++visitor}` };
	const sent = await as(user, () => sendSigninCode(null, form({ email })));
	assert.deepEqual(sent, { email: email.toLowerCase() });
	const { subject } = platformEmails.findLast(({ to }) => to.includes(email.toLowerCase()));
	const code = subject.slice(0, 6);
	assert.equal(await as(user, () => catchRedirect(verifySigninCode(null, form({ email, code, next: "/" })))), "/");

	const stored = await getOne("SELECT id FROM users WHERE email = ?", [email.toLowerCase()]);
	user.userId = stored.id;
	// Past its first 30 days of sending, so sends go out at full speed; tests of spread sends unset it. Someone invited
	// has no account until they join.
	const byMember = "SELECT a.* FROM accounts a JOIN members m ON m.organizationId = a.organizationId WHERE m.userId = ?";
	await execute(`UPDATE accounts SET spreadUntil = 0 WHERE _id IN (SELECT _id FROM (${byMember}))`, [stored.id]);
	user.account = await getOne(byMember, [stored.id]);
	user.accountId = user.account?._id;
	return user;
}

// What the Stripe webhook writes for a paid subscription.
export async function activate(user, { plan = "starter", interval = "month", ...set } = {}) {
	const { addMonths, startUsagePeriod } = await import("../../lib/usage-period.js");
	const start = new Date();
	const end = addMonths(start, interval === "year" ? 12 : 1);
	const values = {
		plan,
		interval,
		subscriptionStatus: "active",
		stripeCustomerId: `cus_${user.accountId}`,
		stripeSubscriptionId: `sub_${user.accountId}`,
		currentPeriodStart: start,
		currentPeriodEnd: end,
		usage: startUsagePeriod({ start, end }),
		...set,
	};
	const columns = Object.keys(values);
	await execute(`UPDATE accounts SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE _id = ?`, [
		...columns.map((column) => (values[column] && typeof values[column] === "object" && !(values[column] instanceof Date) ? json(values[column]) : values[column])),
		user.accountId,
	]);
	user.account = await findAccount(user.accountId);
	return user.account;
}

// A domain added through the Domains page, with its DNS records in and its archive subdomain pointed at us.
export async function addVerifiedDomain(user, domain, { archiveHost = `news.${domain}`, isArchiveLive = true } = {}) {
	const { addDomain, checkDomain } = await import("../../lib/domains.js");
	const { verifyIdentity } = await import("../stubs/ses.mjs");
	const { cnames } = await import("../stubs/dns-check.mjs");
	const account = await findAccount(user.accountId);
	const added = await addDomain({ account, domain, archiveHost });
	verifyIdentity(domain);
	if (isArchiveLive) cnames.set(archiveHost, ["cname.mailcheap.ai"]);
	user.account = await findAccount(user.accountId);
	return checkDomain({ account: user.account, domainId: added._id });
}

export function jsonRequest(url, { method = "GET", body, headers = {} } = {}) {
	return new Request(new URL(url, "http://localhost:3000"), {
		method,
		headers: { ...(body !== undefined && { "content-type": "application/json" }), ...headers },
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
}

// A request to /api/v1 through its route handler, as Next.js routes it: the path after /api/v1 as params.
export async function callApi(method, path, { key, body, headers = {}, jar = new Map() } = {}) {
	const route = await import("../../app/api/v1/[...path]/route.js");
	const url = new URL(path, "http://localhost:3000");
	const segments = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
	const request = jsonRequest(`${url.pathname}${url.search}`, {
		method,
		body,
		headers: { ...(key && { authorization: `Bearer ${key}` }), ...headers },
	});
	const response = await runWithRequest({ jar }, () => route[method](request, { params: Promise.resolve({ path: segments }) }));
	return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
}
