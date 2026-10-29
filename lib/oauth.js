import "server-only";
import { createResourceServerChallenge, verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import {
	createDpopReplayStore,
	createInsufficientScopeError,
	enforceDpopBinding,
	isDpopBindingError,
	parseAccessTokenAuthorization,
	verifyJwsAccessToken,
} from "better-auth/oauth2";
import { errors as joseErrors } from "jose";
import { isDeletionPending } from "@/lib/account-state";
import { actionError } from "@/lib/actions/errors";
import { findUser, isUserAllowed } from "@/lib/accounts";
import { shouldTouchLastUsed } from "@/lib/api-key-tokens";
import { getAuth, getAuthCallContext } from "@/lib/auth";
import { getAppUrl, isCloud } from "@/lib/config";
import { accountIdOf, connectDb, execute, getAll, getOne, statement } from "@/lib/db";
import {
	CONNECTION_CLAIM,
	MCP_SCOPE,
	describeClient,
	getMcpResource,
	getOAuthIssuer,
	pickSignedOAuthQuery,
	readOAuthQuery,
} from "@/lib/oauth-rules";
import { findMembership } from "@/lib/organizations";

// Better Auth's OAuth tables (migrations/0007_auth.sql). A connected app is a consent: one per user and app. It works
// in its user's organization, so an account's apps are its members' (MEMBER_IDS), and someone leaving disconnects
// theirs. Better Auth writes their dates as ISO strings and their lists (scopes, redirectUris) as JSON text.
const OAUTH_MODELS = {
	client: "oauthClient",
	consent: "oauthConsent",
	accessToken: "oauthAccessToken",
	refreshToken: "oauthRefreshToken",
};

const MEMBER_IDS = "SELECT m.userId FROM members m JOIN accounts a ON a.organizationId = m.organizationId WHERE a._id = ?";

const ACCESS_TOKEN_TYPE = "at+jwt";
const SIGN_IN_MESSAGE = "Connect with OAuth, or send an API key: Authorization: Bearer <key>";

function toDate(value) {
	if (value == null) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function parseList(value) {
	if (Array.isArray(value)) return value;
	try {
		const list = JSON.parse(value ?? "[]");
		return Array.isArray(list) ? list : [];
	} catch {
		return [];
	}
}

// Better Auth's ids are random strings of letters and digits.
function isAuthId(value) {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function createUnauthorizedError(message, error = "invalid_token") {
	return new APIError("UNAUTHORIZED", { message, error, error_description: message });
}

// The access token's claims, once its signature, issuer, audience (/mcp), expiry, DPoP proof if it's bound to a
// key, and scope check out. The signing keys come from the database through Better Auth, not over HTTP.
async function verifyAccessToken(request) {
	const authorization = parseAccessTokenAuthorization(request.headers.get("authorization"));
	if (!authorization?.token || authorization.scheme === "Unknown") throw createUnauthorizedError(SIGN_IN_MESSAGE);
	const auth = await getAuth();
	const appUrl = getAppUrl();
	let payload;
	try {
		payload = await verifyJwsAccessToken(authorization.token, {
			jwksFetch: () => auth.api.getJwks(),
			jwksCacheKey: auth,
			verifyOptions: { issuer: getOAuthIssuer(appUrl), audience: getMcpResource(appUrl), typ: ACCESS_TOKEN_TYPE },
		});
	} catch (error) {
		if (error instanceof joseErrors.JOSEError || error instanceof TypeError) throw createUnauthorizedError("The access token is invalid or expired");
		throw error;
	}
	try {
		await enforceDpopBinding({
			payload,
			authorization,
			proofJwt: request.headers.get("dpop"),
			method: request.method,
			url: request.url,
			replayStore: createDpopReplayStore((await auth.$context).internalAdapter),
		});
	} catch (error) {
		if (isDpopBindingError(error)) throw createUnauthorizedError(error.message, error.code);
		throw error;
	}
	if (!String(payload.scope ?? "").split(" ").includes(MCP_SCOPE)) throw createInsufficientScopeError([MCP_SCOPE]);
	return payload;
}

// The consent (connected app) the token names, if it's still there for the token's user and app.
async function findConnection(payload) {
	const [id, userId, clientId] = [payload[CONNECTION_CLAIM], payload.sub, payload.azp ?? payload.client_id];
	if (![id, userId].every(isAuthId) || typeof clientId !== "string") return null;
	return getOne(`SELECT id AS _id, clientId, userId, lastUsedAt FROM ${OAUTH_MODELS.consent} WHERE id = ? AND userId = ? AND clientId = ?`, [id, userId, clientId]);
}

// The account an MCP request with an OAuth token works in: its user's organization's, while the app stays connected.
// Fails with Better Auth's errors, which getOAuthChallenge turns into a 401 or 403 that clients act on.
export async function authenticateAccessToken(request) {
	const payload = await verifyAccessToken(request);
	const consent = await findConnection(payload);
	if (!consent) throw createUnauthorizedError("This app was disconnected. Connect it again.");
	const user = await findUser(payload.sub);
	// On a self-hosted server, someone taken off the allowlist takes their connections with them.
	if (!user || (!isCloud() && !isUserAllowed(user))) throw createUnauthorizedError("This account can't sign in anymore");
	const membership = await findMembership(user._id);
	if (!membership) throw createUnauthorizedError("This account isn't in an organization anymore");
	const { account, member } = membership;
	if (isDeletionPending(account)) throw createUnauthorizedError("This account is being deleted");

	const now = new Date();
	if (shouldTouchLastUsed(toDate(consent.lastUsedAt), now.getTime())) {
		await execute(`UPDATE ${OAUTH_MODELS.consent} SET lastUsedAt = ? WHERE id = ?`, [now.toISOString(), consent._id]).catch((error) =>
			console.error("[oauth] Could not update lastUsedAt:", error.message)
		);
	}
	return {
		account,
		user: { id: String(user._id), email: user.email },
		member,
		connection: { id: String(consent._id), clientId: consent.clientId },
		scopes: String(payload.scope).split(" "),
		expiresAt: payload.exp,
	};
}

// The WWW-Authenticate challenge (and status) for a failed MCP request, pointing at the protected resource
// metadata, so ChatGPT and Claude find the authorization server and sign the user in. Null for other errors.
export function getOAuthChallenge(error) {
	const challenge = createResourceServerChallenge(error, getMcpResource(getAppUrl()), { challengeScopes: [MCP_SCOPE] });
	if (!challenge) return null;
	return { status: challenge.statusCode, header: new Headers(challenge.headers).get("www-authenticate") };
}

async function findClients(clientIds) {
	const clients = await getAll(`SELECT clientId, name, redirectUris FROM ${OAUTH_MODELS.client} WHERE clientId IN (SELECT value FROM json_each(?))`, [
		JSON.stringify(clientIds),
	]);
	return clients.map((client) => ({ ...client, redirectUris: parseList(client.redirectUris) }));
}

// The authorization request Better Auth sent to the sign-in or consent page, if its signature holds and it
// hasn't expired (10 minutes), with the app asking.
export async function readOAuthRequest(searchParams) {
	const query = pickSignedOAuthQuery(searchParams);
	if (!query) return null;
	const auth = await getAuth();
	if (!(await verifyOAuthQueryParams(query, (await auth.$context).secret))) return { query, isExpired: true };
	const { clientId, redirectUri, scopes } = readOAuthQuery(query);
	const [client] = clientId ? await findClients([clientId]) : [];
	return { query, isExpired: false, redirectUri, scopes, client: describeClient(client, redirectUri) };
}

// Allow or deny, then where the browser goes: back to the app, with a code or with access_denied.
export async function answerConsent({ query, accept }) {
	const auth = await getAuth();
	const result = await auth.api.oauth2Consent({ body: { accept, oauth_query: query }, ...(await getAuthCallContext("/oauth2/consent")) });
	return result?.url ?? null;
}

// The apps the account's members connected with OAuth, newest first.
export async function listConnectedApps(account) {
	const consents = await getAll(
		`SELECT id AS _id, clientId, scopes, createdAt, lastUsedAt FROM ${OAUTH_MODELS.consent} WHERE userId IN (${MEMBER_IDS}) ORDER BY createdAt DESC`,
		[accountIdOf(account)]
	);
	const clients = new Map((await findClients([...new Set(consents.map(({ clientId }) => clientId))])).map((client) => [client.clientId, client]));
	return consents.map((consent) => ({
		id: String(consent._id),
		clientId: consent.clientId,
		...describeClient(clients.get(consent.clientId)),
		scopes: parseList(consent.scopes),
		createdAt: toDate(consent.createdAt),
		lastUsedAt: toDate(consent.lastUsedAt),
	}));
}

export async function hasConnectedApp(account) {
	return Boolean(await getOne(`SELECT 1 AS found FROM ${OAUTH_MODELS.consent} WHERE userId IN (${MEMBER_IDS}) LIMIT 1`, [accountIdOf(account)]));
}

// Its tokens go first, then the consent: from then on every token the app holds answers 401, and connecting
// again means a new consent.
export async function revokeConnectedApp(account, id) {
	const consent = isAuthId(id)
		? await getOne(`SELECT id AS _id, clientId, userId FROM ${OAUTH_MODELS.consent} WHERE id = ? AND userId IN (${MEMBER_IDS})`, [id, accountIdOf(account)])
		: null;
	if (!consent) throw actionError("not_found", "App not found");
	const db = await connectDb();
	const userId = String(consent.userId);
	const tokens = [userId, consent.clientId];
	// Access tokens first: they reference the refresh tokens.
	await db.batch([
		statement(db, `DELETE FROM ${OAUTH_MODELS.accessToken} WHERE userId = ? AND clientId = ?`, tokens),
		statement(db, `DELETE FROM ${OAUTH_MODELS.refreshToken} WHERE userId = ? AND clientId = ?`, tokens),
		statement(db, `DELETE FROM ${OAUTH_MODELS.consent} WHERE id = ? AND userId = ?`, [consent._id, userId]),
	]);
	return String(consent._id);
}

// Every app connected to the account, at once: when it's deleted.
export async function disconnectAllApps(account) {
	const db = await connectDb();
	const members = [accountIdOf(account)];
	await db.batch([
		statement(db, `DELETE FROM ${OAUTH_MODELS.accessToken} WHERE userId IN (${MEMBER_IDS})`, members),
		statement(db, `DELETE FROM ${OAUTH_MODELS.refreshToken} WHERE userId IN (${MEMBER_IDS})`, members),
		statement(db, `DELETE FROM ${OAUTH_MODELS.consent} WHERE userId IN (${MEMBER_IDS})`, members),
	]);
}

// Every app a person connected: when they leave an organization, since their apps would follow them to the next one.
export async function disconnectUserApps(userId) {
	const db = await connectDb();
	const user = [String(userId)];
	await db.batch([
		statement(db, `DELETE FROM ${OAUTH_MODELS.accessToken} WHERE userId = ?`, user),
		statement(db, `DELETE FROM ${OAUTH_MODELS.refreshToken} WHERE userId = ?`, user),
		statement(db, `DELETE FROM ${OAUTH_MODELS.consent} WHERE userId = ?`, user),
	]);
}
