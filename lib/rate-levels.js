import { LIMITS } from "./config.js";

export function formatRate(value) {
	return `${(value * 100).toFixed(2)}%`;
}

// The level bounces and complaints out of sent reach (LIMITS in lib/config.js), block before pause and bounces
// before complaints: { level, metric, rate, limit }, or null under both. A level needs its rate passed and its
// minimum count reached.
export function judgeRates({ sent = 0, bounced = 0, complained = 0 } = {}) {
	if (sent === 0) return null;
	for (const level of ["block", "pause"]) {
		const { bounceRate, minBounces, complaintRate, minComplaints } = LIMITS[level];
		if (bounced >= minBounces && bounced / sent > bounceRate) return { level, metric: "bounce", rate: bounced / sent, limit: bounceRate };
		if (complained >= minComplaints && complained / sent > complaintRate) {
			return { level, metric: "complaint", rate: complained / sent, limit: complaintRate };
		}
	}
	return null;
}

// "Bounce rate of 2.50% on this campaign (limit 2.00%)"
export function describeRate({ metric, rate, limit }, where) {
	return `${metric === "bounce" ? "Bounce" : "Complaint"} rate of ${formatRate(rate)}${where ? ` ${where}` : ""} (limit ${formatRate(limit)})`;
}

// What blocks the account, for the warnings of the pause level: "5.00% with 10 bounces".
export function describeBlockLevel(metric) {
	const { bounceRate, minBounces, complaintRate, minComplaints } = LIMITS.block;
	return metric === "bounce" ? `${formatRate(bounceRate)} with ${minBounces} bounces` : `${formatRate(complaintRate)} with ${minComplaints} complaints`;
}
