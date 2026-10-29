import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { emailOTP } from "better-auth/plugins/email-otp";
import { jwt } from "better-auth/plugins/jwt";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { isDeletionPending } from "@/lib/account-state";
import { AUTH_MODELS, findAliasUser, findUser, isUserAllowed } from "@/lib/accounts";
import { APP_NAME, AUTH_COOKIE_PREFIX, getAdminEmails, getAppSecret, getAppUrl, isCloud } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { noticeDeletedBefore } from "@/lib/deletion-records";
import { isDisposableDomain } from "@/lib/disposable-domains";
import { getCanonicalEmail } from "@/lib/email-aliases";
import { CONNECTION_CLAIM, CONSENT_PATH, OAUTH_SCOPES, canRegisterRedirectUris, getMcpResource, getOAuthIssuer } from "@/lib/oauth-rules";
import { INVITATIONS_PATH, findMembership, hasInvitations, openOrganization } from "@/lib/organizations";
import { sendDeletionCode, sendSigninCode } from "@/lib/platform-email";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { siteExtensions } from "@/lib/site-extensions";

// The error code a refused sign-in carries, also on the Google callback's redirect to /signin.
export const SIGNIN_NOT_ALLOWED = "email_not_allowed";
export const SIGNIN_NOT_ALLOWED_MESSAGE = "This email can't sign in to this server. Ask its admin to add it to ALLOWED_EMAILS.";

// What /signin and the code form say for each refused sign-up, by its code.
export const SIGNUP_ERRORS = {
	[SIGNIN_NOT_ALLOWED]: SIGNIN_NOT_ALLOWED_MESSAGE,
	email_alias: "An account already uses this inbox under another address. Sign in with that address instead.",
	email_disposable: "Throwaway inboxes can't sign up. Use your own email.",
	email_unverified: "Google hasn't verified this email. Sign in with a code instead.",
	signup_limit: "Too many new accounts from your network today. Try again tomorrow.",
};

// MailCheap Cloud: new accounts per IP address, whatever the email.
const SIGNUPS_PER_IP = { name: "signup-ip", limit: 3, window: "1 d" };

export function getSignupError(code) {
	return Object.hasOwn(SIGNUP_ERRORS, code ?? "") ? SIGNUP_ERRORS[code] : null;
}

// Codes are sent and checked by server actions with the app's own rate limits (app/signin/actions.js,
// app/(account)/organization/actions.js), so the plugin's HTTP routes stay closed, and so do the password routes it
// adds. The account page changes the name and photo, checked there.
const DISABLED_PATHS = [
	"/email-otp/send-verification-otp",
	"/email-otp/check-verification-otp",
	"/email-otp/verify-email",
	"/sign-in/email-otp",
	"/email-otp/request-password-reset",
	"/forget-password/email-otp",
	"/email-otp/reset-password",
	"/email-otp/request-email-change",
	"/email-otp/change-email",
	"/update-user",
];

// Deleting an account takes a code of its own: Better Auth's email-verification kind, which nothing else here sends,
// so a sign-in code can't delete an account and a deletion code can't sign in.
const DELETION_CODE = "email-verification";
const CODE_EMAILS = { "sign-in": sendSigninCode, [DELETION_CODE]: sendDeletionCode };

// Client and consent management that only the consent page and the API keys page do, on the server. The JWT
// plugin's session token (/token) would be signed with the same key as access tokens. Discovery lists the rest.
const OAUTH_DISABLED_PATHS = [
	"/token",
	"/oauth2/consent",
	"/oauth2/continue",
	"/oauth2/create-client",
	"/oauth2/get-client",
	"/oauth2/get-clients",
	"/oauth2/update-client",
	"/oauth2/client/rotate-secret",
	"/oauth2/delete-client",
	"/oauth2/public-client",
	"/oauth2/public-client-prelogin",
	"/oauth2/get-consent",
	"/oauth2/get-consents",
	"/oauth2/update-consent",
	"/oauth2/delete-consent",
];

// An idle connection signs out after this; every refresh starts it again.
const REFRESH_TOKEN_SECONDS = 90 * 24 * 3600;

const REGISTRATIONS_PER_IP = { name: "oauth-registrations", limit: 10, window: "1 h" };

