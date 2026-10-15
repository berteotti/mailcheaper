// The DNS records a customer adds for one domain, grouped by what each does, with its status in words.
const SES_STATUSES = {
	SUCCESS: { label: "Found", tone: "good" },
	PENDING: { label: "Waiting for DNS", tone: "wait" },
	TEMPORARY_FAILURE: { label: "Retrying", tone: "wait" },
	FAILED: { label: "Not found, check the records", tone: "bad" },
	NOT_STARTED: { label: "Not set up", tone: "none" },
};

function sesStatus(status) {
	return SES_STATUSES[status] ?? SES_STATUSES.PENDING;
}

const COUNTS = { 1: "One", 2: "Two", 3: "Three" };

// SES signs with three CNAMEs, PostShiba with one.
function describeRecords(records) {
	const types = [...new Set(records.map(({ type }) => type))];
	if (!COUNTS[records.length] || types.length !== 1) return "";
	return ` ${COUNTS[records.length]} ${types[0]} record${records.length === 1 ? "" : "s"}.`;
}

// Statuses come in SES's words; the PostShiba adapter maps its own to them (lib/email-provider/postshiba-rules.js).
// appHost: where the archive and links stay until the archive subdomain is set up.
export function getDomainSetup(domain, { cnameTarget, appHost }) {
	const records = domain.records ?? [];
	const dkim = records.filter(({ purpose }) => purpose === "dkim");
	return [
		{
			key: "dkim",
			title: "Signature (DKIM)",
			description: `Proves the emails come from you.${describeRecords(dkim)}`,
			status: sesStatus(domain.dkimStatus),
			records: dkim,
		},
		{
			key: "mail-from",
			title: "Return path",
			description: `Bounces come back to ${domain.mailFromDomain}, so SPF passes for your domain.`,
			status: sesStatus(domain.mailFromStatus),
			records: records.filter(({ purpose }) => purpose === "mail-from"),
		},
		getArchiveStep(domain, { cnameTarget, appHost }),
		{
			key: "dmarc",
			title: "DMARC",
			description:
				"Tells inboxes what to do with emails that fail the checks. Gmail and Yahoo require one from bulk senders. Start with p=none, then move to p=quarantine once your reports look clean.",
			status: { label: "Recommended", tone: "none" },
			records: [{ type: "TXT", name: `_dmarc.${domain.domain}`, value: "v=DMARC1; p=none;" }],
		},
	];
}

// Without ARCHIVE_CNAME_TARGET the server doesn't serve archives on customers' domains: there's nothing to add.
function getArchiveStep(domain, { cnameTarget, appHost }) {
	const step = { key: "archive", title: "Archive and links" };
	if (!cnameTarget) {
		return {
			...step,
			description: `Not available on this server: your archive, tracked links and unsubscribe links stay on ${appHost}. Sending doesn't need it. The server's admin can turn it on with ARCHIVE_CNAME_TARGET.`,
			status: { label: "Not available", tone: "none" },
			records: [],
		};
	}
	return {
		...step,
		description: domain.archiveHostVerified
			? `Your archive, tracked links and unsubscribe links are on ${domain.archiveHost}.`
			: `Add this CNAME record where you manage ${domain.domain}'s DNS, then check again. Your archive, tracked links and unsubscribe links move to ${domain.archiveHost}; until then they stay on ${appHost}.`,
		status: domain.archiveHostVerified ? { label: "Found", tone: "good" } : { label: "Waiting for DNS", tone: "wait" },
		records: [{ type: "CNAME", name: domain.archiveHost, value: cnameTarget }],
	};
}

// What a domain can do right now, in a few words. Without cnameTarget, sending is all there is to set up.
export function getDomainSummary(domain, { cnameTarget } = {}) {
	if (domain.verified && (domain.archiveHostVerified || !cnameTarget)) return { label: "Ready", tone: "good" };
	if (domain.verified) return { label: "Sending ready, archive waiting", tone: "wait" };
	if (domain.dkimStatus === "FAILED") return { label: "Records not found", tone: "bad" };
	return { label: "Waiting for DNS", tone: "wait" };
}
