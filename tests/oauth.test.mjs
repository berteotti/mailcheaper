import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { execute, getOne, getValue } from "../lib/db.js";
import { activate, anonymous, as, catchRedirect, form, platformEmails, startTestApp } from "./helpers/app.mjs";
import { metadataDocuments } from "./stubs/cimd-node.mjs";

// OAuth for MCP clients, the way ChatGPT and Claude connect: discovery from /mcp's 401, a client metadata
// document instead of registration (Grok Bot registers), the authorization code flow with PKCE through sign-in
// and the consent page, then tokens bound to /mcp. Route handlers answer every request; client metadata
// documents (and an app's signing keys) come from memory.
const APP_URL = "http://localhost:3000";
const MCP_URL = `${APP_URL}/mcp`;
const TOKEN_URL = `${APP_URL}/api/auth/oauth2/token`;
const REGISTER_URL = `${APP_URL}/api/auth/oauth2/register`;
const MCP_SCOPE = "mailcheap:full";

const AGENT = {
	clientId: "https://agent.example.test/oauth/client.json",
	redirectUri: "https://agent.example.test/oauth/callback",
	name: "Agent",
};
// The shape OpenAI documents for ChatGPT's document: both methods, private_key_jwt as the legacy preference.
const SIGNING_APP = {
	clientId: "https://signing.example.test/oauth/client.json",
	redirectUri: "https://signing.example.test/connector_platform_oauth_redirect",
	jwksUri: "https://signing.example.test/oauth/jwks.json",
	name: "Signing app",
};
// Grok's document as https://grok.com/oauth/mcp-client.json served it on October 13, 2026: console.x.ai is where
// Business and Enterprise admins add a connector.
const GROK_DOCUMENT = {
	client_id: "https://grok.com/oauth/mcp-client.json",
	client_name: "Grok",
	client_uri: "https://grok.com",
	logo_uri: "https://grok.com/icon-512x512.png",
	redirect_uris: ["https://grok.com/connectors-oauth-exchange-code/", "https://console.x.ai/connectors-oauth-exchange-code/"],
	grant_types: ["authorization_code", "refresh_token"],
	response_types: ["code"],
	token_endpoint_auth_method: "none",
};
// Grok Bot runs on Cursor's agents and registers (RFC 7591) with these two redirect URIs, from the desktop app and
// from the cloud alike, as Cursor's staff gave them.
const GROK_BOT = {
	client_name: "Grok Bot",
	redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback", "https://www.cursor.com/agents/mcp/oauth/callback"],
	grant_types: ["authorization_code", "refresh_token"],
	response_types: ["code"],
	token_endpoint_auth_method: "none",
};

let app;
let m;
let visitor = 0;
let registrant = 0;
const users = {};

function documentFor({ clientId, redirectUri, name }, extra = {}) {
	return {
		client_id: clientId,
		client_name: name,
		redirect_uris: [redirectUri],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		...extra,
	};
}

// Every request the MCP client makes, answered by the route that would answer it in production.
function findRoute(pathname) {
	if (pathname === "/mcp") return m.mcpRoute;
	if (pathname.startsWith("/api/auth/")) return m.authRoute;
	return m.wellKnown[pathname] ?? null;
}

async function appFetch(input, init) {
	const request = new Request(input, init);
	const url = new URL(request.url);
	if (url.origin !== APP_URL) throw new Error(`Unexpected request to ${url}`);
	const route = findRoute(url.pathname);
	if (!route?.[request.method]) return new Response("Not found", { status: 404 });
	return anonymous(() => route[request.method](request));
}

