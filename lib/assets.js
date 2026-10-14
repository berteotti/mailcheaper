import "server-only";
import { getAppUrl } from "@/lib/config";
import { getBindings, newId } from "@/lib/db";

// Sent emails point at these files forever, so their keys never change and browsers can cache them for a year.
const CACHE_CONTROL = "public, max-age=31536000, immutable";

// Public uploads live in the R2 asset bucket, served from the install's own asset domain (ASSET_URL), or
// by the app at /media until it has one (app/media/[...key]/route.js).
export async function getAssetStore() {
	const { ASSETS_BUCKET } = await getBindings();
	const baseUrl = (process.env.ASSET_URL || `${getAppUrl()}/media`).replace(/\/$/, "");
	return ASSETS_BUCKET ? { bucket: ASSETS_BUCKET, baseUrl } : null;
}

// A random suffix keeps keys unguessable and immutable, like the uploads they replace.
export async function putImage(pathname, bytes, contentType) {
	const store = await getAssetStore();
	if (!store) throw new Error("The R2 asset bucket is not configured");
	const key = pathname.replace(/(\.[a-z0-9]+)$/i, `-${newId()}$1`);
	await store.bucket.put(key, bytes, { httpMetadata: { contentType, cacheControl: CACHE_CONTROL } });
	return `${store.baseUrl}/${key}`;
}
