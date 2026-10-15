import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Stripe from "stripe";
import { execute } from "../lib/db.js";
import { updateRows } from "../lib/records.js";
import { activate, as, callApi, catchRedirect, findAccount, form, mockStripe, signIn, startTestApp } from "./helpers/app.mjs";

// Stripe's API is answered by the handler each test gives mockStripe; events are signed like Stripe signs them.
let app;
let m;
let calls;
let subscriptions;

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

function price(lookupKey, unitAmount, interval) {
	return { id: `price_${lookupKey}`, object: "price", lookup_key: lookupKey, unit_amount: unitAmount, currency: "usd", recurring: { interval } };
}

const PRICES = {
	mailcheap_starter_monthly: price("mailcheap_starter_monthly", 1900, "month"),
	mailcheap_growth_monthly: price("mailcheap_growth_monthly", 3900, "month"),
	mailcheap_growth_yearly: price("mailcheap_growth_yearly", 39_000, "year"),
	mailcheap_pro_monthly: price("mailcheap_pro_monthly", 9900, "month"),
};

function subscription({ id, accountId, customer, status = "active", lookupKey = "mailcheap_starter_monthly", start = NOW, end = NOW + 30 * DAY, ...rest }) {
	return {
		id,
		object: "subscription",
		customer,
		status,
		metadata: accountId ? { accountId: String(accountId) } : {},
		cancel_at: null,
		cancel_at_period_end: false,
		items: {
			object: "list",
			data: [{ id: `si_${id}`, object: "subscription_item", price: PRICES[lookupKey] ?? price(lookupKey, 100, "month"), current_period_start: start, current_period_end: end }],
		},
		...rest,
	};
}

function stripeApi({ method, path, query, body }) {
	calls.push({ method, path, query, body });
	if (method === "GET" && path === "/v1/prices") {
		const found = PRICES[query.get("lookup_keys[0]")];
		return { object: "list", data: found ? [found] : [], has_more: false };
	}
	if (method === "GET" && path.startsWith("/v1/subscriptions/")) {
		const found = subscriptions.get(path.split("/").at(-1));
		return found ?? { status: 404, error: { type: "invalid_request_error", message: "No such subscription" } };
	}
	if (method === "POST" && path === "/v1/checkout/sessions") return { id: "cs_test_1", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test_1" };
	if (method === "POST" && path === "/v1/billing_portal/sessions") return { id: "bps_1", object: "billing_portal.session", url: "https://billing.stripe.com/p/session/bps_1" };
	if (method === "GET" && path.startsWith("/v1/checkout/sessions/")) return m.checkoutSessions.get(path.split("/").at(-1));
	return { status: 404, error: { type: "invalid_request_error", message: `No mock for ${method} ${path}` } };
}

function checkoutMetadata() {
	const { body } = calls.findLast(({ path }) => path === "/v1/checkout/sessions");
	return Object.fromEntries([...body].filter(([key]) => key.startsWith("metadata[")).map(([key, value]) => [key.slice("metadata[".length, -1), value]));
}

let eventCount = 0;
async function deliver(type, object, { secret = process.env.STRIPE_WEBHOOK_SECRET } = {}) {
	const payload = JSON.stringify({ id: `evt_${++eventCount}`, object: "event", type, created: NOW, data: { object } });
	const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
	const response = await m.webhook.POST(new Request("http://localhost:3000/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": signature }, body: payload }));
	return { status: response.status, body: await response.json() };
}

// An API key from the dashboard: only an account with a plan gets one.
async function createKey(user, name) {
	const { createApiKey } = await import("../app/(app)/api-keys/actions.js");
	return as(user, () => createApiKey(null, form({ name })));
}

async function account(user) {
	return findAccount(user.accountId);
}

function invoice({ subscriptionId, accountId, customer, start, end, reason = "subscription_cycle" }) {
	return {
		id: `in_${start}_${end}`,
		object: "invoice",
		customer,
		billing_reason: reason,
		parent: { type: "subscription_details", subscription_details: { subscription: subscriptionId, metadata: { accountId: String(accountId) } } },
		lines: { object: "list", data: [{ id: `il_${start}`, object: "line_item", period: { start, end } }] },
	};
}

