import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { activate, as, catchNotFound, findAccount, form, signIn, startTestApp } from "./helpers/app.mjs";

let app;
let m;
let admin;
let customer;

before(async () => {
	app = await startTestApp({ ADMIN_EMAILS: "ops@example.com, owner@example.com" });
	m = {
		actions: await import("../app/admin/actions.js"),
		accounts: await import("../lib/accounts.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
	};
	admin = await signIn("ops@example.com");
	customer = await signIn("customer@example.com");
	await activate(customer, { plan: "growth" });
});

after(() => app?.stop());

test("admin actions answer 404 to anyone outside ADMIN_EMAILS, and change nothing", async () => {
	const id = String(customer.accountId);
	assert.equal(await as(customer, () => catchNotFound(m.actions.blockAccountAction(id, "nope"))), true);
	assert.equal(await as(customer, () => catchNotFound(m.actions.unblockAccountAction(id))), true);
	assert.equal(
		await as(customer, () => catchNotFound(m.actions.saveLimits(null, form({ accountId: id, emailsPerMonth: "999999" })))),
		true
	);
	const untouched = await findAccount(customer.accountId);
	assert.equal(untouched.status, "active");
	assert.equal(untouched.limitOverrides?.emailsPerMonth, undefined);
});

test("blocking and unblocking an account", async () => {
	const id = String(customer.accountId);
	assert.deepEqual(await as(admin, () => m.actions.blockAccountAction(id, "Complaints spike")), { ok: true });
	let account = await findAccount(id);
	assert.equal(account.status, "paused");
	assert.equal(account.pauseReason, "Complaints spike");
	assert.equal(account.pausedBy, "admin");
	assert.ok(account.pausedAt instanceof Date);
	assert.deepEqual(await as(admin, () => m.actions.blockAccountAction(id, "again")), { error: "Already blocked" });

	assert.deepEqual(await as(admin, () => m.actions.unblockAccountAction(id)), { ok: true });
	account = await findAccount(id);
	assert.equal(account.status, "active");
	assert.equal(account.pausedAt, null);
	assert.equal(account.pauseReason, null);
	assert.equal(account.pausedBy, null);
	assert.deepEqual(await as(admin, () => m.actions.unblockAccountAction(id)), { error: "Not blocked" });
});

test("limit overrides replace the plan's numbers, and empty fields bring the plan's back", async () => {
	const id = String(customer.accountId);
	const saved = await as(admin, () => m.actions.saveLimits(null, form({ accountId: id, emailsPerMonth: "150,000", subscribers: "" })));
	assert.equal(saved.ok, true);
	let account = await findAccount(id);
	assert.equal(account.limitOverrides.emailsPerMonth, 150_000);
	assert.equal(account.limitOverrides.subscribers, undefined);

	assert.deepEqual(await as(admin, () => m.actions.saveLimits(null, form({ accountId: id, emailsPerMonth: "-5" }))), {
		error: "Use whole numbers, or leave empty for the plan's",
	});
	assert.deepEqual(await as(admin, () => m.actions.saveLimits(null, form({ accountId: id, emailsPerMonth: "1.5" }))), {
		error: "Use whole numbers, or leave empty for the plan's",
	});

	await as(admin, () => m.actions.saveLimits(null, form({ accountId: id, emailsPerMonth: "", subscribers: "" })));
	account = await findAccount(id);
	assert.equal(account.limitOverrides?.emailsPerMonth, undefined);
});

test("the account list shows each owner, plan, status, usage and creation date, newest first", async () => {
	const url = await as(customer, async () => {
		const { catchRedirect } = await import("./helpers/app.mjs");
		return catchRedirect(
			m.newsletters.saveNewsletter(null, form({ name: "News", slug: "customer-news", fromEmail: "hello@customer-news.mailcheapmail.com", postalAddress: "1 Main St" }))
		);
	});
	await as(customer, () =>
		m.contacts.importContacts({ newsletterId: url.split("/").at(-1), consent: true, rows: [{ email: "a@example.org", status: "active" }, { email: "b@example.org", status: "unsubscribed" }] })
	);

	const accounts = await m.accounts.listAccountsForAdmin();
	assert.deepEqual(accounts.map(({ ownerEmail }) => ownerEmail), ["customer@example.com", "ops@example.com"]);
	const [listed] = accounts;
	assert.equal(listed.plan, "growth");
	assert.equal(listed.subscriptionStatus, "active");
	assert.equal(listed.activeContacts, 1);
	assert.equal(listed.usage.emailsSent, 0);
	assert.ok(listed.createdAt instanceof Date);
});
