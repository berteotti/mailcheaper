import "server-only";
import Stripe from "stripe";
import { getAppUrl } from "@/lib/config";
import { getLookupKey, getPlan, getPrice } from "@/lib/plans";

let stripe;
const priceIds = new Map();

export function isStripeConfigured() {
	return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function getStripe() {
	if (!isStripeConfigured()) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY)");
	stripe ??= new Stripe(process.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
	return stripe;
}

// Prices are found by lookup key, and refused when Stripe and lib/plans.js disagree on the amount.
export async function findPriceId(planId, interval) {
	const lookupKey = getLookupKey(planId, interval);
	if (priceIds.has(lookupKey)) return priceIds.get(lookupKey);
	const { data } = await getStripe().prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
	const price = data[0];
	if (!price) throw new Error(`No active Stripe price has the lookup key ${lookupKey}`);
	const expected = getPrice(getPlan(planId), interval) * 100;
	if (price.currency !== "usd" || price.unit_amount !== expected || price.recurring?.interval !== interval) {
		throw new Error(`Stripe price ${price.id} (${lookupKey}) should be ${expected} USD cents every ${interval}`);
	}
	priceIds.set(lookupKey, price.id);
	return price.id;
}

// The account id travels on the session and the subscription, so every webhook finds its account.
export async function createCheckoutSession({ account, user, planId, interval, attribution = {} }) {
	const price = await findPriceId(planId, interval);
	const accountId = String(account._id);
	const appUrl = getAppUrl();
	const session = await getStripe().checkout.sessions.create({
		mode: "subscription",
		line_items: [{ price, quantity: 1 }],
		client_reference_id: accountId,
		metadata: { ...attribution, accountId },
		subscription_data: { metadata: { accountId } },
		...(account.stripeCustomerId ? { customer: account.stripeCustomerId } : { customer_email: user.email }),
		allow_promotion_codes: true,
		success_url: `${appUrl}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
		cancel_url: `${appUrl}/billing?interval=${interval}`,
	});
	return session.url;
}

// With a plan, Stripe's page to confirm that exact change (it needs plan changes on in the portal's
// settings); without one, or when that page isn't available, the portal's home.
export async function createPortalSession({ account, planId, interval }) {
	const returnUrl = `${getAppUrl()}/billing`;
	const base = { customer: account.stripeCustomerId, return_url: returnUrl };
	if (planId && account.stripeSubscriptionId) {
		try {
			const [price, subscription] = await Promise.all([
				findPriceId(planId, interval),
				getStripe().subscriptions.retrieve(account.stripeSubscriptionId),
			]);
			const session = await getStripe().billingPortal.sessions.create({
				...base,
				flow_data: {
					type: "subscription_update_confirm",
					subscription_update_confirm: {
						subscription: subscription.id,
						items: [{ id: subscription.items.data[0].id, price, quantity: 1 }],
					},
					after_completion: { type: "redirect", redirect: { return_url: returnUrl } },
				},
			});
			return session.url;
		} catch (error) {
			console.error("[billing] The plan change page isn't available, opening the portal:", error.message);
		}
	}
	return (await getStripe().billingPortal.sessions.create(base)).url;
}
