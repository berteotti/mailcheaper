import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getOne } from "../lib/db.js";
import { activate, anonymous, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { dnsRecords } from "./stubs/dns-broker.mjs";
import { state } from "./stubs/ses.mjs";

// An account gets each action's limit once: its API keys and connected apps count on their own and against it,
// with the dashboard. More keys don't help either: an account has up to 20 active ones. Its newsletters' slugs,
// which move their shared addresses at the provider and in DNS, change 3 times a day.
let app;
let m;
let nextId = 0;

before(async () => {
	app = await startTestApp();
	m = {
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		mcpRoute: await import("../app/mcp/route.js"),
	};
});

after(() => app?.stop());

// A paying account with a newsletter on the shared address, named after the email, and a full access key.
async function customer(email) {
	const user = await signIn(email);
	await activate(user);
	const slug = email.split("@")[0];
	const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St, Paris" }))));
	user.newsletterId = url.split("/").at(-1);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	return user;
}

async function draft(user) {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const id = url.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "This week", body: "<p>Hello</p>" }));
	return id;
}

// A tool call on /mcp with an API key: the tool's output, or { error } as MCP clients read it.
async function callTool(key, name, args = {}) {
	const request = new Request("http://localhost:3000/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
			authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args }, id: ++nextId }),
	});
	const text = await (await anonymous(() => m.mcpRoute.POST(request))).text();
	const { result } = JSON.parse(text.split("\n").find((line) => line.startsWith("data: ")).slice(6));
	return result.isError ? JSON.parse(result.content[0].text) : result.structuredContent;
}

async function repeat(times, run) {
	for (let index = 0; index < times; index++) await run(index);
}

describe("keys", () => {
	test("more keys don't raise a limit: a key, the key it made, REST, MCP and the dashboard share the account's 30 test emails an hour", async () => {
		const user = await customer("two-keys@example.com");
		const id = await draft(user);
		const made = await callApi("POST", "/api/v1/api-keys", { key: user.key, body: { name: "Made by a key", level: "full" } });
		assert.equal(made.status, 201, "keys can make keys");
		const second = made.body.key;
		const testEmail = (key) => callApi("POST", `/api/v1/campaigns/${id}/test`, { key });

		await repeat(15, async (index) => assert.equal((await testEmail(user.key)).status, 200, `first key ${index}`));
		await repeat(10, async (index) => assert.equal((await testEmail(second)).status, 200, `second key ${index}`));
		await repeat(4, async (index) => assert.equal((await callTool(second, "send_test_email", { id })).sentTo, "two-keys@example.com", `MCP ${index}`));
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true }, "the 30th, from the dashboard");

		const onAccount = { code: "rate_limited", message: "Too many send_test_email calls on this account, try again later" };
		assert.deepEqual((await testEmail(user.key)).body.error, onAccount);
		assert.deepEqual((await testEmail(second)).body.error, onAccount);
		assert.deepEqual(await callTool(second, "send_test_email", { id }), { error: onAccount });
		const another = await callApi("POST", "/api/v1/api-keys", { key: second, body: { name: "And another", level: "full" } });
		assert.deepEqual((await testEmail(another.body.key)).body.error, onAccount, "a new key gets nothing more");
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { error: "You can send a test email 30 times an hour. Try again later." });
	});

	test("a key alone still stops at its own limit, and each account counts on its own", async () => {
		const user = await customer("one-key@example.com");
		const id = await draft(user);
		await repeat(30, async (index) => assert.equal((await callApi("POST", `/api/v1/campaigns/${id}/test`, { key: user.key })).status, 200, String(index)));
		const limited = await callApi("POST", `/api/v1/campaigns/${id}/test`, { key: user.key });
		assert.deepEqual([limited.status, limited.body.error.message], [429, "Too many send_test_email calls, try again later"]);

		const other = await customer("next-door@example.com");
		const otherId = await draft(other);
		assert.equal((await callApi("POST", `/api/v1/campaigns/${otherId}/test`, { key: other.key })).status, 200);
	});

	test("an account has up to 20 active keys, made anywhere, and a revoked one makes room", async () => {
		const user = await customer("many-keys@example.com");
		await repeat(19, async (index) => {
			assert.ok((await as(user, () => m.apiKeys.createApiKey(null, form({ name: `Key ${index}`, level: "signups" })))).key, String(index));
		});
		const capped = "An account has up to 20 active API keys. Revoke one to create another.";
		assert.deepEqual(await as(user, () => m.apiKeys.createApiKey(null, form({ name: "One too many", level: "full" }))), { error: capped });
		const viaApi = await callApi("POST", "/api/v1/api-keys", { key: user.key, body: { name: "One too many", level: "full" } });
		assert.deepEqual([viaApi.status, viaApi.body.error], [409, { code: "conflict", message: capped }]);
		assert.deepEqual(await callTool(user.key, "create_api_key", { name: "One too many", level: "full" }), { error: { code: "conflict", message: capped } });

		const { apiKeys } = await callTool(user.key, "list_api_keys");
		assert.equal(apiKeys.length, 20);
		assert.deepEqual(await as(user, () => m.apiKeys.revokeApiKey(apiKeys.find(({ isCurrent }) => !isCurrent).id)), { ok: true });
		assert.equal((await callApi("POST", "/api/v1/api-keys", { key: user.key, body: { name: "In its place", level: "signups" } })).status, 201, "revoked keys don't count");
		assert.deepEqual(await as(user, () => m.apiKeys.createApiKey(null, form({ name: "One too many", level: "full" }))), { error: capped });
	});
});

