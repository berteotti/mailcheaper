import "server-only";
import { createHmac } from "node:crypto";

// Shared subdomains' DNS records go through MailCheap's DNS helper (dns-broker/), a Vercel project of its own that
// holds the Vercel token: the app only signs its requests, with DNS_BROKER_SECRET. Without DNS_BROKER_URL and
// DNS_BROKER_SECRET (a self-hosted server, local development) DNS automation is off and nothing is published.
function getBroker() {
	const { DNS_BROKER_URL: url, DNS_BROKER_SECRET: secret } = process.env;
	return url && secret ? { url, secret } : null;
}

async function callBroker(payload) {
	const broker = getBroker();
	if (!broker) return { skipped: true };
	const body = JSON.stringify(payload);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = createHmac("sha256", broker.secret).update(`${timestamp}.${body}`).digest("hex");
	const response = await fetch(broker.url, {
		method: "POST",
		headers: { "content-type": "application/json", "x-mailcheap-timestamp": timestamp, "x-mailcheap-signature": `sha256=${signature}` },
		body,
		signal: AbortSignal.timeout(30_000),
	});
	const data = await response.json().catch(() => null);
	if (!response.ok) throw new Error(`The DNS helper refused to ${payload.action} ${payload.slug}'s records: ${data?.message ?? data?.error ?? response.status}`);
	return data;
}

// All of a slug's records or none: the helper tags them for the slug and answers their ids in the same order.
export async function publishSharedRecords(slug, records) {
	const result = await callBroker({ action: "create", slug, records: records.map(({ type, name, value }) => ({ type, name, value })) });
	return result.skipped ? result : { ids: result.ids };
}

export async function removeSharedRecords(slug, ids = []) {
	if (ids.length === 0) return { deleted: [] };
	return callBroker({ action: "delete", slug, ids });
}
