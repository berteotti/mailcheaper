// The DNS helper in memory: records MailCheap asked for, by slug, as the helper keeps them on mailcheap.ai.
export const dnsRecords = new Map();
let nextId = 0;

// Like the helper: a slug's records all or none, one record per name for a CNAME.
export async function publishSharedRecords(slug, records) {
	for (const { type, name } of records) {
		if ([...dnsRecords.values()].some((record) => record.name === name && (record.type === "CNAME" || type === "CNAME"))) {
			throw new Error(`The DNS helper refused to create ${slug}'s records: ${type} ${name} is taken`);
		}
	}
	const ids = records.map(({ type, name, value }) => {
		const id = `rec_${++nextId}`;
		dnsRecords.set(id, { id, slug, type, name, value });
		return id;
	});
	return { ids };
}

export async function removeSharedRecords(slug, ids = []) {
	for (const id of ids) if (dnsRecords.get(id)?.slug === slug) dnsRecords.delete(id);
	return { deleted: ids };
}

// What a resolver would find at a name, for the provider stubs deciding whether a domain verifies.
export function findDnsRecord(name, type) {
	return [...dnsRecords.values()].find((record) => record.name === name && record.type === type) ?? null;
}
