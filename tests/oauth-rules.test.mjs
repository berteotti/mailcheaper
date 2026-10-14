import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MCP_SCOPE,
	OAUTH_SCOPES,
	REGISTRATION_REDIRECT_URIS,
	canRegisterRedirectUris,
	describeClient,
	getMcpResource,
	getOAuthIssuer,
	isExpiredOAuthQuery,
	isLoopbackRedirect,
	pickSignedOAuthQuery,
	readOAuthQuery,
	readOAuthQueryField,
} from "../lib/oauth-rules.js";

const SIGNED = "client_id=https%3A%2F%2Fapp.example.test%2Fclient.json&scope=mailcheap%3Afull&exp=1&ba_iat=1&ba_param=ba_iat&ba_param=ba_param&ba_param=client_id&ba_param=exp&ba_param=scope&sig=abc";

test("tokens are for /mcp, from an issuer that is the site itself, with refresh tokens and OpenID scopes on offer", () => {
	assert.equal(getMcpResource("https://mailcheap.ai"), "https://mailcheap.ai/mcp");
	assert.equal(getOAuthIssuer("https://mailcheap.ai"), "https://mailcheap.ai");
	assert.ok(OAUTH_SCOPES.includes(MCP_SCOPE));
	assert.ok(OAUTH_SCOPES.includes("offline_access"));
	assert.deepEqual(OAUTH_SCOPES.slice(0, 3), ["openid", "profile", "email"]);
});

test("only the parameters the signature covers are kept, from a query string or a page's searchParams", () => {
	assert.equal(pickSignedOAuthQuery(`${SIGNED}&error=access_denied`), SIGNED);
	const searchParams = {};
	for (const [key, value] of new URLSearchParams(`${SIGNED}&next=%2F`)) searchParams[key] = key in searchParams ? [searchParams[key], value].flat() : value;
	assert.equal(pickSignedOAuthQuery(searchParams), SIGNED);
	assert.equal(pickSignedOAuthQuery("next=%2Fcampaigns"), null, "a plain sign-in");
	assert.equal(pickSignedOAuthQuery("client_id=x&sig=abc"), null, "no list of signed parameters");
	assert.equal(pickSignedOAuthQuery({}), null);
});

test("the request's app, redirect and scopes are read from the signed query", () => {
	assert.deepEqual(readOAuthQuery(SIGNED), { clientId: "https://app.example.test/client.json", redirectUri: null, scopes: [MCP_SCOPE] });
});

test("an app is shown by its name and the host nobody can fake: its document's, else its redirect's", () => {
	assert.deepEqual(describeClient({ clientId: "https://chatgpt.com/oauth/client.json", name: "ChatGPT" }, "https://chatgpt.com/connector_platform_oauth_redirect"), {
		name: "ChatGPT",
		host: "chatgpt.com",
	});
	assert.deepEqual(describeClient({ clientId: "AbC123", name: " ", redirectUris: ["https://tool.example.test/callback"] }), {
		name: "tool.example.test",
		host: "tool.example.test",
	});
	assert.deepEqual(describeClient(null, "http://127.0.0.1:3118/callback"), { name: "127.0.0.1:3118", host: "127.0.0.1:3118" });
	assert.deepEqual(describeClient(null), { name: "An app", host: null });
	const registered = { clientId: "AbC123", name: "Grok Bot", redirectUris: REGISTRATION_REDIRECT_URIS };
	assert.deepEqual(describeClient(registered), { name: "Grok Bot", host: "www.cursor.com" }, "a registered app's https redirect, listed second");
	assert.deepEqual(describeClient(registered, REGISTRATION_REDIRECT_URIS[0]), { name: "Grok Bot", host: "anysphere.cursor-mcp" }, "the request's own redirect");
});

test("only Grok Bot's redirect URIs register, each exactly as listed", () => {
	assert.deepEqual(REGISTRATION_REDIRECT_URIS, ["cursor://anysphere.cursor-mcp/oauth/callback", "https://www.cursor.com/agents/mcp/oauth/callback"]);
	assert.equal(canRegisterRedirectUris(REGISTRATION_REDIRECT_URIS), true);
	assert.equal(canRegisterRedirectUris([REGISTRATION_REDIRECT_URIS[1]]), true);
	for (const uris of [[], [...REGISTRATION_REDIRECT_URIS, "https://evil.example/cb"], ["https://www.cursor.com/agents/mcp/oauth/callback/"], ["HTTPS://www.cursor.com/agents/mcp/oauth/callback"], "https://www.cursor.com/agents/mcp/oauth/callback", undefined, [42]]) {
		assert.equal(canRegisterRedirectUris(uris), false, JSON.stringify(uris));
	}
});

test("loopback redirects are told apart, for the warning on the consent page", () => {
	for (const uri of ["http://localhost:3118/callback", "http://127.0.0.1/callback", "http://[::1]:8080/cb"]) assert.equal(isLoopbackRedirect(uri), true, uri);
	for (const uri of ["https://claude.ai/api/mcp/auth_callback", "not a url", undefined]) assert.equal(isLoopbackRedirect(uri), false, String(uri));
});

test("form values are taken as signed queries only when they're strings of a sane length", () => {
	assert.equal(readOAuthQueryField(SIGNED), SIGNED);
	for (const value of [null, undefined, "", 42, "x".repeat(8001)]) assert.equal(readOAuthQueryField(value), null, String(value).slice(0, 10));
	assert.equal(isExpiredOAuthQuery({ body: { error: "invalid_signature" } }), true);
	assert.equal(isExpiredOAuthQuery(new Error("other")), false);
});
