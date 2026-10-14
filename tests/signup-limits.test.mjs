import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { execute, getValue, newId } from "../lib/db.js";
import { getAliasPattern, getCanonicalEmail } from "../lib/email-aliases.js";
import { as, catchRedirect, form, platformEmails, signIn, startTestApp, withEnv } from "./helpers/app.mjs";

test("an address's inbox: Gmail ignores dots and +tags, these providers +tags, Yahoo -tags", () => {
	assert.equal(getCanonicalEmail("Jane.Doe+news@googlemail.com"), "janedoe@gmail.com");
	assert.equal(getCanonicalEmail("janedoe+2@gmail.com"), "janedoe@gmail.com");
	for (const domain of ["outlook.com", "hotmail.fr", "live.com", "icloud.com", "fastmail.com", "proton.me", "protonmail.com"]) {
		assert.equal(getCanonicalEmail(`jane.doe+promo@${domain}`), `jane.doe@${domain}`, domain);
	}
	assert.equal(getCanonicalEmail("sam-news@yahoo.com"), "sam@yahoo.com");
	assert.equal(getCanonicalEmail("sam+news@yahoo.com"), "sam+news@yahoo.com", "Yahoo has no +tags");
	assert.equal(getCanonicalEmail("jane-doe@outlook.com"), "jane-doe@outlook.com");
	assert.equal(getCanonicalEmail("jane.doe+promo@example.com"), "jane.doe+promo@example.com", "other domains decide for themselves");
	assert.equal(getCanonicalEmail("not an email"), null);

	const gmail = getAliasPattern("jane.doe@gmail.com");
	for (const email of ["jane.doe@gmail.com", "j.a.n.e.d.o.e@gmail.com", "janedoe+x@googlemail.com", "jan.edoe+news.letter@gmail.com"]) assert.match(email, gmail);
	for (const email of ["jane.does@gmail.com", "jane.do@gmail.com", "jane.doe@gmail.co", "xjane.doe@gmail.com", "jane.doe@outlook.com"]) assert.doesNotMatch(email, gmail);
	assert.doesNotMatch("jane.doe@outlook.com", getAliasPattern("janedoe+x@outlook.com"), "dots count at Outlook");
	assert.equal(getAliasPattern("jane@example.com"), null);
	assert.match("a*b+x@outlook.com", getAliasPattern("a*b@outlook.com"));
	assert.doesNotMatch("aaab@outlook.com", getAliasPattern("a*b@outlook.com"), "the address is escaped");
});

