import "server-only";

// Workers have no DNS resolver (node:dns), so lookups go to Cloudflare's DNS over HTTPS, JSON API.
const DOH_URL = "https://cloudflare-dns.com/dns-query";
const RECORD_TYPES = { A: 1, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
// DNS response codes: NXDOMAIN is a name that doesn't exist.
const NOERROR = 0;
const NXDOMAIN = 3;

function dnsError(code, name) {
	return Object.assign(new Error(`${code} ${name}`), { code });
}

function trimDot(value) {
	return String(value ?? "").toLowerCase().replace(/\.$/, "");
}

async function ask(name, type, { timeout }) {
	const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`;
	const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeout) });
	if (!response.ok) throw dnsError("ESERVFAIL", name);
	return response.json();
}

// The records of one type at a name, the way node:dns answers: an error with code ENOTFOUND (no such name),
// ENODATA (no record of that type), ETIMEOUT or ESERVFAIL.
async function query(name, type, { timeout = 2500, tries = 2 } = {}) {
	let answer;
	for (let attempt = 1; !answer; attempt++) {
		try {
			answer = await ask(name, type, { timeout });
		} catch (error) {
			if (attempt >= tries) throw error.code ? error : dnsError(error?.name === "TimeoutError" ? "ETIMEOUT" : "ESERVFAIL", name);
		}
	}
	if (answer.Status === NXDOMAIN) throw dnsError("ENOTFOUND", name);
	if (answer.Status !== NOERROR) throw dnsError("ESERVFAIL", name);
	// The answer also holds the CNAMEs followed on the way: only records at the name itself count.
	const records = (answer.Answer ?? []).filter((record) => record.type === RECORD_TYPES[type] && trimDot(record.name) === trimDot(name));
	if (records.length === 0) throw dnsError("ENODATA", name);
	return records.map(({ data }) => String(data));
}

// DNS over HTTPS writes a TXT record as its quoted strings, "v=DMARC1; " "p=none", escaped as in zone files: \" and
// \\, and a byte as \DDD.
function readTxtStrings(data) {
	const unescape = (text) => text.replace(/\\(\d{3}|.)/g, (_, code) => (code.length === 3 ? String.fromCharCode(Number(code)) : code));
	const strings = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([, text]) => unescape(text));
	return strings.length > 0 ? strings : [data];
}

// A hostname's TXT records, each as the strings DNS splits it into. Nothing is [], and a failed lookup null.
export async function readTxt(host) {
	try {
		return (await query(host, "TXT")).map(readTxtStrings);
	} catch (error) {
		return error.code === "ENOTFOUND" || error.code === "ENODATA" ? [] : null;
	}
}

// The lookups lib/mail-domains.js makes, in node:dns's shapes.
export function createDnsResolver(options) {
	return {
		async resolveMx(name) {
			return (await query(name, "MX", options)).map((data) => {
				const [priority, exchange] = data.split(/\s+/);
				return { priority: Number(priority), exchange: trimDot(exchange) };
			});
		},
		resolve4: (name) => query(name, "A", options),
		resolve6: (name) => query(name, "AAAA", options),
		async resolveCname(name) {
			return (await query(name, "CNAME", options)).map(trimDot);
		},
	};
}
