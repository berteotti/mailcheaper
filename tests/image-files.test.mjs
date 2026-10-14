import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBase64Image, detectImageType } from "../lib/image-files.js";
import { fetchRemoteImage, isPublicAddress } from "../lib/remote-image.js";

const bytes = (...values) => new Uint8Array(values);

test("the type comes from the file's first bytes", () => {
	assert.deepEqual(detectImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a)), { contentType: "image/png", extension: "png" });
	assert.deepEqual(detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0)), { contentType: "image/jpeg", extension: "jpg" });
	assert.deepEqual(detectImageType(new TextEncoder().encode("GIF89a")), { contentType: "image/gif", extension: "gif" });
	assert.deepEqual(detectImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), { contentType: "image/webp", extension: "webp" });
	assert.equal(detectImageType(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt ")), null, "a RIFF that isn't WebP");
	assert.equal(detectImageType(new TextEncoder().encode("<svg xmlns=")), null);
	assert.equal(detectImageType(bytes()), null);
});

test("base64 and data URLs decode; anything else doesn't", () => {
	assert.deepEqual(decodeBase64Image(Buffer.from("GIF89a").toString("base64")), new TextEncoder().encode("GIF89a"));
	assert.deepEqual(decodeBase64Image(`data:image/gif;base64,${Buffer.from("GIF89a").toString("base64")}`), new TextEncoder().encode("GIF89a"));
	assert.equal(decodeBase64Image("not base64!"), null);
	assert.equal(decodeBase64Image(""), null);
});

test("downloads never reach private, loopback, link-local or reserved addresses", () => {
	for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
		assert.equal(isPublicAddress(address), true, address);
	}
	for (const address of [
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"255.255.255.255",
		"::1",
		"::",
		"fd00::1",
		"fe80::1",
		"::ffff:127.0.0.1",
		"::ffff:169.254.169.254",
		"not-an-ip",
	]) {
		assert.equal(isPublicAddress(address), false, address);
	}
});

test("only https links on the standard port, and never an IP address that isn't public", async () => {
	for (const link of ["http://example.com/a.png", "https://user:pass@example.com/a.png", "https://example.com:8443/a.png", "ftp://example.com/a.png", "nonsense"]) {
		await assert.rejects(fetchRemoteImage(link, { maxBytes: 1000 }), { code: "validation_failed" }, link);
	}
	for (const link of ["https://127.0.0.1/a.png", "https://169.254.169.254/latest/meta-data", "https://[::1]/a.png", "https://10.0.0.5/a.png"]) {
		await assert.rejects(fetchRemoteImage(link, { maxBytes: 1000 }), /can't reach/, link);
	}
});
