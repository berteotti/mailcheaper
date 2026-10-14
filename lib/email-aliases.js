import { normalizeEmail } from "./validation.js";

// Mailbox providers that deliver many addresses to one inbox: Gmail ignores dots and takes a +tag, these take a
// +tag, Yahoo a -tag. One account per inbox (lib/auth.js) compares addresses without them.
const GMAIL_DOMAINS = ["gmail.com", "googlemail.com"];
const PLUS_TAG_DOMAINS = [
	"outlook.com",
	"outlook.fr",
	"outlook.de",
	"outlook.es",
	"outlook.it",
	"hotmail.com",
	"hotmail.co.uk",
	"hotmail.fr",
	"hotmail.de",
	"hotmail.es",
	"hotmail.it",
	"live.com",
	"live.co.uk",
	"live.fr",
	"live.de",
	"live.it",
	"live.nl",
	"msn.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"fastmail.com",
	"fastmail.fm",
	"proton.me",
	"protonmail.com",
	"protonmail.ch",
	"pm.me",
];
const DASH_TAG_DOMAINS = ["yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.es", "yahoo.it", "yahoo.ca", "ymail.com", "rocketmail.com"];

const RULES = new Map([
	...GMAIL_DOMAINS.map((domain) => [domain, { tag: "+", ignoresDots: true, domains: GMAIL_DOMAINS }]),
	...PLUS_TAG_DOMAINS.map((domain) => [domain, { tag: "+", ignoresDots: false, domains: [domain] }]),
	...DASH_TAG_DOMAINS.map((domain) => [domain, { tag: "-", ignoresDots: false, domains: [domain] }]),
]);

function escapeRegex(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitEmail(email) {
	const at = email.lastIndexOf("@");
	return [email.slice(0, at), email.slice(at + 1)];
}

// The inbox an address reaches: jane.doe+news@googlemail.com is janedoe@gmail.com. Null when it isn't an address.
export function getCanonicalEmail(value) {
	const email = normalizeEmail(value);
	if (!email) return null;
	const [local, domain] = splitEmail(email);
	const rule = RULES.get(domain);
	if (!rule) return email;
	const base = local.split(rule.tag)[0] || local;
	return `${rule.ignoresDots ? base.replaceAll(".", "") : base}@${rule.domains[0]}`;
}

// Every stored address that reaches the same inbox as this one; null for providers without aliases.
export function getAliasPattern(value) {
	const canonical = getCanonicalEmail(value);
	const rule = canonical && RULES.get(splitEmail(canonical)[1]);
	if (!rule) return null;
	const [local] = splitEmail(canonical);
	const localPattern = rule.ignoresDots ? [...local].map(escapeRegex).join("\\.?") : escapeRegex(local);
	const domains = rule.domains.map(escapeRegex).join("|");
	return new RegExp(`^${localPattern}(?:${escapeRegex(rule.tag)}[^@]*)?@(?:${domains})$`);
}
