// CNAMEs set by tests instead of looked up.
export const cnames = new Map();

export async function readCnames(host) {
	return cnames.get(host) ?? [];
}

// No lookups in tests: every name answers with nothing (lib/mail-domains.js has its own stub).
export function createDnsResolver() {
	const none = async (name) => {
		throw Object.assign(new Error(`ENODATA ${name}`), { code: "ENODATA" });
	};
	return { resolveMx: none, resolve4: none, resolve6: none, resolveCname: none };
}
