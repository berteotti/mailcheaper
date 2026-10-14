import { NextResponse } from "next/server";
import { commitJobs } from "@/lib/jobs";
import { getSesEventType } from "@/lib/ses-event-mapping";
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

async function confirmSubscription(message) {
	if (!isValidSubscribeUrl(message.SubscribeURL)) return reply(400, { error: "Invalid SubscribeURL" });
	const response = await fetch(message.SubscribeURL, {
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	}).catch(() => null);
	if (!response?.ok) return reply(502, { error: "Subscription confirmation failed" });

	console.log(`[ses-webhook] Confirmed the subscription to ${message.TopicArn}`);
	return reply(200, { ok: true });
}

// Raw headers are dropped before storing; the jobs Worker applies the event (lib/ses-events.js).
function withoutMailHeaders(sesEvent) {
	if (!isPlainObject(sesEvent.mail)) return sesEvent;
	const { headers: _headers, ...mail } = sesEvent.mail;
	return { ...sesEvent, mail };
}

async function handleNotification(message) {
	const sesEvent = parseJson(message.Message);
	if (!isPlainObject(sesEvent) || !getSesEventType(sesEvent)) return reply(200, { ok: true, ignored: true });

	try {
		// Acknowledged only once the event is durable in D1. The SNS MessageId keeps redeliveries to one job.
		await commitJobs([{ id: `ses:${message.MessageId}`, kind: "ses-event", payload: withoutMailHeaders(sesEvent) }]);
		return reply(200, { ok: true });
	} catch (error) {
		// A 5xx makes SNS retry; the job is keyed by its message id.
		console.error("[ses-webhook] Could not store the event:", error);
		return reply(500, { error: "Could not store the event" });
	}
}

// Needs an SNS HTTPS subscription with raw message delivery off, so the envelope is signed.
export async function POST(request) {
	const topicArn = process.env.SES_SNS_TOPIC_ARN;
	if (!topicArn) return reply(503, { error: "SES webhook is not configured" });

	const body = await request.text();
	if (body.length > MAX_BODY_LENGTH) return reply(413, { error: "Body is too large" });
	const message = parseJson(body);
	if (!isPlainObject(message)) return reply(400, { error: "Invalid JSON" });
	if (message.TopicArn !== topicArn) return reply(403, { error: "Unknown topic" });
	if (!(await verifySnsMessage(message))) return reply(400, { error: "Invalid signature" });

	if (message.Type === "SubscriptionConfirmation") return confirmSubscription(message);
	if (message.Type === "Notification") return handleNotification(message);
	return reply(200, { ok: true });
}