describe("slugs", () => {
	test("an account changes slugs 3 times a day, on the dashboard, the REST API and MCP alike, and its shared address follows", async () => {
		const user = await customer("slug-a@example.com");
		await customer("slug-taken@example.com");
		const save = (fields) =>
			as(user, () => m.newsletters.saveNewsletter(null, form({ id: user.newsletterId, name: "Slugs", postalAddress: "1 Main St, Paris", ...fields })));
		const patch = (body) => callApi("PATCH", `/api/v1/newsletters/${user.newsletterId}`, { key: user.key, body });

		assert.deepEqual(await save({ slug: "slug-taken" }), { error: "This slug is already used" }, "a slug another newsletter has doesn't count");
		assert.equal((await save({ slug: "slug-b" })).ok, true, "1, the dashboard");
		assert.equal((await patch({ slug: "slug-c" })).status, 200, "2, the REST API");
		assert.equal((await callTool(user.key, "update_newsletter", { id: user.newsletterId, slug: "slug-d" })).slug, "slug-d", "3, MCP");

		const limited = "You can change slugs 3 times a day. Try again later.";
		assert.deepEqual(await save({ slug: "slug-e" }), { error: limited });
		const refused = await patch({ slug: "slug-e" });
		assert.deepEqual([refused.status, refused.body.error], [429, { code: "rate_limited", message: limited }]);
		assert.deepEqual(await callTool(user.key, "update_newsletter", { id: user.newsletterId, slug: "slug-e" }), { error: { code: "rate_limited", message: limited } });

		const newsletter = await getOne("SELECT * FROM newsletters WHERE accountId = ? AND _id = ?", [user.accountId, user.newsletterId]);
		assert.deepEqual([newsletter.slug, newsletter.fromEmail, newsletter.sharedSender.domain], ["slug-d", "hello@slug-d.mailcheapmail.com", "slug-d.mailcheapmail.com"]);
		for (const slug of ["slug-a", "slug-b", "slug-c"]) {
			assert.equal(state.identities.has(`${slug}.mailcheapmail.com`), false, slug);
			assert.ok(![...dnsRecords.values()].some(({ name }) => name.endsWith(`${slug}.mailcheapmail.com`)), slug);
		}

		assert.equal((await save({ slug: "slug-d", name: "Renamed" })).ok, true, "a save that keeps the slug doesn't count");
		assert.equal((await patch({ replyTo: "jane@example.com" })).status, 200);
		assert.equal((await callApi("POST", "/api/v1/newsletters", { key: user.key, body: { name: "Second", slug: "slug-second" } })).status, 201, "nor does a new newsletter");
		const other = await customer("slug-elsewhere@example.com");
		assert.equal((await callApi("PATCH", `/api/v1/newsletters/${other.newsletterId}`, { key: other.key, body: { slug: "slug-moved" } })).status, 200, "each account counts on its own");
	});
});
