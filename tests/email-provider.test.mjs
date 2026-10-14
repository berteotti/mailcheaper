import assert from "node:assert/strict";
import { test } from "node:test";
import { getEmailProviderId } from "../lib/config.js";
import { getEventPlan } from "../lib/email-event-rules.js";
import { SEND_OUTCOMES, providerError } from "../lib/email-provider/outcomes.js";
import { getSendErrorAction } from "../lib/sending-rules.js";

test("PostShiba is the provider once its key is set, SES otherwise, and EMAIL_PROVIDER decides when set", () => {
	assert.equal(getEmailProviderId({}), "ses");
	assert.equal(getEmailProviderId({ POSTSHIBA_API_KEY: "ps_key" }), "postshiba");
	assert.equal(getEmailProviderId({ POSTSHIBA_API_KEY: "ps_key", EMAIL_PROVIDER: "ses" }), "ses", "SES stays one switch away");
	assert.equal(getEmailProviderId({ EMAIL_PROVIDER: " PostShiba " }), "postshiba");
	assert.equal(getEmailProviderId({ EMAIL_PROVIDER: "mailgun", POSTSHIBA_API_KEY: "ps_key" }), null, "a typo never picks one");
});

test("provider outcomes become actions; SES errors keep theirs", () => {
	const action = (outcome) => getSendErrorAction(providerError(outcome, outcome));
	assert.equal(action(SEND_OUTCOMES.throttled), "retry");
	assert.equal(action(SEND_OUTCOMES.unavailable), "retry");
	assert.equal(action(SEND_OUTCOMES.suppressed), "suppress");
	for (const outcome of [SEND_OUTCOMES.domainUnverified, SEND_OUTCOMES.tenantPaused, SEND_OUTCOMES.approvalPending, SEND_OUTCOMES.misconfigured]) {
		assert.equal(action(outcome), "pause", outcome);
	}
	assert.equal(action(SEND_OUTCOMES.failed), "fail");
	assert.equal(action("something new"), "fail");

	const sesError = (name, message = name) => Object.assign(new Error(message), { name });
	assert.equal(getSendErrorAction(sesError("ThrottlingException")), "retry");
	assert.equal(getSendErrorAction(sesError("SendingPausedException")), "pause");
	assert.equal(getSendErrorAction(sesError("MessageRejected", "Email address is not verified.")), "pause");
	assert.equal(getSendErrorAction(sesError("MessageRejected", "Bad content")), "fail");
});

test("one event shape for every provider: unsubscribes and drops of suppressed addresses", () => {
	const base = { accountId: "64f1a2b3c4d5e6f7a8b9c0d1", messageId: "74f1a2b3c4d5e6f7a8b9c0d2", email: "reader@example.com" };
	const unsubscribe = getEventPlan({ ...base, type: "unsubscribe", recordAs: "unsubscribe" });
	assert.equal(unsubscribe.unsubscribe, true);
	assert.equal(unsubscribe.suppression, null);
	assert.equal(unsubscribe.isRecorded, false);

	const dropped = getEventPlan({ ...base, type: "dropped", error: "Dropped by PostShiba: suppressed", suppressed: true });
	assert.deepEqual(dropped.status, { to: "failed", from: ["queued", "sent"], stat: "failed" });
	assert.deepEqual(dropped.suppression, { emails: ["reader@example.com"], reason: "provider", detail: "Dropped by PostShiba: suppressed", contactStatus: null });
	assert.equal(dropped.isRecorded, true);
	assert.equal(getEventPlan({ ...base, type: "dropped", error: "Invalid" }).suppression, null, "other drops only fail the email");

	assert.equal(getEventPlan({ ...base, type: "bounce", bounce: "soft", reason: "Mailbox full" }).error, "Soft bounce: Mailbox full");
	assert.equal(getEventPlan({ ...base, type: "bounce", bounce: "hard" }).suppression.detail, "bounce");
	assert.equal(getEventPlan({ ...base, type: "complaint", feedback: "not-spam" }).suppression, null);
	assert.equal(getEventPlan({ ...base, type: "deferred" }).status, null);
	assert.equal(getEventPlan({ ...base, type: "processed" }), null, "only normalized types");
	assert.equal(getEventPlan(null), null);
});
