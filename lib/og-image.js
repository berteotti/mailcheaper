import "server-only";
import { getAssetStore } from "@/lib/assets";
import { getBindings } from "@/lib/db";
import { fetchRemoteImage } from "@/lib/remote-image";

// A logo is small; this leaves room for a large PNG without letting the card pull down a big file.
const MAX_LOGO_BYTES = 8 * 1024 * 1024;

// Local paths are files in public/, read through the Worker's static assets binding: a deployed Worker has no
// project checkout to read files from.
async function readLocalFile(url) {
	const { ASSETS } = await getBindings();
	if (!ASSETS) return null;
	const response = await ASSETS.fetch(new URL(url, "https://assets.local")).catch(() => null);
	return response?.ok ? Buffer.from(await response.arrayBuffer()) : null;
}

// An upload is read from the R2 bucket itself, not through the asset domain or /media: no round trip to the
// app's own address.
async function readUpload(url) {
	const store = await getAssetStore();
	if (!store || !url.startsWith(`${store.baseUrl}/`)) return undefined;
	const object = await store.bucket.get(decodeURIComponent(url.slice(store.baseUrl.length + 1).split(/[?#]/)[0]));
	if (!object || object.size > MAX_LOGO_BYTES) return null;
	return Buffer.from(await object.arrayBuffer());
}

// The card renderer only decodes PNG and JPEG. A remote logo is a URL the account set, so it's
// downloaded through the same guard as uploads (https only, never a private, loopback or link-local
// address, redirects re-checked), so the card can't make the server fetch an internal address.
async function loadImage(url) {
	let buffer;
	if (url.startsWith("/") && !url.startsWith("//")) {
		buffer = await readLocalFile(url);
	} else {
		buffer = await readUpload(url).catch(() => null);
		if (buffer === undefined) {
			buffer = await fetchRemoteImage(url, { maxBytes: MAX_LOGO_BYTES })
				.then((bytes) => Buffer.from(bytes))
				.catch(() => null);
		}
	}
	if (!buffer) return null;
	const type = buffer[0] === 0x89 && buffer[1] === 0x50 ? "png" : buffer[0] === 0xff && buffer[1] === 0xd8 ? "jpeg" : null;
	return type && `data:image/${type};base64,${buffer.toString("base64")}`;
}

// The card renderer can't decode WebP, so a WebP logo uses the PNG saved next to it.
export async function readLogo(imageUrl) {
	if (!imageUrl) return null;
	return (await loadImage(imageUrl.replace(/\.webp$/i, ".png"))) ?? loadImage(imageUrl);
}

export { loadImage };
