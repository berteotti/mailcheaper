import "server-only";
import { randomBytes } from "node:crypto";
import { IMAGE_CACHE_CONTROL, getAssetStore } from "@/lib/assets";

// R2 deletes up to 1,000 keys a request.
const DELETE_BATCH = 1000;

// Images go to the R2 asset bucket (lib/assets.js), served from the install's asset domain or the app's /media.
export async function getImageStorage() {
	return (await getAssetStore()) ? "r2" : null;
}

export async function getImageStorageProblem() {
	return (await getImageStorage()) ? null : "Image uploads need the R2 asset bucket (ASSETS_BUCKET)";
}

// A random part before the extension, so an upload never replaces another: sent emails point at these files
// forever, so their names never change and browsers can cache them for a year.
export async function putImage(pathname, bytes, contentType) {
	const store = await getAssetStore();
	if (!store) throw new Error("The R2 asset bucket is not configured");
	const key = pathname.replace(/(?=\.[a-z0-9]+$)|$/i, `-${randomBytes(8).toString("hex")}`);
	await store.bucket.put(key, bytes, { httpMetadata: { contentType, cacheControl: IMAGE_CACHE_CONTROL } });
	return { url: `${store.baseUrl}/${key}`, pathname: key };
}

// Uploads' files (an account's purge, or a file whose record wasn't saved), by key. A file that's gone already
// counts as deleted.
export async function deleteImages(uploads) {
	if (uploads.length === 0) return;
	const store = await getAssetStore();
	if (!store) throw new Error("The R2 asset bucket is not configured");
	const keys = uploads.map(({ pathname }) => pathname).filter(Boolean);
	for (let start = 0; start < keys.length; start += DELETE_BATCH) await store.bucket.delete(keys.slice(start, start + DELETE_BATCH));
}

// The app's /media reads R2 on every request, so a deleted image is gone there at once. On the asset domain
// (ASSET_DOMAIN), Cloudflare's cache can keep serving a copy until it expires or the zone's cache is purged: the
// install has no API token to purge it with, so this returns null like upstream without a CDN to invalidate.
export async function invalidateAccountImages() {
	return null;
}