before(async () => {
	app = await startTestApp();
	m = {
		webhook: await import("../app/api/webhooks/stripe/route.js"),
		billing: await import("../app/(account)/billing/actions.js"),
		checkoutRoute: await import("../app/(account)/billing/checkout/route.js"),
		returnRoute: await import("../app/(account)/billing/return/route.js"),
		auth: await import("../lib/auth.js"),
		checkoutSessions: new Map(),
	};
});

beforeEach(() => {
	calls = [];
	subscriptions = new Map();
	mockStripe(stripeApi);
});

after(() => app?.stop());

describe("webhook signatures", () => {
	test("an event with a wrong or missing signature is refused before anything changes", async () => {
		const forged = await deliver("customer.subscription.updated", { id: "sub_x" }, { secret: "whsec_someone_else" });
		assert.equal(forged.status, 400);
		const unsigned = await m.webhook.POST(new Request("http://localhost:3000/api/webhooks/stripe", { method: "POST", body: "{}" }));
		assert.equal(unsigned.status, 400);
		assert.equal(calls.length, 0, "Stripe's API wasn't called");
	});

	test("without the webhook secret the endpoint is off", async () => {
		const secret = process.env.STRIPE_WEBHOOK_SECRET;
		delete process.env.STRIPE_WEBHOOK_SECRET;
		try {
			const response = await m.webhook.POST(new Request("http://localhost:3000/api/webhooks/stripe", { method: "POST", body: "{}" }));
			assert.equal(response.status, 503);
		} finally {
			process.env.STRIPE_WEBHOOK_SECRET = secret;
		}
	});

	test("other event types are acknowledged and ignored", async () => {
		assert.deepEqual(await deliver("charge.refunded", { id: "ch_1" }), { status: 200, body: { received: true, ignored: "charge.refunded" } });
	});
});

