import { getSesEventType } from "@/lib/ses-event-mapping";
import { handleSnsRequest } from "@/lib/sns-webhook";
import { isPlainObject } from "@/lib/validation";

// Raw headers are dropped before storing; the jobs Worker applies the event (lib/ses-events.js).
function withoutMailHeaders(sesEvent) {
	if (!isPlainObject(sesEvent.mail)) return sesEvent;
	const { headers: _headers, ...mail } = sesEvent.mail;
	return { ...sesEvent, mail };
}

// Bounces, complaints and deliveries from every account's configuration set, stored as "ses-event" jobs.
export async function POST(request) {
	return handleSnsRequest(request, {
		topicArn: process.env.SES_SNS_TOPIC_ARN,
		label: "ses-webhook",
		kind: "ses-event",
		accepts: (event) => Boolean(getSesEventType(event)),
		prepare: withoutMailHeaders,
	});
}
