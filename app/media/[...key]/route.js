import { IMAGE_CACHE_CONTROL, getAssetStore } from "@/lib/assets";

// accounts/<account id>/images/<name>-<random>.<ext> (lib/image-storage.js); images/ before accounts had folders.
const IMAGE_KEY = /^(?:accounts\/[0-9a-f]{24}\/)?images\/[a-z0-9-]+\.(png|jpg|gif|webp)$/;

// Uploads are served from the asset domain (ASSET_DOMAIN). Without one (local dev, a test stage),
// ASSET_URL points here and the app Worker reads them from R2 itself.
export async function GET(_request, { params }) {
	const { key } = await params;
	const store = await getAssetStore();
	const path = key.join("/");
	if (!store || !IMAGE_KEY.test(path)) return new Response("Not found", { status: 404 });

	const object = await store.bucket.get(path);
	if (!object) return new Response("Not found", { status: 404 });
	return new Response(object.body, {
		headers: {
			"Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
			"Cache-Control": object.httpMetadata?.cacheControl ?? IMAGE_CACHE_CONTROL,
			ETag: object.httpEtag,
		},
	});
}