describe("checkout", () => {
	test("picking a plan opens Checkout for the account's own subscription", async () => {
		const user = await signIn("checkout@example.com");
		const url = await as(user, () => catchRedirect(m.billing.choosePlan(form({ plan: "growth", interval: "year" }))));
		assert.equal(url, "https://checkout.stripe.com/c/pay/cs_test_1");

		const created = calls.find(({ path }) => path === "/v1/checkout/sessions").body;
		assert.equal(created.get("mode"), "subscription");
		assert.equal(created.get("line_items[0][price]"), "price_mailcheap_growth_yearly");
		assert.equal(created.get("client_reference_id"), String(user.accountId));
		assert.equal(created.get("subscription_data[metadata][accountId]"), String(user.accountId));
		assert.equal(created.get("customer_email"), "checkout@example.com");
		assert.equal(created.get("success_url"), "http://localhost:3000/billing/return?session_id={CHECKOUT_SESSION_ID}");
	});

	test("without attribution cookies the session's metadata is the account id alone, from the plan links and the plan picker", async () => {
		const user = await signIn("metadata@example.com");
		const link = new Request("http://localhost:3000/billing/checkout?plan=growth&interval=year");
		assert.equal(await as(user, () => catchRedirect(m.checkoutRoute.GET(link))), "https://checkout.stripe.com/c/pay/cs_test_1");
		assert.deepEqual(checkoutMetadata(), { accountId: String(user.accountId) });

		const picked = await as(user, () => catchRedirect(m.billing.choosePlan(form({ plan: "starter", interval: "month" }))));
		assert.equal(picked, "https://checkout.stripe.com/c/pay/cs_test_1");
		assert.deepEqual(checkoutMetadata(), { accountId: String(user.accountId) });
	});

	test("an API key's checkout names the account too", async () => {
		const user = await signIn("api-checkout@example.com");
		await activate(user);
		const { key } = await createKey(user, "Server");
		await execute("UPDATE accounts SET subscriptionStatus = 'canceled' WHERE _id = ?", [user.accountId]);

		const response = await callApi("POST", "/api/v1/billing/change-plan", { key, body: { plan: "growth" } });
		assert.deepEqual(response.body, { url: "https://checkout.stripe.com/c/pay/cs_test_1", kind: "checkout" });
		assert.deepEqual(checkoutMetadata(), { accountId: String(user.accountId) });
	});

	test("a Stripe price that doesn't match the plan file never reaches Checkout", async () => {
		const user = await signIn("mismatch@example.com");
		const real = PRICES.mailcheap_pro_monthly;
		const url = await as(user, () => catchRedirect(m.billing.choosePlan(form({ plan: "pro", interval: "month" }))));
		assert.equal(real.unit_amount, 9900, "Stripe says $99, the plan says $79");
		assert.equal(url, "/billing?interval=month&error=stripe");
		assert.equal(calls.some(({ path }) => path === "/v1/checkout/sessions"), false);
	});

	test("checkout.session.completed turns the plan on and starts the month", async () => {
		const user = await signIn("paid@example.com");
		subscriptions.set("sub_paid", subscription({ id: "sub_paid", accountId: user.accountId, customer: "cus_paid", lookupKey: "mailcheap_growth_monthly" }));
		const result = await deliver("checkout.session.completed", {
			id: "cs_paid",
			object: "checkout.session",
			mode: "subscription",
			client_reference_id: String(user.accountId),
			customer: "cus_paid",
			subscription: "sub_paid",
		});
		assert.equal(result.status, 200);

		const paid = await account(user);
		assert.equal(paid.stripeCustomerId, "cus_paid");
		assert.equal(paid.stripeSubscriptionId, "sub_paid");
		assert.equal(paid.subscriptionStatus, "active");
		assert.equal(paid.plan, "growth");
		assert.equal(paid.interval, "month");
		assert.equal(paid.currentPeriodStart.getTime(), NOW * 1000);
		assert.equal(paid.currentPeriodEnd.getTime(), (NOW + 30 * DAY) * 1000);
		assert.equal(paid.usage.emailsSent, 0);
		assert.equal(paid.usage.paidThrough.getTime(), (NOW + 30 * DAY) * 1000);
		assert.ok((await createKey(user, "Paid")).key, "what needs a plan opens");
	});

	test("coming back from Checkout turns the plan on before the webhook, then opens the dashboard", async () => {
		const user = await signIn("returning@example.com");
		subscriptions.set("sub_return", subscription({ id: "sub_return", accountId: user.accountId, customer: "cus_return" }));
		m.checkoutSessions.set("cs_return", { id: "cs_return", object: "checkout.session", mode: "subscription", status: "complete", client_reference_id: String(user.accountId), customer: "cus_return", subscription: "sub_return" });
		const url = await as(user, () => catchRedirect(m.returnRoute.GET(new Request("http://localhost:3000/billing/return?session_id=cs_return"))));
		assert.equal(url, "/");
		assert.equal((await account(user)).subscriptionStatus, "active");
	});

	test("another account's checkout session doesn't turn a plan on", async () => {
		const owner = await signIn("owner@example.com");
		const visitor = await signIn("visitor@example.com");
		subscriptions.set("sub_owner", subscription({ id: "sub_owner", accountId: owner.accountId, customer: "cus_owner" }));
		m.checkoutSessions.set("cs_owner", { id: "cs_owner", object: "checkout.session", mode: "subscription", status: "complete", client_reference_id: String(owner.accountId), customer: "cus_owner", subscription: "sub_owner" });
		const url = await as(visitor, () => catchRedirect(m.returnRoute.GET(new Request("http://localhost:3000/billing/return?session_id=cs_owner"))));
		assert.equal(url, "/billing?checkout=pending");
		assert.equal((await account(visitor)).subscriptionStatus, null);
		assert.equal((await account(owner)).subscriptionStatus, null, "nothing changed for the owner either");
	});
});

