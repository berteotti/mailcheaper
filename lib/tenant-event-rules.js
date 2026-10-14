import { isPlainObject } from "./validation.js";

const TENANT_ARN_PATTERN = /^arn:aws:ses:[a-z0-9-]+:\d{12}:tenant\/([A-Za-z0-9_-]{1,64})(?:\/|$)/;

function readText(value) {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null;
}

// The tenant an EventBridge event is about, from its resources.
export function getTenantName(event) {
	const resources = Array.isArray(event?.resources) ? event.resources : [];
	for (const arn of resources) {
		const name = TENANT_ARN_PATTERN.exec(String(arn))?.[1];
		if (name) return name;
	}
	return null;
}

// Pure: what one SES event about a tenant does. Disabled sending blocks the account; a high-impact
// finding blocks it before SES does; anything else, enabled sending included, is recorded and goes to the admins.
export function getTenantEventPlan(event) {
	if (!isPlainObject(event) || event.source !== "aws.ses") return null;
	const tenantName = getTenantName(event);
	if (!tenantName) return null;
	const detail = isPlainObject(event.detail) ? event.detail : {};
	const record = detail.data?.record ?? detail;
	const cause = readText(record?.cause) ?? readText(detail.reason);
	const occurredAt = new Date(event.time ?? Date.now());
	const type = event["detail-type"];

	if (type === "Sending Status Disabled") {
		return { tenantName, occurredAt, status: "DISABLED", pause: `SES paused sending${cause ? `: ${cause}` : ""}` };
	}
	if (type === "Sending Status Enabled") return { tenantName, occurredAt, status: readText(record?.status) ?? "ENABLED" };
	if (type === "Advisor Recommendation Status Open") {
		const impact = readText(detail.metadata?.impact) ?? readText(detail.impact) ?? "UNKNOWN";
		const finding = `${readText(detail.metadata?.type) ?? readText(detail.type) ?? "Finding"} (${impact.toLowerCase()} impact)${cause ? `: ${cause}` : ""}`;
		return { tenantName, occurredAt, finding, ...(impact === "HIGH" && { pause: `SES finding: ${finding}` }) };
	}
	if (type === "Advisor Recommendation Status Closed") return { tenantName, occurredAt, finding: null };
	return null;
}
