// Common misspellings of the big mailbox providers' domains, and endings no domain has. Mail to them bounces, or
// reaches a lookalike domain registered to catch mistyped mail, some of them spam traps. Only listed misspellings
// count, so a real domain that looks like one of these is never refused.
const MISSPELLINGS = {
	"gmail.com": [
		"gmial.com",
		"gmai.com",
		"gmal.com",
		"gmil.com",
		"gmaill.com",
		"gmaul.com",
		"gnail.com",
		"gamil.com",
		"gmali.com",
		"gmeil.com",
		"gmsil.com",
		"gmaio.com",
		"gmaik.com",
		"ggmail.com",
		"gmmail.com",
		"gmaiil.com",
		"gmaail.com",
		"gmail.co",
		"gmail.cm",
		"gmail.om",
	],
	"googlemail.com": ["googlemai.com", "googlemial.com", "googlemail.co"],
	"yahoo.com": ["yaho.com", "yahooo.com", "yahho.com", "yhoo.com", "yhaoo.com", "yaoo.com", "yahool.com", "uahoo.com", "yahoo.co", "yahoo.cm", "yahoo.om"],
	"hotmail.com": [
		"hotmial.com",
		"hotmal.com",
		"hotmai.com",
		"hotmil.com",
		"hotnail.com",
		"hotmali.com",
		"homail.com",
		"hotamil.com",
		"hotmaill.com",
		"htomail.com",
		"hormail.com",
		"hoymail.com",
		"hotmsil.com",
		"hotmail.co",
		"hotmail.cm",
		"hotmail.om",
	],
	"outlook.com": ["outlok.com", "outllok.com", "outlool.com", "oulook.com", "otlook.com", "outook.com", "putlook.com", "outlook.co", "outlook.cm"],
	"icloud.com": ["iclod.com", "icoud.com", "icluod.com", "iclould.com", "icload.com", "iclound.com", "icloud.co", "icloud.cm"],
};
const MEANT_DOMAINS = new Map(Object.entries(MISSPELLINGS).flatMap(([domain, typos]) => typos.map((typo) => [typo, domain])));
const MEANT_ENDINGS = new Map([
	["con", "com"],
	["cmo", "com"],
	["ocm", "com"],
	["vom", "com"],
	["xom", "com"],
	["cpm", "com"],
	["comm", "com"],
	["coom", "com"],
	["ner", "net"],
	["nte", "net"],
	["nett", "net"],
	["ogr", "org"],
	["rog", "org"],
	["orgg", "org"],
]);

function fixEnding(domain) {
	const dot = domain.lastIndexOf(".");
	const ending = MEANT_ENDINGS.get(domain.slice(dot + 1));
	return ending ? `${domain.slice(0, dot)}.${ending}` : domain;
}

// For a normalized address: the one it was most likely meant to be, or null. jane.doe@gmial.con is jane.doe@gmail.com.
export function getEmailSuggestion(email) {
	const at = email.lastIndexOf("@");
	const domain = email.slice(at + 1);
	const fixed = fixEnding(domain);
	const meant = MEANT_DOMAINS.get(fixed) ?? fixed;
	return meant === domain ? null : `${email.slice(0, at)}@${meant}`;
}
