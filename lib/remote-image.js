import "server-only";

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

// Addresses a server must never fetch for a customer: loopback, private networks, link-local (cloud
// metadata), carrier-grade NAT, documentation, multicast and reserved ranges.
const BLOCKED_IPV4 = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 3],
].map(([address, prefix]) => [parseIpv4(address), prefix]);
const BLOCKED_IPV6 = [
	["::", 128],
	["::1", 128],
	["64:ff9b::", 96],
	["100::", 64],
	["2001:db8::", 32],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
].map(([address, prefix]) => [parseIpv6(address), prefix]);
const MAPPED_IPV4 = 0xffffn << 32n;

function parseIpv4(address) {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
	if (!match) return null;
	const parts = match.slice(1).map(Number);
	if (parts.some((part) => part > 255)) return null;
	return parts.reduce((value, part) => value * 256n + BigInt(part), 0n);
}

// The URL parser validates and normalizes an IPv6 address (an embedded IPv4 part becomes two groups).
function parseIpv6(address) {
	if (!address.includes(":")) return null;
	let normalized;
	try {
		normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
	} catch {
		return null;
	}
	const [head, tail = null] = normalized.split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const groups = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
	if (groups.length !== 8) return null;
	return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}

function isInRange(value, [base, prefix], bits) {
	const shift = BigInt(bits - prefix);
	return value >> shift === base >> shift;
}

export function isPublicAddress(address) {
	const ipv4 = parseIpv4(String(address));
	if (ipv4 !== null) return !BLOCKED_IPV4.some((range) => isInRange(ipv4, range, 32));
	const ipv6 = parseIpv6(String(address));
	if (ipv6 === null) return false;
	if (ipv6 >> 32n === MAPPED_IPV4 >> 32n) {
		const mapped = ipv6 & 0xffffffffn;
		return !BLOCKED_IPV4.some((range) => isInRange(mapped, range, 32));
	}
	return !BLOCKED_IPV6.some((range) => isInRange(ipv6, range, 128));
}

function imageError(message) {
	return Object.assign(new Error(message), { code: "validation_failed" });
}

// Workers can't resolve a name before connecting, but their requests leave through Cloudflare's network, which
// never reaches the private networks behind it. Addresses written in the link, and local names, are refused here.
function isUnreachableHost(hostname) {
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
	const isAddress = parseIpv4(hostname) !== null || parseIpv6(hostname) !== null;
	return isAddress && !isPublicAddress(hostname);
}

async function readBody(response, maxBytes) {
	const chunks = [];
	let size = 0;
	const reader = response.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > maxBytes) {
			await reader.cancel();
			throw imageError("Images must be under 4 MB");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

export async function fetchRemoteImage(link, { maxBytes }) {
	let url;
	try {
		url = new URL(link);
	} catch {
		throw imageError("url must be an https:// link");
	}
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
			throw imageError("url must be an https:// link on the standard port");
		}
		if (isUnreachableHost(hostname)) throw imageError("The image link points at an address MailCheap can't reach");

		let response;
		try {
			response = await fetch(url, { redirect: "manual", headers: { accept: "image/*" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
		} catch (error) {
			if (error?.name === "TimeoutError") throw imageError("The image link took too long to answer");
			throw imageError("The image link didn't answer");
		}
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			await response.body?.cancel();
			url = new URL(location, url);
			continue;
		}
		if (response.status !== 200 || !response.body) {
			await response.body?.cancel();
			throw imageError(`The image link answered ${response.status}`);
		}
		if (Number(response.headers.get("content-length")) > maxBytes) {
			await response.body.cancel();
			throw imageError("Images must be under 4 MB");
		}
		return readBody(response, maxBytes);
	}
	throw imageError("The image link redirects too many times");
}
