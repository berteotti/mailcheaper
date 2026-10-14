import { getMcpUrl } from "./docs/mcp-clients.js";

// OAuth for MCP clients such as ChatGPT and Claude: Better Auth is the authorization server (lib/auth.js) and
// /mcp the protected resource (lib/oauth.js). These are the values both sides agree on.

// What every MCP tool needs: the same as a full access API key.
export const MCP_SCOPE = "mailcheap:full";
// Better Auth's default scopes stay next to it: ChatGPT asks for the ones discovery lists, offline_access
// brings refresh tokens, and a client metadata document that names a scope the server lacks can't register.
export const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access", MCP_SCOPE];

export const CONSENT_PATH = "/oauth/consent";

// Dynamic client registration (RFC 7591) is open to apps whose redirect URIs are all on this list. Grok Bot runs on
// Cursor's agents and registers both, from the desktop app and from the cloud. Other apps identify with a client
// metadata document.
export const REGISTRATION_REDIRECT_URIS = ["cursor://anysphere.cursor-mcp/oauth/callback", "https://www.cursor.com/agents/mcp/oauth/callback"];

export function canRegisterRedirectUris(redirectUris) {
	return Array.isArray(redirectUris) && redirectUris.length > 0 && redirectUris.every((uri) => REGISTRATION_REDIRECT_URIS.includes(uri));
}

// Access tokens carry the id of the consent they came from (a connected app). Disconnecting deletes it and
// connecting again makes a new one, so a token stops working the moment its app is disconnected.
export const CONNECTION_CLAIM = "connection_id";

// Every access token names the consent it came from. Revoking an app deletes its consent, and connecting
// again makes a new one, so older tokens never work again, whatever their expiry.
export const CONSENT_CLAIM = "mailcheap_consent";

// The issuer is the site itself, so discovery lives at the root, where every client looks first.
export function getOAuthIssuer(appUrl) {
	return appUrl;
}

// Tokens carry it as their audience; /api/mcp is the same server.
export function getMcpResource(appUrl) {
	return getMcpUrl(appUrl);
}

// Better Auth signs the authorization request it sends to the sign-in and consent pages. The signature
// covers the parameters listed in ba_param, so others (?error= after Google) can sit next to them.
const SIGNED_NAMES_PARAM = "ba_param";

// searchParams: a page's searchParams object, or anything URLSearchParams takes.
export function pickSignedOAuthQuery(searchParams) {
	const params = toSearchParams(searchParams);
	const names = new Set(params.getAll(SIGNED_NAMES_PARAM));
	if (!params.has("sig") || names.size === 0) return null;
	const signed = new URLSearchParams();
	for (const [key, value] of params) {
		if (key === "sig" || key === SIGNED_NAMES_PARAM || names.has(key)) signed.append(key, value);
	}
	return signed.toString();
}

function toSearchParams(value) {
	if (value instanceof URLSearchParams || typeof value === "string") return new URLSearchParams(value);
	const params = new URLSearchParams();
	for (const [key, entry] of Object.entries(value ?? {})) {
		for (const item of [entry].flat()) if (typeof item === "string") params.append(key, item);
	}
	return params;
}

const MAX_OAUTH_QUERY_LENGTH = 8000;

// The signed request as forms send it back. Better Auth checks the signature.
export function readOAuthQueryField(value) {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_OAUTH_QUERY_LENGTH ? value : null;
}

// The error Better Auth answers when the signed request was changed or is over 10 minutes old.
export function isExpiredOAuthQuery(error) {
	return error?.body?.error === "invalid_signature";
}

export function readOAuthQuery(query) {
	const params = new URLSearchParams(query);
	return {
		clientId: params.get("client_id"),
		redirectUri: params.get("redirect_uri"),
		scopes: (params.get("scope") ?? "").split(" ").filter(Boolean),
	};
}

function getHost(value) {
	try {
		return new URL(value).host;
	} catch {
		return null;
	}
}

// Who's asking, as the consent screen and the connected apps show it. A client metadata document's URL is its
// client_id, and its host is the part nobody can fake; the name is whatever the document says. A registered app
// is known by where its codes go: the request's redirect, else its first https one (cursor:// has no real host).
export function describeClient(client, redirectUri) {
	const redirect = redirectUri ?? client?.redirectUris?.find((uri) => uri.startsWith("https://")) ?? client?.redirectUris?.[0];
	const host = (client?.clientId?.startsWith("https://") && getHost(client.clientId)) || getHost(redirect);
	return { name: client?.name?.trim() || host || "An app", host };
}

export function isLoopbackRedirect(redirectUri) {
	try {
		return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(redirectUri).hostname);
	} catch {
		return false;
	}
}