describe("subscription changes", () => {
	let user;

	before(async () => {
		user = await signIn("lifecycle@example.com");
		subscriptions.set("sub_life", subscription({ id: "sub_life", accountId: user.accountId, customer: "cus_life" }));
		await deliver("customer.subscription.created", { id: "sub_life" });
	});

	test("an upgrade changes the plan; a scheduled cancel is shown, and undone", async () => {
		subscriptions.set("sub_life", subscription({ id: "sub_life", accountId: user.accountId, customer: "cus_life", lookupKey: "mailcheap_growth_yearly", end: NOW + 365 * DAY }));
		await deliver("customer.subscription.updated", { id: "sub_life" });
		let current = await account(user);
		assert.equal(current.plan, "growth");
		assert.equal(current.interval, "year");

		subscriptions.set("sub_life", { ...subscriptions.get("sub_life"), cancel_at_period_end: true });
		await deliver("customer.subscription.updated", { id: "sub_life" });
		current = await account(user);
		assert.equal(current.cancelAt.getTime(), (NOW + 365 * DAY) * 1000);

		subscriptions.set("sub_life", { ...subscriptions.get("sub_life"), cancel_at_period_end: false });
		await deliver("customer.subscription.updated", { id: "sub_life" });
		assert.equal((await account(user)).cancelAt, null);
	});

	test("the event's own copy is never trusted: the subscription is read from Stripe", async () => {
		subscriptions.set("sub_life", subscription({ id: "sub_life", accountId: user.accountId, customer: "cus_life", lookupKey: "mailcheap_growth_yearly", end: NOW + 365 * DAY }));
		const result = await deliver("customer.subscription.updated", { id: "sub_life", status: "canceled", items: { data: [] } });
		assert.deepEqual(result, { status: 200, body: { received: true, updated: true, status: "active" } });
		assert.equal((await account(user)).subscriptionStatus, "active");
	});

	test("when Stripe can't be read the webhook answers 500, so Stripe retries", async () => {
		const error = console.error;
		console.error = () => {};
		try {
			const result = await deliver("customer.subscription.updated", { id: "sub_missing" });
			assert.equal(result.status, 500);
		} finally {
			console.error = error;
		}
	});

	test("a price with an unknown lookup key keeps the plan and logs it", async () => {
		const logged = [];
		const error = console.error;
		console.error = (...args) => logged.push(args.join(" "));
		try {
			subscriptions.set("sub_life", subscription({ id: "sub_life", accountId: user.accountId, customer: "cus_life", lookupKey: "old_price_2024" }));
			await deliver("customer.subscription.updated", { id: "sub_life" });
		} finally {
			console.error = error;
		}
		assert.equal((await account(user)).plan, "growth");
		assert.ok(logged.some((line) => line.includes("unknown lookup key")));
	});

	test("an older subscription ending doesn't cancel the current one", async () => {
		subscriptions.set("sub_old", subscription({ id: "sub_old", accountId: user.accountId, customer: "cus_life", status: "canceled" }));
		const result = await deliver("customer.subscription.deleted", { id: "sub_old" });
		assert.equal(result.body.ignored, "an older subscription");
		assert.equal((await account(user)).subscriptionStatus, "active");
	});

	test("deletion ends access: what needs a plan opens the paywall on the dashboard, and the API answers 402", async () => {
		const { key } = await createKey(user, "Site");
		subscriptions.set("sub_life", subscription({ id: "sub_life", accountId: user.accountId, customer: "cus_life", status: "canceled", lookupKey: "mailcheap_growth_yearly" }));
		await deliver("customer.subscription.deleted", { id: "sub_life" });

		const ended = await account(user);
		assert.equal(ended.subscriptionStatus, "canceled");
		assert.equal(ended.plan, "growth", "the data and the last plan are kept");
		assert.equal((await createKey(user, "Another")).code, "subscription_required");
		const response = await callApi("POST", "/api/v1/contacts", { key, body: { newsletter: "x", email: "a@example.com" } });
		assert.equal(response.status, 402);
		assert.deepEqual(response.body, { error: { code: "subscription_required", message: "The account has no active plan" } });
	});
});

