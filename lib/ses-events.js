import "server-only";
import { handleEmailEvent } from "@/lib/email-events";
import { normalizeSesEvent } from "@/lib/ses-event-mapping";

export { getSesEventPlan } from "@/lib/ses-event-mapping";

// SES events from every account's configuration set (/api/webhooks/ses), run by the jobs Worker from the
// outbox ("ses-event" jobs). Each names its account in the account_id tag; one that matches no message of that
// account only shows in the logs. SES doesn't number its events: eventId (the job's id, from the SNS MessageId)
// keeps one record of a redelivered bounce or complaint.
export function handleSesEvent(sesEvent, { eventId } = {}) {
	return handleEmailEvent(normalizeSesEvent(sesEvent), { eventId });
}
