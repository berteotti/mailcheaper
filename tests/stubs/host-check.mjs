// Archive hosts that reach this server, set by tests instead of fetched.
export const liveHosts = new Set();

export async function isServedHere(host) {
	return liveHosts.has(host);
}