// Better Auth checks a registered app's redirect URIs as a web app's, https only. So it registers the https ones,
// and the app's own scheme from the allowlist (cursor://) is added to the client once it exists, by the after
// hook, which runs on the same request.
const appSchemeRedirects = new WeakMap();

// Better Auth logs a failed send and carries on, so the sign-in form would say a code is on its way.
// The failure travels back to sendSigninCodeEmail through this.
const codeDelivery = new AsyncLocalStorage();

export function isGoogleEnabled() {
	return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function refuseSignup(code) {
	throw new APIError("FORBIDDEN", { code, message: SIGNUP_ERRORS[code] });
}

// A self-hosted server lets only its allowlist in (lib/config.js), however they sign in: every new user and
// every new session are checked here, so no Better Auth route can get around it. A hook that returns false
// cancels the write, so these return nothing.
function refuseUnlessAllowed(user) {
	if (isCloud() || isUserAllowed(user)) return;
	refuseSignup(SIGNIN_NOT_ALLOWED);
}

// MailCheap Cloud: one account per inbox, none on a throwaway inbox, and a few new ones a day per network, with a
// code or with Google. It runs once the code or Google proved the address, so it tells nobody else about an account.
// Accounts that exist already are left as they are.
async function refuseFarmedSignup(user, ctx) {
	if (!isCloud()) return;
	if (isDisposableDomain(user.email.split("@")[1])) refuseSignup("email_disposable");
	if (await findAliasUser(user.email)) refuseSignup("email_alias");
	const ip = ctx?.headers ? getClientIp(ctx.headers) : "unknown";
	if (ip !== "unknown" && (await isRateLimited({ ...SIGNUPS_PER_IP, key: ip }))) refuseSignup("signup_limit");
}

// An address Google hasn't verified may be someone else's, who would later sign in with a code to the account it
// opened, and find the apps it connected still there.
// The user's inbox goes with it (users.inbox), so lib/accounts.js findAliasUser can match it without a regex.
async function checkNewUser(user, ctx) {
	if (!user.emailVerified) refuseSignup("email_unverified");
	refuseUnlessAllowed(user);
	await refuseFarmedSignup(user, ctx);
	return { data: { ...user, inbox: getCanonicalEmail(user.email) ?? String(user.email).toLowerCase() } };
}

async function refuseSessionUnlessAllowed(session) {
	if (!isCloud()) refuseUnlessAllowed(await findUser(session.userId));
}

// Runs in the sign-in's server action or Google's callback, once per new user: a returning one creates none. Someone
// invited opens none either: they join from /invitations.
async function openAccount(user) {
	if (await hasInvitations(user.email)) return;
	if (!(await openOrganization(user))) return;
	await siteExtensions.sendGoalOnNextPage("signup_completed");
	await noticeDeletedBefore(user.email);
}

async function deliverCode({ email, otp, type }) {
	const send = CODE_EMAILS[type];
	if (!send) return;
	try {
		await send({ email, code: otp });
	} catch (error) {
		const delivery = codeDelivery.getStore();
		if (delivery) delivery.error = error;
		throw error;
	}
}

// The consent an access token comes from, named in the token (lib/oauth.js checks it on every MCP request).
async function bindToConsent({ ctx, user, client }) {
	if (!user) return {};
	const consent = await ctx.context.adapter.findOne({
		model: "oauthConsent",
		where: [
			{ field: "clientId", value: client.clientId },
			{ field: "userId", value: user.id },
		],
	});
	return consent ? { [CONNECTION_CLAIM]: consent.id } : {};
}

// Dynamic registration (RFC 7591) is for Grok Bot: every redirect URI on the allowlist (lib/oauth-rules.js), and a
// public client, which PKCE then protects. A backchannel_logout_uri would have this server post to it at sign-out.
async function checkRegistration(ctx) {
	if (await isRateLimited({ ...REGISTRATIONS_PER_IP, key: getClientIp(ctx.headers) })) {
		throw new APIError("TOO_MANY_REQUESTS", { error: "rate_limited", error_description: "Too many registrations from this address. Try again in an hour." });
	}
	const { redirect_uris: redirectUris, token_endpoint_auth_method: authMethod, backchannel_logout_uri: logoutUri } = ctx.body ?? {};
	if (!canRegisterRedirectUris(redirectUris)) {
		throw new APIError("BAD_REQUEST", {
			error: "invalid_redirect_uri",
			error_description: "These redirect URIs can't register here. Identify the app with a client metadata document.",
		});
	}
	if (authMethod !== "none" || logoutUri !== undefined) {
		throw new APIError("BAD_REQUEST", {
			error: "invalid_client_metadata",
			error_description: "Register a public client: token_endpoint_auth_method none, with PKCE, and no backchannel_logout_uri.",
		});
	}
	const webRedirects = redirectUris.filter((uri) => uri.startsWith("https://"));
	if (webRedirects.length === 0 || webRedirects.length === redirectUris.length || !ctx.request) return;
	appSchemeRedirects.set(ctx.request, redirectUris);
	return { context: { body: { ...ctx.body, redirect_uris: webRedirects } } };
}

async function addAppSchemeRedirects(ctx) {
	const redirectUris = ctx.request && appSchemeRedirects.get(ctx.request);
	const client = ctx.context.returned;
	if (!redirectUris || !client?.client_id) return;
	await ctx.context.adapter.update({ model: "oauthClient", where: [{ field: "clientId", value: client.client_id }], update: { redirectUris } });
	return ctx.json({ ...client, redirect_uris: redirectUris });
}

async function createAuth() {
	// D1 has no interactive transactions; Better Auth's D1 dialect runs without them.
	const db = await connectDb();
	const appUrl = getAppUrl();
	const auth = betterAuth({
		appName: APP_NAME,
		baseURL: appUrl,
		secret: getAppSecret(),
		database: db,
		user: { modelName: AUTH_MODELS.user, additionalFields: { inbox: { type: "string", required: false, input: false, returned: false } } },
		session: { modelName: AUTH_MODELS.session },
		// No trusted providers: a Google sign-in joins an existing user only when Google verified that email.
		account: { modelName: AUTH_MODELS.account },
		verification: { modelName: AUTH_MODELS.verification },
		...(isGoogleEnabled() && {
			socialProviders: {
				google: {
					clientId: process.env.GOOGLE_CLIENT_ID,
					clientSecret: process.env.GOOGLE_CLIENT_SECRET,
					prompt: "select_account",
				},
			},
		}),
		advanced: { cookiePrefix: AUTH_COOKIE_PREFIX },
		disabledPaths: [...DISABLED_PATHS, ...OAUTH_DISABLED_PATHS],
		databaseHooks: {
			user: { create: { before: checkNewUser, after: openAccount } },
			session: { create: { before: refuseSessionUnlessAllowed } },
		},
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path === "/oauth2/register") return checkRegistration(ctx);
			}),
			after: createAuthMiddleware(async (ctx) => {
				if (ctx.path === "/oauth2/register") return addAppSchemeRedirects(ctx);
			}),
		},
		plugins: [
			emailOTP({ storeOTP: "hashed", sendVerificationOTP: deliverCode }),
			// Signs access and ID tokens with a key it creates and keeps in the jwks collection, encrypted with
			// BETTER_AUTH_SECRET. RS256 is the one algorithm every OpenID client verifies.
			jwt({
				jwt: { issuer: getOAuthIssuer(appUrl) },
				jwks: { keyPairConfig: { alg: "RS256", modulusLength: 2048 } },
				disableSettingJwtHeader: true,
			}),
			// ChatGPT and Claude connect to /mcp with OAuth: they find this server through /.well-known, identify
			// themselves with a client metadata document (cimd below) and get tokens bound to /mcp. Grok Bot registers
			// instead (checkRegistration), and mcp() binds registered clients to /mcp too.
			mcp({
				resource: getMcpResource(appUrl),
				loginPage: "/signin",
				consentPage: CONSENT_PATH,
				// prompt=select_account lands on the consent page, which shows the account and lets people switch.
				selectAccount: { page: CONSENT_PATH, shouldRedirect: async () => false },
				scopes: OAUTH_SCOPES,
				grantTypes: ["authorization_code", "refresh_token"],
				refreshTokenExpiresIn: REFRESH_TOKEN_SECONDS,
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				// Token requests from ChatGPT and Claude come from a few addresses for all their users. Registrations
				// have their own limit, shared by every server instance (REGISTRATIONS_PER_IP).
				rateLimit: { token: false, register: false },
				extensions: [{ claims: { accessToken: bindToConsent } }],
			}),
			cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
			nextCookies(),
		],
	});
	return auth;
}