describe("invoice.paid", () => {
	test("a payment for the next period starts the month over; the same invoice again doesn't", async () => {
		const user = await signIn("invoices@example.com");
		subscriptions.set("sub_inv", subscription({ id: "sub_inv", accountId: user.accountId, customer: "cus_inv" }));
		await deliver("customer.subscription.created", { id: "sub_inv" });
		await updateRows("accounts", { where: "_id = ?", params: [user.accountId] }, { set: { "usage.emailsSent": 12_345 } });

		const first = invoice({ subscriptionId: "sub_inv", accountId: user.accountId, customer: "cus_inv", start: NOW, end: NOW + 30 * DAY, reason: "subscription_create" });
		assert.equal((await deliver("invoice.paid", first)).body.reset, false, "the first invoice pays the period already started");
		assert.equal((await account(user)).usage.emailsSent, 12_345);

		const renewal = invoice({ subscriptionId: "sub_inv", accountId: user.accountId, customer: "cus_inv", start: NOW + 30 * DAY, end: NOW + 60 * DAY });
		assert.equal((await deliver("invoice.paid", renewal)).body.reset, true);
		let current = await account(user);
		assert.equal(current.usage.emailsSent, 0);
		assert.equal(current.usage.periodStart.getTime(), (NOW + 30 * DAY) * 1000);

		await updateRows("accounts", { where: "_id = ?", params: [user.accountId] }, { inc: { "usage.emailsSent": 40 } });
		assert.equal((await deliver("invoice.paid", renewal)).body.reset, false, "redelivered");
		current = await account(user);
		assert.equal(current.usage.emailsSent, 40, "emails sent since the renewal still count");

		const upgrade = invoice({ subscriptionId: "sub_inv", accountId: user.accountId, customer: "cus_inv", start: NOW + 40 * DAY, end: NOW + 60 * DAY, reason: "subscription_update" });
		assert.equal((await deliver("invoice.paid", upgrade)).body.reset, false, "a mid-period upgrade keeps the count");

		const oldSubscription = invoice({ subscriptionId: "sub_gone", accountId: user.accountId, customer: "cus_inv", start: NOW + 60 * DAY, end: NOW + 90 * DAY });
		assert.equal((await deliver("invoice.paid", oldSubscription)).body.ignored, "an older subscription");
	});
});

describe("customer portal", () => {
	test("manage billing opens the portal; picking another plan opens Stripe's confirm page for it", async () => {
		const user = await signIn("portal@example.com");
		subscriptions.set("sub_portal", subscription({ id: "sub_portal", accountId: user.accountId, customer: "cus_portal" }));
		await deliver("customer.subscription.created", { id: "sub_portal" });

		assert.equal(await as(user, () => catchRedirect(m.billing.openBillingPortal())), "https://billing.stripe.com/p/session/bps_1");
		const portal = calls.findLast(({ path }) => path === "/v1/billing_portal/sessions").body;
		assert.equal(portal.get("customer"), "cus_portal");
		assert.equal(portal.get("return_url"), "http://localhost:3000/billing");

		assert.equal(await as(user, () => catchRedirect(m.billing.choosePlan(form({ plan: "growth", interval: "month" })))), "https://billing.stripe.com/p/session/bps_1");
		const change = calls.findLast(({ path }) => path === "/v1/billing_portal/sessions").body;
		assert.equal(change.get("flow_data[type]"), "subscription_update_confirm");
		assert.equal(change.get("flow_data[subscription_update_confirm][subscription]"), "sub_portal");
		assert.equal(change.get("flow_data[subscription_update_confirm][items][0][price]"), "price_mailcheap_growth_monthly");
		assert.equal(calls.some(({ path }) => path === "/v1/checkout/sessions"), false, "a paying account never gets a second subscription");
	});

	test("an account that never paid has no portal", async () => {
		const user = await signIn("noportal@example.com");
		assert.equal(await as(user, () => catchRedirect(m.billing.openBillingPortal())), "/billing");
	});
});
