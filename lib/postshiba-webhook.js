import "server-only";
import { NextResponse } from "next/server";
import { getOne } from "@/lib/db";
import { handleEmailEvent } from "@/lib/email-events";
import { normalizePostshibaEvent, verifyPostshibaSignature } from "@/lib/email-provider/postshiba-events";
import { commitJobs } from "@/lib/jobs";

// PostShiba posts one event per request; a long array is someone else's.
const MAX_BODY_BYTES = 512 * 1024;
const MAX_EVENTS = 100;

function reply(status, body) {
	return NextResponse.json(body, { status });
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// The account the unique args name, if PostShiba's tenant on the event is that account's own; else the
// account whose tenant it is. An event never lands in an account its tenant doesn't belong to.
async function findEventAccount(event) {
	if (event.accountId) {
		const account = await getOne("SELECT _id, json_extract(postshiba, '$.tenantSlug') AS tenantSlug FROM accounts WHERE _id = ?", [event.accountId]);
		if (!account || (event.tenant && account.tenantSlug !== event.tenant)) return null;
		return account;
	}
	return event.tenant ? getOne("SELECT _id FROM accounts WHERE json_extract(postshiba, '$.tenantSlug') = ?", [event.tenant]) : null;
}

// One event, run by the jobs Worker from the outbox ("postshiba-event" jobs). Safe to replay: each change applies
// once, and the event's sg_event_id keeps one record of it.
export async function handlePostshibaEvent(raw) {
	const event = normalizePostshibaEvent(raw);
	if (!event) return { handled: false };
	const account = await findEventAccount(event);
	if (!account) {
		if (event.type !== "sent" && event.type !== "delivered") {
			console.warn(`[postshiba-webhook] ${event.recordAs} for no known account (tenant ${event.tenant ?? "none"})`);
		}
		return { handled: true, accountId: null };
	}
	const result = await handleEmailEvent({ ...event, accountId: account._id }, { isAccountTrusted: true });
	// PostShiba gets a 200 either way, so a message that can't be matched would otherwise go unseen.
	if (result.handled && event.messageId && !result.messageId) {
		console.warn(`[postshiba-webhook] ${event.recordAs} for account ${account._id}: no message ${event.messageId} with PostShiba id ${event.providerMessageId ?? "none"}`);
	}
	return { ...result, accountId: String(account._id) };
}

// Delivery events of every tenant (/api/webhooks/postshiba). Checked against the raw bytes before parsing, then
// acknowledged only once each event is durable in D1's job outbox: the jobs Worker runs them and retries them until
// they're done. An event's sg_event_id names its job, so a redelivery adds nothing.
// A 5xx makes PostShiba retry (6 attempts over about a day).
export async function handlePostshibaRequest(request) {
	const secret = process.env.POSTSHIBA_WEBHOOK_SECRET;
	if (!secret) return reply(503, { error: "Webhook is not configured" });
	const body = Buffer.from(await request.arrayBuffer());
	if (body.length > MAX_BODY_BYTES) return reply(413, { error: "Body is too large" });
	const isSigned = verifyPostshibaSignature({
		body,
		timestamp: request.headers.get("x-capsule-timestamp"),
		signature: request.headers.get("x-capsule-signature"),
		secret,
	});
	if (!isSigned) return reply(401, { error: "Invalid signature" });

	const events = parseJson(body.toString("utf8"));
	if (!Array.isArray(events) || events.length > MAX_EVENTS) return reply(400, { error: "Expected an array of events" });
	const jobs = events
		.map((event) => ({ event, normalized: normalizePostshibaEvent(event) }))
		.filter(({ normalized }) => normalized)
		.map(({ event, normalized }) => ({
			...(normalized.providerEventId && { id: `postshiba-event:${normalized.providerEventId}` }),
			kind: "postshiba-event",
			payload: event,
		}));
	try {
		if (jobs.length > 0) await commitJobs(jobs);
		return reply(200, { ok: true, queued: jobs.length });
	} catch (error) {
		console.error("[postshiba-webhook] Could not store the events:", error);
		return reply(500, { error: "Could not store the events" });
	}
}
