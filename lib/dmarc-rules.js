import { rootDomain } from "./favicon.js";

const POLICIES = new Set(["none", "quarantine", "reject"]);
// Receivers only read the TXT records at _dmarc that start with the version tag, and apply none if there are two.
const VERSION_TAG = /^v\s*=\s*dmarc1\s*(;|$)/i;

// Where receivers look for the DMARC record of mail from a domain, in order: the domain, then its parents down to the
// registrable domain, as in DMARC's DNS tree walk, which goes straight to the last four labels. Inboxes look no higher:
// the record a public suffix like co.za publishes for itself isn't the domain's.
export function getDmarcHosts(domain) {
	const root = rootDomain(domain);
	if (root === domain) return [domain];
	const labels = domain.split(".");
	const parents = [];
	for (let count = Math.min(labels.length - 1, 4); count > root.split(".").length; count--) parents.push(labels.slice(-count).join("."));
	return [domain, ...parents, root];
}

function readTags(text) {
	return Object.fromEntries(
		text.split(";").map((tag) => {
			const [name, ...value] = tag.split("=");
			return [name.trim().toLowerCase(), value.join("=").trim()];
		})
	);
}

// One name's TXT records, each in the strings DNS splits it into: null without a DMARC record, so the parent's counts.
// Receivers ignore a version not written DMARC1 exactly, and a record without a valid policy unless it has a report
// address, which makes it p=none.
export function getDmarcStatus(records) {
	const found = records.map((strings) => strings.join("").trim()).filter((text) => VERSION_TAG.test(text));
	if (found.length === 0) return null;
	if (found.length > 1) return "multiple";
	const tags = readTags(found[0]);
	if (tags.v !== "DMARC1") return "invalid";
	return POLICIES.has(tags.p?.toLowerCase()) || tags.rua ? "found" : "invalid";
}
