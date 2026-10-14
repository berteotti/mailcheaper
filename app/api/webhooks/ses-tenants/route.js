import { handleSnsRequest } from "@/lib/sns-webhook";
import { getTenantEventPlan } from "@/lib/tenant-event-rules";

// SES pausing or flagging a tenant, through an EventBridge rule that targets this route's SNS topic. Stored as
// "ses-tenant-event" jobs; the jobs Worker applies them (lib/tenant-events.js).
export async function POST(request) {
	return handleSnsRequest(request, {
		topicArn: process.env.SES_TENANT_SNS_TOPIC_ARN,
		label: "ses-tenants",
		kind: "ses-tenant-event",
		accepts: (event) => Boolean(getTenantEventPlan(event)),
	});
}
