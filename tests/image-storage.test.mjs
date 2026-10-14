import assert from "node:assert/strict";
import { test } from "node:test";
import { env as bindings } from "./helpers/bindings.mjs";
import { memoryBucket, withEnv } from "./helpers/app.mjs";

const { deleteImages, getImageStorage, getImageStorageProblem, invalidateAccountImages, putImage } = await import("../lib/image-storage.js");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("images go to the R2 asset bucket; without it, uploads are off and say why", async () => {
	delete bindings.ASSETS_BUCKET;
	assert.equal(await getImageStorage(), null);
	assert.match(await getImageStorageProblem(), /R2 asset bucket \(ASSETS_BUCKET\)/);
	bindings.ASSETS_BUCKET = memoryBucket();
	assert.equal(await getImageStorage(), "r2");
	assert.equal(await getImageStorageProblem(), null);
});

test("uploads get a name of their own in the account's folder, a year of cache, and the asset domain's URL", async () => {
	const bucket = (bindings.ASSETS_BUCKET = memoryBucket());
	const env = { ASSET_URL: "https://assets.example.com/", APP_URL: "https://app.example.com" };
	const first = await withEnv(env, () => putImage("accounts/abc/images/cover.png", PNG, "image/png"));
	const second = await withEnv(env, () => putImage("accounts/abc/images/cover.png", PNG, "image/png"));

	assert.match(first.pathname, /^accounts\/abc\/images\/cover-[0-9a-f]{16}\.png$/);
	assert.notEqual(first.pathname, second.pathname, "the same name twice never replaces the first file");
	assert.equal(first.url, `https://assets.example.com/${first.pathname}`);
	assert.deepEqual(
		[...bucket.objects.values()].map(({ key, httpMetadata, size }) => ({ key, httpMetadata, size })),
		[first, second].map(({ pathname }) => ({
			key: pathname,
			httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" },
			size: PNG.length,
		}))
	);
});

test("without an asset domain, uploads are served by the app at /media", async () => {
	bindings.ASSETS_BUCKET = memoryBucket();
	const stored = await withEnv({ ASSET_URL: "", APP_URL: "https://app.example.com" }, () =>
		putImage("accounts/abc/images/logo.png", PNG, "image/png")
	);
	assert.equal(stored.url, `https://app.example.com/media/${stored.pathname}`);
});

test("deleting uploads removes their files by key; a file that's gone already counts as deleted", async () => {
	const bucket = (bindings.ASSETS_BUCKET = memoryBucket());
	const kept = await putImage("accounts/other/images/a.png", PNG, "image/png");
	const gone = await putImage("accounts/abc/images/b.png", PNG, "image/png");
	await deleteImages([gone, { url: "https://assets.example.com/accounts/abc/images/missing.png", pathname: "accounts/abc/images/missing.png" }]);
	assert.deepEqual([...bucket.objects.keys()], [kept.pathname]);
	await deleteImages([]);
	assert.equal(await invalidateAccountImages("abc"), null, "no CDN to invalidate");
});
