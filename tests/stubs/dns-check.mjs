// No lookups in tests: every name answers with nothing (lib/mail-domains.js has its own stub), but the TXT records
// tests set. A TXT record set to null is a lookup that failed.
export const txts = new Map();

export function createDnsResolver() {
	const none = async (name) => {
		throw Object.assign(new Error(`ENODATA ${name}`), { code: "ENODATA" });
	};
	return { resolveMx: none, resolve4: none, resolve6: none, resolveCname: none };
}

export async function readTxt(host) {
	return txts.has(host) ? txts.get(host) : [];
}
