import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readLogo } from "../lib/og-image.js";
import { remoteImages, requested } from "./stubs/remote-image.mjs";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(() => {
	remoteImages.clear();
	requested.length = 0;
});

// A newsletter's imageUrl is set by its account, so the share card must download it through the same
// guard as uploads: an https link only, never a private, loopback or link-local address, never a raw
// fetch that would let the card reach an internal service (SSRF).
test("the share card downloads a remote logo through the SSRF-guarded fetcher, not a raw request", async () => {
	const url = "https://cdn.example.com/logo.png";
	remoteImages.set(url, PNG);
	const realFetch = globalThis.fetch;
	globalThis.fetch = () => assert.fail("the share card must not fetch a logo URL directly");
	try {
		assert.match(await readLogo(url), /^data:image\/png;base64,/);
		assert.ok(requested.includes(url), "the logo went through fetchRemoteImage");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("a logo at a private, loopback or link-local address yields no logo, through the guard", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = () => assert.fail("the share card must not fetch a logo URL directly");
	try {
		for (const url of ["https://169.254.169.254/latest/meta-data", "https://127.0.0.1/logo.png", "https://10.0.0.5/logo.png"]) {
			assert.equal(await readLogo(url), null, url);
			assert.ok(requested.includes(url), `${url} reached the guard, not a raw fetch`);
		}
	} finally {
		globalThis.fetch = realFetch;
	}
});