let authPromise;

// Built on first use, with the D1 binding (migrations/0007_auth.sql holds its tables).
export function getAuth() {
	authPromise ??= createAuth().catch((error) => {
		authPromise = undefined;
		throw error;
	});
	return authPromise;
}

// Better Auth's own routes: sessions, Google, OAuth and the discovery documents under /.well-known.
export async function handleAuthRequest(request) {
	return (await getAuth()).handler(request);
}

// For server actions that may finish an authorization request (a sign-in while ChatGPT connects, a consent):
// Better Auth resumes it from the request it runs in, and adds headers to it, so it gets a request of its own.
export async function getAuthCallContext(path) {
	const requestHeaders = new Headers(await headers());
	const request = new Request(new URL(`/api/auth${path}`, getAppUrl()), { method: "POST", headers: requestHeaders });
	return { headers: requestHeaders, request, asResponse: false };
}

async function sendCodeEmail(email, type) {
	const auth = await getAuth();
	const delivery = {};
	await codeDelivery.run(delivery, () => auth.api.sendVerificationOTP({ body: { email, type } }));
	if (delivery.error) throw delivery.error;
}

export function sendSigninCodeEmail(email) {
	return sendCodeEmail(email, "sign-in");
}

export function sendDeletionCodeEmail(email) {
	return sendCodeEmail(email, DELETION_CODE);
}

