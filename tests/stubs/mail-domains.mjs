// Domains tests mark as unable to receive email, instead of looking them up.
export const domainsWithoutMail = new Set();

export async function findDomainsWithoutMail(domains) {
	return new Set(domains.map((domain) => domain.toLowerCase()).filter((domain) => domainsWithoutMail.has(domain)));
}
