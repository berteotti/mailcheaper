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
export function getDomainSetup(domain, { cnameTarget }) {
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
		{
			key: "archive",
			title: "Archive and links",
			description: `Your archive, tracked links and unsubscribe links on ${domain.archiveHost}.`,
			status: domain.archiveHostVerified ? { label: "Found", tone: "good" } : { label: "Waiting for DNS", tone: "wait" },
			records: cnameTarget ? [{ type: "CNAME", name: domain.archiveHost, value: cnameTarget }] : [],
		},
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

// What a domain can do right now, in a few words.
export function getDomainSummary(domain) {
	if (domain.verified && domain.archiveHostVerified) return { label: "Ready", tone: "good" };
	if (domain.verified) return { label: "Sending ready, archive waiting", tone: "wait" };
	if (domain.dkimStatus === "FAILED") return { label: "Records not found", tone: "bad" };
	return { label: "Waiting for DNS", tone: "wait" };
}