// Each code works once, for 5 minutes, and dies after 3 wrong tries (Better Auth's emailOTP).
export async function checkDeletionCode(email, code) {
	try {
		await (await getAuth()).api.verifyEmailOTP({ body: { email, otp: code } });
		return true;
	} catch (error) {
		if (error instanceof APIError) return false;
		throw error;
	}
}

// The current session and its cookie, then every other session of the user, on every device.
export async function signOutEverywhere(userId) {
	const auth = await getAuth();
	await auth.api.signOut({ headers: await headers() });
	await endSessions(userId);
}

// Someone else's sessions, on every device: their next request signs in again.
export async function endSessions(userId) {
	await (await (await getAuth()).$context).internalAdapter.deleteUserSessions(String(userId));
}

// An account's purge: the user with its sessions, its sign-in methods (Google) and its codes waiting to be used.
export async function deleteUser({ id, email }) {
	const { internalAdapter } = await (await getAuth()).$context;
	for (const type of Object.keys(CODE_EMAILS)) await internalAdapter.deleteVerificationByIdentifier(`${type}-otp-${email}`);
	await internalAdapter.deleteUser(String(id));
}

// Headers first: reading them makes the page dynamic, so builds never prerender it or reach the database.
// Someone taken off a self-hosted server's allowlist is signed out from then on.
export const getSession = cache(async () => {
	const requestHeaders = await headers();
	const auth = await getAuth();
	const session = await auth.api.getSession({ headers: requestHeaders });
	return session && (isCloud() || isUserAllowed(session.user)) ? session : null;
});

export function isAdmin(user) {
	return Boolean(user?.emailVerified && getAdminEmails().includes(String(user.email).toLowerCase()));
}

// The signed-in user, their membership, their organization and its account (lib/organizations.js). One opens here
// for them if the sign-up hook didn't, unless an invitation waits: then account is null until they answer it.
export const getCurrentAccount = cache(async () => {
	const session = await getSession();
	if (!session?.user) return null;
	const { user } = session;
	let membership = await findMembership(user.id);
	if (!membership && !(await hasInvitations(user.email))) {
		await openOrganization(user);
		membership = await findMembership(user.id);
	}
	return { user, account: membership?.account ?? null, organization: membership?.organization ?? null, member: membership?.member ?? null };
});

// Server actions run outside proxy.js matching rules, so each one checks the session itself. The dashboard
// opens without a plan; the actions that need one check it (lib/actions/run-action.js). Someone invited and in no
// organization answers the invitation first, and an account waiting to be deleted only opens the page that restores it.
export async function requireAccount() {
	const current = await getCurrentAccount();
	if (!current) redirect("/signin");
	if (!current.account) redirect(INVITATIONS_PATH);
	if (isDeletionPending(current.account)) redirect("/restore");
	return current;
}

export async function requireAdmin() {
	const session = await getSession();
	if (!isAdmin(session?.user)) notFound();
	return session.user;
}