function cookieOf(user) {
	return [...user.jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function signInCode(email) {
	const { subject } = platformEmails.findLast(({ to }) => to.includes(email));
	return subject.slice(0, 6);
}

async function customer(email, { slug } = {}) {
	const user = { email, jar: new Map(), ip: `198.51.100.${++visitor}` };
	await as(user, () => m.signin.sendSigninCode(null, form({ email })));
	assert.equal(await as(user, () => catchRedirect(m.signin.verifySigninCode(null, form({ email, code: signInCode(email), next: "/" })))), "/");
	const stored = await getOne("SELECT id FROM users WHERE email = ?", [email]);
	user.userId = stored.id;
	user.accountId = (await getOne("SELECT _id FROM accounts WHERE ownerId = ?", [stored.id]))._id;
	await activate(user);
	if (slug) {
		await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${slug} news`, slug, postalAddress: "1 Main St, Paris" }))));
	}
	return user;
}

// What the browser does between the app and MailCheap: open the authorization URL, answer the consent page
// when it shows, and land on the app's redirect URI.
async function authorizeInBrowser(user, authorizationUrl, { decision = "allow" } = {}) {
	const response = await as(user, () => m.authRoute.GET(new Request(authorizationUrl, { headers: { cookie: cookieOf(user) } })));
	assert.equal(response.status, 302, await response.clone().text());
	const location = new URL(response.headers.get("location"), APP_URL);
	if (location.pathname !== "/oauth/consent") return location;
	return new URL(await as(user, () => catchRedirect(m.consent.answerConsentRequest(null, form({ oauth_query: location.search.slice(1), decision })))));
}

// An MCP client app's side, as the SDK expects it: the client metadata document URL (without one, the client
// registers with clientMetadata), the redirect, the tokens and the PKCE verifier, kept in memory (saved; the SDK
// reads a state() method of its own).
function createProvider({ clientId, redirectUri, name } = AGENT, clientMetadata = documentFor({ clientId, redirectUri, name })) {
	const saved = {};
	return {
		saved,
		clientMetadataUrl: clientId,
		get redirectUrl() {
			return redirectUri;
		},
		get clientMetadata() {
			return clientMetadata;
		},
		clientInformation: () => saved.client,
		saveClientInformation: (client) => {
			saved.client = client;
		},
		tokens: () => saved.tokens,
		saveTokens: (tokens) => {
			saved.tokens = tokens;
		},
		redirectToAuthorization: (url) => {
			saved.authorizationUrl = url;
		},
		saveCodeVerifier: (verifier) => {
			saved.codeVerifier = verifier;
		},
		codeVerifier: () => saved.codeVerifier,
		saveDiscoveryState: (discovery) => {
			saved.discovery = discovery;
		},
		discoveryState: () => saved.discovery,
	};
}

async function openClient(provider) {
	const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
	const client = new Client({ name: "mailcheap-oauth-test", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: appFetch });
	return { client, transport, connect: () => client.connect(transport) };
}

// The whole connection, as a user goes through it in ChatGPT or Claude: the first request fails with a 401
// that leads the client to sign-in, the user allows, and the client trades the code for tokens.
async function connectApp(user, provider = createProvider()) {
	const first = await openClient(provider);
	await assert.rejects(first.connect(), (error) => error.name === "UnauthorizedError");
	const callback = await authorizeInBrowser(user, provider.saved.authorizationUrl);
	assert.ok(callback.searchParams.get("code"), callback.href);
	await first.transport.finishAuth(callback.searchParams);
	const second = await openClient(provider);
	await second.connect();
	return second.client;
}

async function mcpRequest(token, method = "tools/list", params = {}) {
	const request = new Request(MCP_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
			...(token && { authorization: `Bearer ${token}` }),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const response = await anonymous(() => m.mcpRoute.POST(request));
	const text = await response.text();
	const data = text.split("\n").find((line) => line.startsWith("data: "));
	return { status: response.status, headers: response.headers, body: data ? JSON.parse(data.slice(6)) : text ? JSON.parse(text) : null };
}

async function callTool(token, name, args = {}) {
	return (await mcpRequest(token, "tools/call", { name, arguments: args })).body.result;
}

function toolError(result) {
	assert.equal(result.isError, true, JSON.stringify(result));
	return JSON.parse(result.content[0].text).error;
}

async function postToken(params) {
	const response = await appFetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params),
	});
	return { status: response.status, body: await response.json() };
}

// Each registration from an address of its own, unless the test picks one: registrations are limited per address.
async function register(metadata, ip = `203.0.113.${++registrant}`) {
	const response = await appFetch(REGISTER_URL, {
		method: "POST",
		headers: { "content-type": "application/json", "cf-connecting-ip": ip },
		body: JSON.stringify(metadata),
	});
	return { status: response.status, body: await response.json() };
}

function countClients() {
	return getValue("SELECT count(*) FROM oauthClient");
}

function pkce() {
	const verifier = crypto.randomBytes(32).toString("base64url");
	return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}

// The consent page's parameters for a request with prompt=consent, as Next.js gives them to the page: repeated
// ones (ba_param) as arrays.
async function openConsentPage(user, url) {
	const response = await as(user, () => m.authRoute.GET(new Request(url, { headers: { cookie: cookieOf(user) } })));
	const location = new URL(response.headers.get("location"), APP_URL);
	assert.equal(location.pathname, "/oauth/consent", "prompt=consent asks again");
	const params = {};
	for (const [key, value] of location.searchParams) params[key] = key in params ? [params[key], value].flat() : value;
	return params;
}

// An authorization request built by hand, for what the SDK client never sends. null leaves a parameter out.
function authorizationUrl({ clientId, redirectUri }, { scope = `${MCP_SCOPE} offline_access`, challenge, resource = MCP_URL, ...extra } = {}) {
	const url = new URL(`${APP_URL}/api/auth/oauth2/authorize`);
	const params = { response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope, state: "state-123", code_challenge: challenge, code_challenge_method: "S256", resource, ...extra };
	for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, value);
	return url;
}

before(async () => {
	app = await startTestApp({ GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret" });
	m = {
		mcpRoute: await import("../app/mcp/route.js"),
		authRoute: await import("../app/api/auth/[...all]/route.js"),
		wellKnown: {
			"/.well-known/oauth-protected-resource": await import("../app/.well-known/oauth-protected-resource/route.js"),
			"/.well-known/oauth-protected-resource/mcp": await import("../app/.well-known/oauth-protected-resource/mcp/route.js"),
			"/.well-known/oauth-authorization-server": await import("../app/.well-known/oauth-authorization-server/route.js"),
			"/.well-known/openid-configuration": await import("../app/.well-known/openid-configuration/route.js"),
		},
		signin: await import("../app/signin/actions.js"),
		consent: await import("../app/oauth/consent/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		oauth: await import("../lib/oauth.js"),
		accounts: await import("../lib/accounts.js"),
		blocks: await import("../lib/account-blocks.js"),
		registry: await import("../lib/actions/registry.js"),
	};
	metadataDocuments.set(AGENT.clientId, documentFor(AGENT));
	users.owner = await customer("oauth-owner@example.com", { slug: "oauth-owner" });
	users.stranger = await customer("oauth-stranger@example.com", { slug: "oauth-stranger" });
});

after(() => app?.stop());

describe("discovery", () => {
	test("/mcp answers a request without credentials with a 401 pointing at its protected resource metadata", async () => {
		const { status, headers, body } = await mcpRequest(null);
		assert.equal(status, 401);
		assert.equal(headers.get("www-authenticate"), `Bearer resource_metadata="${APP_URL}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPE}"`);
		assert.equal(body.error.code, "unauthorized");
	});

	test("the protected resource metadata names /mcp and the site as its authorization server, at both paths", async () => {
		for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
			const response = await appFetch(`${APP_URL}${path}`);
			assert.equal(response.status, 200, path);
			const metadata = await response.json();
			assert.equal(metadata.resource, MCP_URL);
			assert.deepEqual(metadata.authorization_servers, [APP_URL]);
			assert.deepEqual(metadata.scopes_supported, [MCP_SCOPE], "offline_access and OpenID scopes stay with the authorization server");
			assert.deepEqual(metadata.bearer_methods_supported, ["header"]);
		}
	});

	test("the authorization server metadata has what ChatGPT and Claude check before using a client metadata document", async () => {
		const metadata = await (await appFetch(`${APP_URL}/.well-known/oauth-authorization-server`)).json();
		assert.equal(metadata.issuer, APP_URL, "the issuer is the site, so this document sits at the root");
		assert.equal(metadata.authorization_endpoint, `${APP_URL}/api/auth/oauth2/authorize`);
		assert.equal(metadata.token_endpoint, TOKEN_URL);
		assert.equal(metadata.client_id_metadata_document_supported, true);
		assert.ok(metadata.token_endpoint_auth_methods_supported.includes("none"), "public clients (Claude)");
		assert.ok(metadata.token_endpoint_auth_methods_supported.includes("private_key_jwt"), "signed assertions (ChatGPT)");
		assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
		assert.equal(metadata.authorization_response_iss_parameter_supported, true);
		assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);
		assert.ok(metadata.scopes_supported.includes("offline_access"), "ChatGPT and Claude ask for refresh tokens when it's listed");
		assert.ok(metadata.scopes_supported.includes(MCP_SCOPE));
		assert.equal(metadata.registration_endpoint, REGISTER_URL, "Grok Bot registers; the others identify with a document");
		assert.deepEqual(metadata.id_token_signing_alg_values_supported, ["RS256"]);

		const openid = await (await appFetch(`${APP_URL}/.well-known/openid-configuration`)).json();
		assert.equal(openid.issuer, APP_URL);
		assert.equal(openid.client_id_metadata_document_supported, true);
		assert.equal(openid.registration_endpoint, REGISTER_URL);
	});

	test("discovery and the consent page get past the proxy without a session", async () => {
		const { proxy } = await import("../proxy.js");
		const { NextRequest } = await import("next/server");
		const visit = (path) => proxy(new NextRequest(new URL(path, APP_URL), { headers: { host: "localhost:3000" } }));
		for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/oauth/consent", "/api/auth/oauth2/token"]) {
			assert.ok((await visit(path)).headers.get("x-middleware-next"), path);
		}
		assert.equal((await visit("/.well-known/security.txt")).status, 307, "nothing else under /.well-known");
	});

	test("Better Auth's routes MCP clients don't need stay closed", async () => {
		for (const path of ["/token", "/oauth2/create-client", "/oauth2/get-consents", "/oauth2/consent"]) {
			const response = await appFetch(`${APP_URL}/api/auth${path}`, { method: path === "/token" || path === "/oauth2/get-consents" ? "GET" : "POST" });
			assert.equal(response.status, 404, path);
		}
	});
});

describe("connecting with the official MCP client", () => {
	test("a signed-in user allows the app; the client gets a token bound to /mcp and works in their account", async () => {
		const provider = createProvider();
		const client = await connectApp(users.owner, provider);

		assert.equal(provider.saved.client?.client_id, AGENT.clientId, "the client identified with its document, without registering");
		assert.equal(provider.saved.discovery.authorizationServerUrl, APP_URL);
		const { tokens } = provider.saved;
		assert.equal(tokens.token_type, "Bearer");
		assert.ok(tokens.refresh_token?.length > 20, "offline_access brings a refresh token");
		const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString());
		assert.equal(claims.aud, MCP_URL);
		assert.equal(claims.iss, APP_URL);
		assert.equal(claims.sub, String(users.owner.userId));
		assert.equal(claims.azp, AGENT.clientId);
		assert.equal(claims.exp - claims.iat, 3600);
		assert.deepEqual(claims.scope.split(" ").sort(), ["mailcheap:full", "offline_access"]);

		const { tools } = await client.listTools();
		assert.equal(tools.length, m.registry.ACTIONS.length, "full access: every tool");
		const newsletters = await client.callTool({ name: "list_newsletters", arguments: {} });
		assert.deepEqual(newsletters.structuredContent.newsletters.map(({ slug }) => slug), ["oauth-owner"]);
		const draft = await client.callTool({ name: "create_campaign", arguments: { subject: "From ChatGPT", content: "# Hi" } });
		assert.equal(draft.structuredContent.source, "api");
		assert.ok(await getOne("SELECT _id FROM campaigns WHERE accountId = ? AND subject = ?", [users.owner.accountId, "From ChatGPT"]));
		await client.close();
	});

	test("the consent page's request carries the app's name, its host and the redirect, signed", async () => {
		const { challenge } = pkce();
		const params = await openConsentPage(users.owner, authorizationUrl(AGENT, { challenge, prompt: "consent" }));
		const verified = await as(users.owner, () => m.oauth.readOAuthRequest(params));
		assert.equal(verified.isExpired, false);
		assert.deepEqual(verified.client, { name: "Agent", host: "agent.example.test" });
		assert.equal(verified.redirectUri, AGENT.redirectUri);
		assert.deepEqual(verified.scopes, [MCP_SCOPE, "offline_access"]);

		const tampered = { ...params, client_id: "https://evil.example.test/client.json" };
		assert.equal((await as(users.owner, () => m.oauth.readOAuthRequest(tampered))).isExpired, true);
	});

	test("the client refreshes an expired access token with its refresh token, which rotates", async () => {
		const provider = createProvider();
		const client = await connectApp(users.owner, provider);
		await client.close();
		const before = provider.saved.tokens;
		provider.saveTokens({ ...before, access_token: "expired.token.value" });

		const again = await openClient(provider);
		await again.connect();
		const result = await again.client.callTool({ name: "list_newsletters", arguments: {} });
		assert.deepEqual(result.structuredContent.newsletters.map(({ slug }) => slug), ["oauth-owner"]);
		assert.notEqual(provider.saved.tokens.access_token, "expired.token.value");
		assert.notEqual(provider.saved.tokens.refresh_token, before.refresh_token, "refresh tokens rotate");
		await again.client.close();
	});

	test("someone signed out signs in on the way, by code or with Google, and goes on to the consent page", async () => {
		const email = "oauth-newcomer@example.com";
		const user = { email, jar: new Map(), ip: `198.51.100.${++visitor}` };
		const { challenge, verifier } = pkce();
		const start = await as(user, () => m.authRoute.GET(new Request(authorizationUrl(AGENT, { challenge }))));
		const signin = new URL(start.headers.get("location"), APP_URL);
		assert.equal(signin.pathname, "/signin");
		const oauthQuery = signin.search.slice(1);

		await as(user, () => m.signin.sendSigninCode(null, form({ email })));
		const consent = new URL(
			await as(user, () => catchRedirect(m.signin.verifySigninCode(null, form({ email, code: signInCode(email), next: "/", oauth_query: oauthQuery })))),
			APP_URL
		);
		assert.equal(consent.pathname, "/oauth/consent", "the sign-in carries on with the request");
		const callback = new URL(
			await as(user, () => catchRedirect(m.consent.answerConsentRequest(null, form({ oauth_query: consent.search.slice(1), decision: "allow" }))))
		);
		assert.equal(callback.origin + callback.pathname, AGENT.redirectUri);
		assert.equal(callback.searchParams.get("state"), "state-123");
		assert.equal(callback.searchParams.get("iss"), APP_URL, "RFC 9207: the issuer comes back with the code");

		const token = await postToken({
			grant_type: "authorization_code",
			code: callback.searchParams.get("code"),
			redirect_uri: AGENT.redirectUri,
			client_id: AGENT.clientId,
			code_verifier: verifier,
			resource: MCP_URL,
		});
		assert.equal(token.status, 200, JSON.stringify(token.body));
		const billing = await callTool(token.body.access_token, "get_billing");
		assert.equal(billing.structuredContent.status, "no_plan", "billing tools work before a plan, so the app can open checkout");
		const contacts = await callTool(token.body.access_token, "list_contacts");
		assert.equal(toolError(contacts).code, "subscription_required", "the rest answers what an API key would without a plan");

		const google = { jar: new Map(), ip: `198.51.100.${++visitor}` };
		const googleStart = await as(google, () => m.authRoute.GET(new Request(authorizationUrl(AGENT, { challenge }))));
		const googleQuery = new URL(googleStart.headers.get("location"), APP_URL).search.slice(1);
		const toGoogle = new URL(await as(google, () => catchRedirect(m.signin.signinWithGoogle(form({ next: "/", oauth_query: googleQuery })))));
		assert.equal(toGoogle.host, "accounts.google.com");
		const location = await finishGoogleSignIn(google, toGoogle, { email: "oauth-google@example.com" });
		assert.equal(location.pathname, "/oauth/consent", "Better Auth carries on with the request after Google's callback");
	});

	test("prompt=select_account shows the consent page, with the account and Switch, and Allow goes on", async () => {
		const { challenge } = pkce();
		const response = await as(users.owner, () =>
			m.authRoute.GET(new Request(authorizationUrl(AGENT, { challenge, prompt: "select_account" }), { headers: { cookie: cookieOf(users.owner) } }))
		);
		const location = new URL(response.headers.get("location"), APP_URL);
		assert.equal(location.pathname, "/oauth/consent");
		const callback = new URL(
			await as(users.owner, () => catchRedirect(m.consent.answerConsentRequest(null, form({ oauth_query: location.search.slice(1), decision: "allow" }))))
		);
		assert.ok(callback.searchParams.get("code"), callback.href);
	});

	test("a changed or expired request is refused at sign-in, without signing in", async () => {
		const email = "oauth-expired@example.com";
		const user = { email, jar: new Map(), ip: `198.51.100.${++visitor}` };
		const { challenge } = pkce();
		const start = await as(user, () => m.authRoute.GET(new Request(authorizationUrl(AGENT, { challenge }))));
		const tampered = new URL(start.headers.get("location"), APP_URL).search.slice(1).replace("state-123", "state-999");
		await as(user, () => m.signin.sendSigninCode(null, form({ email })));
		const result = await as(user, () => m.signin.verifySigninCode(null, form({ email, code: signInCode(email), oauth_query: tampered })));
		assert.equal(result.error, "This sign-in link expired. Go back to the app and connect MailCheap again.");
		assert.equal(user.jar.size, 0, "no session");
	});

	test("Cancel sends the user back to the app with access_denied, and nothing is connected", async () => {
		const user = await customer("oauth-cancel@example.com");
		const { challenge } = pkce();
		const callback = await authorizeInBrowser(user, authorizationUrl(AGENT, { challenge }), { decision: "deny" });
		assert.equal(callback.searchParams.get("error"), "access_denied");
		assert.equal(callback.searchParams.get("code"), null);
		assert.deepEqual(await m.oauth.listConnectedApps({ ownerId: user.userId }), []);
	});

	test("an app whose document asks for private_key_jwt (as ChatGPT's does) trades the code with a signed assertion", async () => {
		const { publicKey, privateKey } = await generateKeyPair("ES256");
		const jwk = { ...(await exportJWK(publicKey)), kid: "signing-1", alg: "ES256", use: "sig" };
		metadataDocuments.set(SIGNING_APP.jwksUri, { keys: [jwk] });
		metadataDocuments.set(
			SIGNING_APP.clientId,
			documentFor(SIGNING_APP, {
				token_endpoint_auth_method: "private_key_jwt",
				token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
				jwks_uri: SIGNING_APP.jwksUri,
				scope: "openid email profile offline_access",
			})
		);
		const { challenge, verifier } = pkce();
		const callback = await authorizeInBrowser(users.owner, authorizationUrl(SIGNING_APP, { challenge, scope: `openid email profile offline_access ${MCP_SCOPE}` }));
		const assertion = await new SignJWT({ jti: crypto.randomUUID() })
			.setProtectedHeader({ alg: "ES256", kid: "signing-1" })
			.setIssuer(SIGNING_APP.clientId)
			.setSubject(SIGNING_APP.clientId)
			.setAudience(TOKEN_URL)
			.setIssuedAt()
			.setExpirationTime("2m")
			.sign(privateKey);
		const token = await postToken({
			grant_type: "authorization_code",
			code: callback.searchParams.get("code"),
			redirect_uri: SIGNING_APP.redirectUri,
			client_id: SIGNING_APP.clientId,
			code_verifier: verifier,
			resource: MCP_URL,
			client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
			client_assertion: assertion,
		});
		assert.equal(token.status, 200, JSON.stringify(token.body));
		assert.ok(token.body.id_token, "openid brings an ID token, signed RS256");
		assert.equal(JSON.parse(Buffer.from(token.body.id_token.split(".")[0], "base64url").toString()).alg, "RS256");
		const result = await callTool(token.body.access_token, "list_newsletters");
		assert.deepEqual(result.structuredContent.newsletters.map(({ slug }) => slug), ["oauth-owner"]);
	});

	test("Grok connects with its published document, from grok.com and from console.x.ai", async () => {
		metadataDocuments.set(GROK_DOCUMENT.client_id, GROK_DOCUMENT);
		for (const redirectUri of GROK_DOCUMENT.redirect_uris) {
			const provider = createProvider({ clientId: GROK_DOCUMENT.client_id, redirectUri, name: GROK_DOCUMENT.client_name });
			const client = await connectApp(users.owner, provider);
			assert.equal(provider.saved.client?.client_id, GROK_DOCUMENT.client_id);
			const result = await client.callTool({ name: "list_newsletters", arguments: {} });
			assert.deepEqual(result.structuredContent.newsletters.map(({ slug }) => slug), ["oauth-owner"]);
			await client.close();
		}
		const apps = await m.oauth.listConnectedApps({ ownerId: users.owner.userId });
		assert.deepEqual(
			apps.filter(({ clientId }) => clientId === GROK_DOCUMENT.client_id).map(({ name, host }) => ({ name, host })),
			[{ name: "Grok", host: "grok.com" }]
		);
	});
});

describe("registering, as Grok Bot does", () => {
	test("Grok Bot's two redirect URIs register a public client, bound to /mcp", async () => {
		const { status, body } = await register(GROK_BOT);
		assert.equal(status, 201, JSON.stringify(body));
		assert.ok(body.client_id && !body.client_id.startsWith("https://"), "an id of its own, not a document URL");
		assert.deepEqual(body.redirect_uris, GROK_BOT.redirect_uris, "cursor:// too, which Better Auth refuses on its own");
		assert.equal(body.token_endpoint_auth_method, "none");
		assert.equal(body.client_secret, undefined);
		assert.deepEqual(body.resources, [MCP_URL]);
		const stored = await getOne("SELECT * FROM oauthClient WHERE clientId = ?", [body.client_id]);
		assert.deepEqual(JSON.parse(stored.redirectUris), GROK_BOT.redirect_uris);
		assert.equal(stored.name, "Grok Bot");
	});

	test("Grok Bot connects with the official MCP client, from the desktop app and from the cloud", async () => {
		const user = await customer("oauth-grok-bot@example.com", { slug: "oauth-grok-bot" });
		for (const redirectUri of GROK_BOT.redirect_uris) {
			const provider = createProvider({ redirectUri }, GROK_BOT);
			const client = await connectApp(user, provider);
			const clientId = provider.saved.client?.client_id;
			assert.ok(clientId && !clientId.startsWith("https://"), "the client registered first");
			const claims = JSON.parse(Buffer.from(provider.saved.tokens.access_token.split(".")[1], "base64url").toString());
			assert.equal(claims.aud, MCP_URL);
			assert.equal(claims.azp, clientId);
			const result = await client.callTool({ name: "list_newsletters", arguments: {} });
			assert.deepEqual(result.structuredContent.newsletters.map(({ slug }) => slug), ["oauth-grok-bot"]);
			await client.close();

			const params = await openConsentPage(user, authorizationUrl({ clientId, redirectUri }, { challenge: pkce().challenge, prompt: "consent" }));
			const consent = await as(user, () => m.oauth.readOAuthRequest(params));
			assert.deepEqual(consent.client, { name: "Grok Bot", host: new URL(redirectUri).host }, "the consent page names it and where it goes back to");
		}
		const apps = await m.oauth.listConnectedApps({ ownerId: user.userId });
		assert.deepEqual(
			apps.map(({ name, host }) => ({ name, host })),
			[
				{ name: "Grok Bot", host: "www.cursor.com" },
				{ name: "Grok Bot", host: "www.cursor.com" },
			],
			"each registration is an app of its own, shown with its https redirect's host"
		);
	});

	test("a registered client needs PKCE: no code challenge is refused, and the code trades with its verifier", async () => {
		const { body: registered } = await register(GROK_BOT);
		const bot = { clientId: registered.client_id, redirectUri: GROK_BOT.redirect_uris[1] };
		const refused = await authorizeInBrowser(users.owner, authorizationUrl(bot));
		assert.equal(refused.searchParams.get("error"), "invalid_request", refused.href);

		const { challenge, verifier } = pkce();
		const callback = await authorizeInBrowser(users.owner, authorizationUrl(bot, { challenge }));
		assert.equal(callback.origin + callback.pathname, bot.redirectUri);
		const token = await postToken({
			grant_type: "authorization_code",
			code: callback.searchParams.get("code"),
			redirect_uri: bot.redirectUri,
			client_id: bot.clientId,
			code_verifier: verifier,
			resource: MCP_URL,
		});
		assert.equal(token.status, 200, JSON.stringify(token.body));
		const result = await callTool(token.body.access_token, "list_newsletters");
		assert.deepEqual(result.structuredContent.newsletters.map(({ slug }) => slug), ["oauth-owner"]);
	});

	test("any other or extra redirect URI is refused with invalid_redirect_uri, and nothing registers", async () => {
		const before = await countClients();
		for (const redirectUris of [
			["https://evil.example/cb"],
			[...GROK_BOT.redirect_uris, "https://evil.example/cb"],
			["https://www.cursor.com/agents/mcp/oauth/callback/"],
			["cursor://anysphere.cursor-mcp/oauth/callback?next=https://evil.example"],
			["http://localhost:3118/callback"],
			[],
			undefined,
		]) {
			const { status, body } = await register({ ...GROK_BOT, redirect_uris: redirectUris });
			assert.equal(status, 400, JSON.stringify(redirectUris));
			assert.equal(body.error, "invalid_redirect_uri", JSON.stringify(redirectUris));
		}
		assert.equal(await countClients(), before);
	});

	test("a confidential client is refused, and so is a backchannel logout URI", async () => {
		const before = await countClients();
		// Without a method, RFC 7591 means client_secret_basic.
		for (const method of ["client_secret_basic", "client_secret_post", "private_key_jwt", undefined]) {
			const { status, body } = await register({ ...GROK_BOT, token_endpoint_auth_method: method });
			assert.equal(status, 400, String(method));
			assert.equal(body.error, "invalid_client_metadata", String(method));
		}
		const logout = await register({ ...GROK_BOT, backchannel_logout_uri: "https://evil.example/logout" });
		assert.equal(logout.status, 400);
		assert.equal(logout.body.error, "invalid_client_metadata");
		assert.equal(await countClients(), before);
	});

	test("the 11th registration in an hour from one address gets a 429", async () => {
		const ip = "192.0.2.10";
		for (let count = 1; count <= 10; count++) assert.equal((await register(GROK_BOT, ip)).status, 201, `registration ${count}`);
		const limited = await register(GROK_BOT, ip);
		assert.equal(limited.status, 429);
		assert.equal(limited.body.error, "rate_limited");
		assert.equal((await register(GROK_BOT)).status, 201, "other addresses still register");
	});
});

describe("tokens", () => {
	test("a token without the mailcheap:full scope gets a 403 asking for it", async () => {
		const { challenge, verifier } = pkce();
		const callback = await authorizeInBrowser(users.owner, authorizationUrl(AGENT, { challenge, scope: "offline_access" }));
		const token = await postToken({
			grant_type: "authorization_code",
			code: callback.searchParams.get("code"),
			redirect_uri: AGENT.redirectUri,
			client_id: AGENT.clientId,
			code_verifier: verifier,
			resource: MCP_URL,
		});
		const { status, headers, body } = await mcpRequest(token.body.access_token);
		assert.equal(status, 403);
		assert.match(headers.get("www-authenticate"), /^Bearer error="insufficient_scope", scope="mailcheap:full", resource_metadata="[^"]+\/mcp"/);
		assert.equal(body.error.code, "forbidden");
	});

	test("forged, foreign and unbound tokens never reach MCP", async () => {
		const { privateKey } = await generateKeyPair("RS256");
		const now = Math.floor(Date.now() / 1000);
		const forged = await new SignJWT({ scope: MCP_SCOPE, azp: AGENT.clientId })
			.setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "forged" })
			.setIssuer(APP_URL)
			.setAudience(MCP_URL)
			.setSubject(String(users.owner.userId))
			.setIssuedAt(now)
			.setExpirationTime(now + 600)
			.sign(privateKey);
		const { challenge, verifier } = pkce();
		const callback = await authorizeInBrowser(users.owner, authorizationUrl(AGENT, { challenge, scope: `openid ${MCP_SCOPE}`, resource: null }));
		const unbound = await postToken({
			grant_type: "authorization_code",
			code: callback.searchParams.get("code"),
			redirect_uri: AGENT.redirectUri,
			client_id: AGENT.clientId,
			code_verifier: verifier,
		});
		assert.equal(unbound.status, 200, JSON.stringify(unbound.body));
		for (const [label, token] of [
			["forged", forged],
			["opaque, without resource", unbound.body.access_token],
			["an ID token", unbound.body.id_token],
			["garbage", "not-a-token"],
		]) {
			const { status, headers } = await mcpRequest(token);
			assert.equal(status, 401, label);
			assert.match(headers.get("www-authenticate"), /resource_metadata=/, label);
		}
	});

	test("each token only reaches its own user's account", async () => {
		const ownerApp = await connectApp(users.owner);
		const strangerApp = await connectApp(users.stranger);
		const ownCampaign = await getOne("SELECT _id FROM campaigns WHERE accountId = ? AND subject = ?", [users.owner.accountId, "From ChatGPT"]);

		const theirs = await strangerApp.callTool({ name: "get_campaign", arguments: { id: String(ownCampaign._id) } });
		assert.equal(JSON.parse(theirs.content[0].text).error.code, "not_found");
		const strangerNewsletters = await strangerApp.callTool({ name: "list_newsletters", arguments: {} });
		assert.deepEqual(strangerNewsletters.structuredContent.newsletters.map(({ slug }) => slug), ["oauth-stranger"]);
		const ownerNewsletters = await ownerApp.callTool({ name: "list_newsletters", arguments: {} });
		assert.deepEqual(ownerNewsletters.structuredContent.newsletters.map(({ slug }) => slug), ["oauth-owner"]);
		await ownerApp.close();
		await strangerApp.close();
	});

	test("blocked and canceled accounts answer an app exactly as they answer a full access key", async () => {
		const user = await customer("oauth-states@example.com", { slug: "oauth-states" });
		const { key } = await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })));
		const provider = createProvider();
		await (await connectApp(user, provider)).close();
		const token = provider.saved.tokens.access_token;
		await callTool(key, "add_contact", { email: "reader@example.org" });
		const draft = await callTool(key, "create_campaign", { subject: "Paused test", content: "# Hi" });

		await m.blocks.blockAccount(user.accountId, { reason: "Review" });
		const byKey = toolError(await callTool(key, "send_campaign", { id: draft.structuredContent.id }));
		const byApp = toolError(await callTool(token, "send_campaign", { id: draft.structuredContent.id }));
		assert.equal(byKey.code, "account_blocked");
		assert.deepEqual(byApp, byKey);
		assert.equal(toolError(await callTool(token, "add_contact", { email: "new-reader@example.org" })).code, "account_blocked");
		assert.equal((await callTool(token, "list_contacts")).structuredContent.contacts.length, 1, "reads still work");

		await execute("UPDATE accounts SET status = 'active', subscriptionStatus = 'canceled' WHERE _id = ?", [user.accountId]);
		const canceledByKey = toolError(await callTool(key, "list_contacts"));
		assert.equal(canceledByKey.code, "subscription_required");
		assert.deepEqual(toolError(await callTool(token, "list_contacts")), canceledByKey);
	});
});

describe("connected apps", () => {
	test("are listed with their name, host and use, and a revoked one stops working at once", async () => {
		const user = await customer("oauth-revoke@example.com", { slug: "oauth-revoke" });
		const provider = createProvider();
		const client = await connectApp(user, provider);
		await client.close();
		const { access_token: accessToken, refresh_token: refreshToken } = provider.saved.tokens;

		const listed = await callTool(accessToken, "list_connected_apps");
		assert.equal(listed.structuredContent.connectedApps.length, 1);
		const [connected] = listed.structuredContent.connectedApps;
		assert.equal(connected.name, "Agent");
		assert.equal(connected.host, "agent.example.test");
		assert.equal(connected.isCurrent, true);
		assert.ok(connected.lastUsedAt, "last used is recorded");
		const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString());
		assert.equal(claims.connection_id, connected.id, "the token names the connection it belongs to");

		const result = await as(user, () => m.apiKeys.revokeConnectedApp(connected.id));
		assert.deepEqual(result, { ok: true });
		const { status, body } = await mcpRequest(accessToken);
		assert.equal(status, 401, "the same, unexpired token is refused right away");
		assert.match(body.error.message, /disconnected/);
		const refreshed = await postToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: AGENT.clientId, resource: MCP_URL });
		assert.equal(refreshed.status, 400);
		assert.equal(refreshed.body.error, "invalid_grant", "Claude and ChatGPT start over on invalid_grant");
		assert.deepEqual(await m.oauth.listConnectedApps({ ownerId: user.userId }), []);

		const { challenge } = pkce();
		const response = await as(user, () => m.authRoute.GET(new Request(authorizationUrl(AGENT, { challenge }), { headers: { cookie: cookieOf(user) } })));
		assert.equal(new URL(response.headers.get("location"), APP_URL).pathname, "/oauth/consent", "connecting again asks for consent again");
		const back = await connectApp(user);
		const relisted = await back.callTool({ name: "list_connected_apps", arguments: {} });
		assert.equal(relisted.structuredContent.connectedApps.length, 1);
		assert.equal((await mcpRequest(accessToken)).status, 401, "tokens from before the revocation stay dead");
		await back.close();
	});

	test("an app can disconnect itself, and nobody can disconnect another account's app", async () => {
		const user = await customer("oauth-self@example.com");
		const provider = createProvider();
		await (await connectApp(user, provider)).close();
		const token = provider.saved.tokens.access_token;
		const [own] = (await callTool(token, "list_connected_apps")).structuredContent.connectedApps;

		const strangerTry = await as(users.stranger, () => m.apiKeys.revokeConnectedApp(own.id));
		assert.equal(strangerTry.error, "App not found");
		const revoked = await callTool(token, "revoke_connected_app", { id: own.id });
		assert.deepEqual(revoked.structuredContent, { id: own.id, revoked: true });
		assert.equal((await mcpRequest(token)).status, 401);
	});
});

describe("API keys", () => {
	test("keep working beside OAuth, with the same tools and checks", async () => {
		const { key } = await as(users.owner, () => m.apiKeys.createApiKey(null, form({ name: "Claude Code", level: "full" })));
		const { body } = await mcpRequest(key);
		assert.equal(body.result.tools.length, m.registry.ACTIONS.length);
		const { key: signupKey } = await as(users.owner, () => m.apiKeys.createApiKey(null, form({ name: "Site", level: "signups" })));
		assert.deepEqual((await mcpRequest(signupKey)).body.result.tools.map(({ name }) => name), ["add_contact"]);
		const revoked = await mcpRequest(`mc_${"y".repeat(43)}`);
		assert.equal(revoked.status, 401);
		assert.equal(revoked.body.error.message, "Send a valid API key: Authorization: Bearer <key>");
	});
});

// Google's side of a sign-in, as tests/self-host.test.mjs plays it: consent, then the callback with a code that
// Better Auth trades at Google's token endpoint for an ID token.
async function finishGoogleSignIn(user, toGoogle, { email }) {
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const idToken = [
		encode({ alg: "RS256", kid: "test" }),
		encode({ iss: "https://accounts.google.com", aud: "google-client", iat: now, exp: now + 3600, sub: email, email, email_verified: true, name: "Jo" }),
		"c2lnbmF0dXJl",
	].join(".");
	const previousFetch = globalThis.fetch;
	globalThis.fetch = (input, init) =>
		String(input?.url ?? input) === "https://oauth2.googleapis.com/token"
			? Promise.resolve(Response.json({ access_token: "ya29.test", token_type: "Bearer", expires_in: 3599, scope: "openid email profile", id_token: idToken }))
			: previousFetch(input, init);
	try {
		const callback = new Request(`${APP_URL}/api/auth/callback/google?code=test-code&state=${toGoogle.searchParams.get("state")}`, {
			headers: { cookie: cookieOf(user), accept: "text/html", "sec-fetch-mode": "navigate" },
		});
		const response = await as(user, () => m.authRoute.GET(callback));
		assert.equal(response.status, 302);
		return new URL(response.headers.get("location"), APP_URL);
	} finally {
		globalThis.fetch = previousFetch;
	}
}
