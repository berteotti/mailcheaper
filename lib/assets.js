import "server-only";
import { getAppUrl } from "@/lib/config";
import { getBindings } from "@/lib/db";

// Sent emails point at these files forever, so their keys never change and browsers can cache them for a year.
export const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

// Public uploads live in the R2 asset bucket, served from the install's own asset domain (ASSET_URL), or
// by the app at /media until it has one (app/media/[...key]/route.js). lib/image-storage.js writes them.
export async function getAssetStore() {
	const { ASSETS_BUCKET } = await getBindings();
	const baseUrl = (process.env.ASSET_URL || `${getAppUrl()}/media`).replace(/\/$/, "");
	return ASSETS_BUCKET ? { bucket: ASSETS_BUCKET, baseUrl } : null;
}