describe("sign-ups on MailCheap Cloud", () => {
	let app;
	let m;
	let nextIp = 0;

	const countUsers = (email) => getValue("SELECT count(*) FROM users WHERE email = ?", [email]);

	// A user and their account from before these checks, as Better Auth and the sign-up wrote them.
	async function insertUser(email) {
		const now = new Date().toISOString();
		const id = `before-${newId()}`;
		await execute("INSERT INTO users (id, email, emailVerified, name, createdAt, updatedAt, inbox) VALUES (?, ?, 1, '', ?, ?, ?)", [
			id,
			email,
			now,
			now,
			getCanonicalEmail(email),
		]);
		await execute("INSERT INTO accounts (_id, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?)", [newId(), id, Date.now(), Date.now()]);
	}
	const visitor = (email) => ({ email, jar: new Map(), ip: `203.0.113.${++nextIp}` });

	// The sign-in form, step by step: { email } once the code is out, then where it leads or why not.
	async function signUp(email, person = visitor(email)) {
		const sent = await as(person, () => m.signin.sendSigninCode(null, form({ email })));
		if (sent.error) return sent;
		const code = platformEmails.findLast(({ to }) => to.includes(email)).subject.slice(0, 6);
		try {
			return await as(person, () => m.signin.verifySigninCode(null, form({ email, code, next: "/" })));
		} catch (error) {
			if (error?.url) return { redirectedTo: error.url };
			throw error;
		}
	}

	before(async () => {
		app = await startTestApp({ GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret" });
		m = {
			auth: await import("../lib/auth.js"),
			signin: await import("../app/signin/actions.js"),
		};
	});

	after(() => app?.stop());

	test("one account per inbox: a +tag or dots on the same Gmail is told to use the first account", async () => {
		await signIn("jane.doe@gmail.com");
		for (const alias of ["janedoe+2@gmail.com", "j.anedoe@googlemail.com"]) {
			assert.deepEqual(await signUp(alias), { email: alias, error: m.auth.SIGNUP_ERRORS.email_alias }, alias);
			assert.equal(await countUsers(alias), 0);
		}
		assert.equal(m.auth.SIGNUP_ERRORS.email_alias, "An account already uses this inbox under another address. Sign in with that address instead.");
		assert.ok(await signIn("jane.doe@gmail.com"), "the first account signs in as before");
		assert.ok(await signIn("john.doe@gmail.com"), "another inbox");
	});

	test("the same goes for Outlook's +tags and Yahoo's -tags, whichever came first", async () => {
		await signIn("jane+promo@outlook.com");
		assert.equal((await signUp("jane@outlook.com")).error, m.auth.SIGNUP_ERRORS.email_alias);
		await signIn("sam@yahoo.com");
		assert.equal((await signUp("sam-news@yahoo.com")).error, m.auth.SIGNUP_ERRORS.email_alias);
		assert.ok(await signIn("jane.doe@outlook.com"), "dots count at Outlook");
	});

	test("accounts that share an inbox from before keep signing in", async () => {
		for (const email of ["janeroe@gmail.com", "jane.roe+old@gmail.com"]) await insertUser(email);
		for (const email of ["janeroe@gmail.com", "jane.roe+old@gmail.com"]) assert.ok(await signIn(email), email);
	});

	test("throwaway inboxes get no code and no account; one from before still signs in", async () => {
		const emailsBefore = platformEmails.length;
		assert.deepEqual(await signUp("burner@mailinator.com"), { error: m.auth.SIGNUP_ERRORS.email_disposable });
		assert.deepEqual(await signUp("burner@eu.yopmail.com"), { error: "Throwaway inboxes can't sign up. Use your own email." });
		assert.equal(platformEmails.length, emailsBefore, "no code went out");

		const context = await (await m.auth.getAuth()).$context;
		await assert.rejects(
			context.internalAdapter.createUser({ email: "inside@mailinator.com", emailVerified: true, name: "" }),
			(error) => error.body?.code === "email_disposable"
		);
		await insertUser("old@yopmail.com");
		assert.ok(await signIn("old@yopmail.com"));
	});

	test("3 new accounts a day per network; people who have one still sign in from there", async () => {
		const network = (email) => ({ email, jar: new Map(), ip: "203.0.113.250" });
		for (const email of ["office1@example.com", "office2@example.com", "office3@example.com"]) {
			assert.deepEqual(await signUp(email, network(email)), { redirectedTo: "/" }, email);
		}
		assert.deepEqual(await signUp("office4@example.com", network("office4@example.com")), {
			email: "office4@example.com",
			error: "Too many new accounts from your network today. Try again tomorrow.",
		});
		assert.equal(await countUsers("office4@example.com"), 0);
		assert.deepEqual(await signUp("office1@example.com", network("office1@example.com")), { redirectedTo: "/" });
		assert.deepEqual(await signUp("office4@example.com"), { redirectedTo: "/" }, "from another network");
	});

	test("Google sign-ups get the same checks, and /signin says why", async () => {
		await signIn("john.roe@gmail.com");
		const refused = await signInWithGoogle(m, "johnroe+2@gmail.com");
		assert.deepEqual(refused, { path: "/signin", error: "email_alias", isSignedIn: false });
		assert.equal(await countUsers("johnroe+2@gmail.com"), 0);
		assert.equal(m.auth.getSignupError(refused.error), m.auth.SIGNUP_ERRORS.email_alias);
		assert.equal(m.auth.getSignupError("constructor"), null);
		assert.deepEqual(await signInWithGoogle(m, "john.roe@gmail.com"), { path: "/", error: null, isSignedIn: true }, "the same address signs in");
	});

	test("an address Google hasn't verified opens no user and no account, so its owner never finds one waiting", async () => {
		const refused = await signInWithGoogle(m, "jo@company.example", { verified: false });
		assert.deepEqual(refused, { path: "/signin", error: "email_unverified", isSignedIn: false });
		assert.equal(await countUsers("jo@company.example"), 0);
		assert.equal(m.auth.getSignupError(refused.error), "Google hasn't verified this email. Sign in with a code instead.");
		assert.deepEqual(await signInWithGoogle(m, "jo@company.example"), { path: "/", error: null, isSignedIn: true }, "once Google verified it");
	});

	test("self-hosted servers decide with their allowlist alone", async () => {
		await withEnv({ MAILCHEAP_CLOUD: "", ALLOWED_EMAILS: "@gmail.com", EMAIL_FROM: "MailCheap <login@mail.example.com>" }, async () => {
			assert.ok(await signIn("jane.doe+selfhosted@gmail.com"));
		});
	});
});

// Google's consent, then its callback with a code Better Auth trades for an ID token (as in tests/self-host.test.mjs).
async function signInWithGoogle(m, email, { verified = true } = {}) {
	const person = { jar: new Map(), ip: "203.0.113.200" };
	const url = new URL(await as(person, () => catchRedirect(m.signin.signinWithGoogle(form({ next: "/" })))));
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const claims = { iss: "https://accounts.google.com", aud: "google-client", iat: now, exp: now + 3600, sub: email, email, email_verified: verified, name: "Jo" };
	const idToken = [encode({ alg: "RS256", kid: "test" }), encode(claims), "c2lnbmF0dXJl"].join(".");
	const previousFetch = globalThis.fetch;
	globalThis.fetch = (input, init) =>
		String(input?.url ?? input) === "https://oauth2.googleapis.com/token"
			? Promise.resolve(Response.json({ access_token: "ya29.test", token_type: "Bearer", expires_in: 3599, scope: "openid email profile", id_token: idToken }))
			: previousFetch(input, init);
	try {
		const { GET } = await import("../app/api/auth/[...all]/route.js");
		const cookie = [...person.jar].map(([name, value]) => `${name}=${value}`).join("; ");
		const callback = new Request(`http://localhost:3000/api/auth/callback/google?code=test-code&state=${url.searchParams.get("state")}`, { headers: { cookie } });
		const response = await as(person, () => GET(callback));
		const location = new URL(response.headers.get("location"), "http://localhost:3000");
		const cookies = response.headers.getSetCookie().filter((line) => line.startsWith("better-auth.session_token=") && !line.startsWith("better-auth.session_token=;"));
		return { path: location.pathname, error: location.searchParams.get("error"), isSignedIn: cookies.length > 0 };
	} finally {
		globalThis.fetch = previousFetch;
	}
}
