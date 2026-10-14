import { NextResponse } from "next/server";
import { commitJobs } from "@/lib/jobs";
import { isValidSubscribeUrl, verifySnsMessage } from "@/lib/sns";
import { isPlainObject } from "@/lib/validation";

// SNS messages are at most 256 KB; the envelope adds a little.
const MAX_BODY_LENGTH = 512 * 1024;

function reply(status, body) {
	return NextResponse.json(body, { status });
}

function parseJson(value) {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

async function confirmSubscription(message, label) {
	if (!isValidSubscribeUrl(message.SubscribeURL)) return reply(400, { error: "Invalid SubscribeURL" });
	const response = await fetch(message.SubscribeURL, {
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	}).catch(() => null);
	if (!response?.ok) return reply(502, { error: "Subscription confirmation failed" });

	console.log(`[${label}] Confirmed the subscription to ${message.TopicArn}`);
	return reply(200, { ok: true });
}

// Acknowledged only once the event is durable in D1's job outbox; the jobs Worker runs it (kind) and retries it
// until it's done. The SNS MessageId names the job, so a redelivery adds nothing. Events of no use are dropped here.
async function handleNotification(message, { label, kind, accepts, prepare }) {
	const event = parseJson(message.Message);
	if (!isPlainObject(event) || !accepts(event)) return reply(200, { ok: true, ignored: true });

	try {
		await commitJobs([{ id: `${kind}:${message.MessageId}`, kind, payload: prepare(event) }]);
		return reply(200, { ok: true });
	} catch (error) {
		// A 5xx makes SNS retry; the job is keyed by its message id.
		console.error(`[${label}] Could not store the event:`, error);
		return reply(500, { error: "Could not store the event" });
	}
}

// One SNS topic per route. Needs an HTTPS subscription with raw message delivery off, so the envelope is signed.
// kind: the job that handles the event. accepts: whether it's an event the job handles. prepare: what's stored.
export async function handleSnsRequest(request, { topicArn, label, kind, accepts = () => true, prepare = (event) => event }) {
	if (!topicArn) return reply(503, { error: "Webhook is not configured" });

	const body = await request.text();
	if (body.length > MAX_BODY_LENGTH) return reply(413, { error: "Body is too large" });
	const message = parseJson(body);
	if (!isPlainObject(message)) return reply(400, { error: "Invalid JSON" });
	if (message.TopicArn !== topicArn) return reply(403, { error: "Unknown topic" });
	if (!(await verifySnsMessage(message))) return reply(400, { error: "Invalid signature" });

	if (message.Type === "SubscriptionConfirmation") return confirmSubscription(message, label);
	if (message.Type === "Notification") return handleNotification(message, { label, kind, accepts, prepare });
	return reply(200, { ok: true });
}
