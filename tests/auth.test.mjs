import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getOne, getValue } from "../lib/db.js";
import { anonymous, as, catchNotFound, catchRedirect, form, platformEmails, signIn, startTestApp } from "./helpers/app.mjs";

let app;
let auth;
let actions;
let accounts;

before(async () => {
	app = await startTestApp();
	auth = await import("../lib/auth.js");
	actions = await import("../app/signin/actions.js");
	accounts = await import("../lib/accounts.js");
});

after(() => app?.stop());

test("the first sign-in creates the user and their account; the next ones reuse them", async () => {
	const first = await signIn("new@example.com");
	assert.ok(first.account, "account created at the first sign-in");
	assert.equal(String(first.account.ownerId), String(first.userId));
	assert.equal(first.account.subscriptionStatus, null, "no plan before checkout");
	assert.equal(first.account.status, "active");

	const again = await signIn("New@Example.com");
	assert.equal(String(again.accountId), String(first.accountId));
	assert.equal(await getValue("SELECT count(*) FROM accounts WHERE ownerId = ?", [first.userId]), 1);
	assert.equal(await getValue("SELECT count(*) FROM users WHERE email = ?", ["new@example.com"]), 1);
});

test("a returning user's sign-in opens no second account", async () => {
	const first = await signIn("signup@example.com");
	await signIn("signup@example.com");
	assert.equal(await accounts.createAccount(first.userId), false, "the account exists");
	assert.equal(await getValue("SELECT count(*) FROM accounts WHERE ownerId = ?", [first.userId]), 1);
});

test("sign-in codes go out through Resend and are stored hashed", async () => {
	const user = { email: "codes@example.com", jar: new Map(), ip: "198.51.100.200" };
	await as(user, () => actions.sendSigninCode(null, form({ email: user.email })));
	const email = platformEmails.at(-1);
	assert.deepEqual(email.to, [user.email]);
	assert.match(email.subject, /^\d{6} is your MailCheap code$/);
	const code = email.subject.slice(0, 6);
	const stored = await getOne("SELECT * FROM verifications WHERE identifier = ?", [`sign-in-otp-${user.email}`]);
	assert.ok(stored, "the code is waiting to be used");
	assert.equal(stored.value.includes(code), false, "the code itself isn't in the database");
});

test("an inbox gets 5 codes every 15 minutes, whatever dots or +tags its address takes", async () => {
	const emailsBefore = platformEmails.length;
	const addresses = ["jane.doe@gmail.com", "janedoe+1@gmail.com", "j.a.n.e.d.o.e@googlemail.com", "janedoe+2@gmail.com", "Jane.Doe+3@gmail.com"];
	for (const [index, email] of addresses.entries()) {
		const visitor = { jar: new Map(), ip: `198.51.100.${150 + index}` };
		assert.deepEqual(await as(visitor, () => actions.sendSigninCode(null, form({ email }))), { email: email.toLowerCase() }, email);
	}
	const sixth = { jar: new Map(), ip: "198.51.100.160" };
	assert.deepEqual(await as(sixth, () => actions.sendSigninCode(null, form({ email: "janedoe+4@gmail.com" }))), {
		error: "Too many codes. Try again in 15 minutes.",
	});
	assert.equal(platformEmails.length - emailsBefore, 5);
});

test("a wrong code doesn't sign in and doesn't set a session", async () => {
	const user = { email: "wrong@example.com", jar: new Map(), ip: "198.51.100.201" };
	await as(user, () => actions.sendSigninCode(null, form({ email: user.email })));
	const result = await as(user, () => actions.verifySigninCode(null, form({ email: user.email, code: "000000" })));
	assert.deepEqual(result, { email: user.email, error: "This code is wrong or expired" });
	assert.equal(user.jar.size, 0);
	assert.equal(await as(user, () => auth.getCurrentAccount()), null);
});

test("without a Resend key the code only shows in the console, and only in development", async () => {
	const previous = { key: process.env.RESEND_API_KEY, env: process.env.NODE_ENV };
	const logged = [];
	const info = console.info;
	console.info = (...args) => logged.push(args.join(" "));
	try {
		delete process.env.RESEND_API_KEY;
		process.env.NODE_ENV = "development";
		const user = { email: "dev@example.com", jar: new Map(), ip: "198.51.100.202" };
		assert.deepEqual(await as(user, () => actions.sendSigninCode(null, form({ email: user.email }))), { email: user.email });
		assert.ok(logged.some((line) => /\[signin\] Code for dev@example\.com: \d{6}/.test(line)));

		logged.length = 0;
		process.env.NODE_ENV = "production";
		const result = await as(user, () => actions.sendSigninCode(null, form({ email: "prod@example.com" })));
		assert.equal(result.error, "Couldn't send the code. Try again in a minute.");
		assert.equal(logged.some((line) => line.includes("Code for")), false, "never logged in production");
	} finally {
		console.info = info;
		process.env.RESEND_API_KEY = previous.key;
		process.env.NODE_ENV = previous.env;
	}
});

test("pages need a session, and open without a plan", async () => {
	assert.equal(await anonymous(() => catchRedirect(auth.requireAccount())), "/signin");
	const user = await signIn("unpaid@example.com");
	const { account } = await as(user, () => auth.requireAccount());
	assert.equal(String(account._id), String(user.accountId));
	assert.equal(account.subscriptionStatus, null);
});

test("signing out ends the session", async () => {
	const user = await signIn("leaving@example.com");
	assert.equal(await as(user, () => catchRedirect(actions.signOut())), "/signin");
	assert.equal(await as(user, () => auth.getCurrentAccount()), null);
});

test("only verified ADMIN_EMAILS are admins, and the admin pages 404 for everyone else", async () => {
	assert.equal(auth.isAdmin({ email: "Admin@Example.com", emailVerified: true }), true);
	assert.equal(auth.isAdmin({ email: "admin@example.com", emailVerified: false }), false);
	assert.equal(auth.isAdmin({ email: "someone@example.com", emailVerified: true }), false);

	const admin = await signIn("admin@example.com");
	const someone = await signIn("someone@example.com");
	assert.equal((await as(admin, () => auth.requireAdmin())).email, "admin@example.com");
	assert.equal(await as(someone, () => catchNotFound(auth.requireAdmin())), true);
	assert.equal(await anonymous(() => catchNotFound(auth.requireAdmin())), true);
});
