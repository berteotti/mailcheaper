import "server-only";
import { createDnsResolver } from "./dns-check.js";
import { mailboxProvider } from "./providers.js";

const CONCURRENCY = 20;
const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED = 50_000;
// Domain -> { canReceive, at }, shared by the chunks of one import.
const cache = new Map();
let resolver;

function getResolver() {
	resolver ??= createDnsResolver({ timeout: 2500, tries: 2 });
	return resolver;
}

// No MX record: mail goes to the domain's own address (RFC 5321), so the domain needs one.
async function hasAddress(domain, dns) {
	for (const lookup of ["resolve4", "resolve6"]) {
		try {
			if ((await dns[lookup](domain)).length > 0) return true;
		} catch (error) {
			if (error.code !== "ENODATA") return error.code !== "ENOTFOUND";
		}
	}
	return false;
}

// "MX 0 ." is a domain saying it takes no email (RFC 7505). Lookups that fail for another reason (a timeout, a
// broken name server) count as able: an address is only left out when DNS says so.
async function canReceiveMail(domain, dns) {
	try {
		const records = await dns.resolveMx(domain);
		return records.some(({ exchange }) => exchange && exchange !== ".");
	} catch (error) {
		if (error.code === "ENOTFOUND") return false;
		if (error.code !== "ENODATA") return true;
	}
	return hasAddress(domain, dns);
}

function readCache(domain, now) {
	const entry = cache.get(domain);
	return entry && now - entry.at < CACHE_MS ? entry.canReceive : undefined;
}

function writeCache(domain, canReceive, now) {
	if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
	cache.set(domain, { canReceive, at: now });
}

// The domains, among these, that can't receive email. Big mailbox providers are known to and skipped.
export async function findDomainsWithoutMail(domains, dns = getResolver()) {
	const now = Date.now();
	const unique = [...new Set(domains.map((domain) => domain.toLowerCase()))].filter((domain) => mailboxProvider(`x@${domain}`) === "other");
	const toCheck = unique.filter((domain) => readCache(domain, now) === undefined);
	for (let index = 0; index < toCheck.length; index += CONCURRENCY) {
		const group = toCheck.slice(index, index + CONCURRENCY);
		const results = await Promise.all(group.map((domain) => canReceiveMail(domain, dns)));
		group.forEach((domain, position) => writeCache(domain, results[position], now));
	}
	return new Set(unique.filter((domain) => readCache(domain, now) === false));
}
