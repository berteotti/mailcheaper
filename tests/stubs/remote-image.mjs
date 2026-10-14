// Image links answered from memory instead of the network: tests put the bytes a URL serves here.
export const remoteImages = new Map();
export const requested = [];

export async function fetchRemoteImage(link, { maxBytes }) {
	requested.push(link);
	const bytes = remoteImages.get(link);
	if (!bytes) throw Object.assign(new Error("The image link answered 404"), { code: "validation_failed" });
	if (bytes.length > maxBytes) throw Object.assign(new Error("Images must be under 4 MB"), { code: "validation_failed" });
	return bytes;
}
