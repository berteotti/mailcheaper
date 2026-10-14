import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import {
	createUnsubscribeToken,
	getUnsubscribeLinks,
	verifyUnsubscribeToken,
} from "../lib/unsubscribe.js";

process.env.BETTER_AUTH_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.APP_URL = "https://mail.example.com/";

const contactId = "64f1a2b3c4d5e6f7a8b9c0d1";
const otherContactId = "64f1a2b3c4d5e6f7a8b9c0d9";
const newsletterId = "74f1a2b3c4d5e6f7a8b9c0d2";

function signLikeServer(json, secret = process.env.BETTER_AUTH_SECRET) {
	const key = Buffer.from(crypto.hkdfSync("sha256", secret, "", "mailcheap-unsubscribe-v1", 32));
	const payload = Buffer.from(json).toString("base64url");
	return `${payload}.${crypto.createHmac("sha256", key).update(payload).digest("base64url")}`;
}

function withSecret(secret, callback) {
	const original = process.env.BETTER_AUTH_SECRET;
	if (secret === undefined) delete process.env.BETTER_AUTH_SECRET;
	else process.env.BETTER_AUTH_SECRET = secret;
	try {
		return callback();
	} finally {
		process.env.BETTER_AUTH_SECRET = original;
	}
}

test("a token round-trips to the contact and newsletter it was issued for", () => {
	const token = createUnsubscribeToken({ contactId, newsletterId });
	assert.deepEqual(verifyUnsubscribeToken(token), { contactId, newsletterId });
});

test("ObjectId instances and uppercase hex produce the same reference", () => {
	const objectId = { toString: () => contactId.toUpperCase() };
	const token = createUnsubscribeToken({ contactId: objectId, newsletterId });
	assert.deepEqual(verifyUnsubscribeToken(token), { contactId, newsletterId });
	assert.equal(token, createUnsubscribeToken({ contactId, newsletterId }));
});

test("tokens cannot be created for invalid references", () => {
	const invalid = [
		{ contactId: "not-an-object-id", newsletterId },
		{ contactId, newsletterId: undefined },
		{ contactId: null, newsletterId },
		{ contactId, newsletterId: `${newsletterId}0` },
		{ contactId: "../../admin", newsletterId },
	];
	for (const reference of invalid) {
		assert.throws(() => createUnsubscribeToken(reference), /Invalid unsubscribe reference/);
	}
});

test("tampered, forged, and malformed tokens are rejected", () => {
	const token = createUnsubscribeToken({ contactId, newsletterId });
	const [payload, signature] = token.split(".");
	const swapped = Buffer.from(JSON.stringify({ c: otherContactId, n: newsletterId })).toString(
		"base64url"
	);
	const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");

	const rejected = [
		undefined,
		null,
		42,
		{},
		"",
		payload,
		`${payload}.`,
		`.${signature}`,
		`${payload}.${signature}.extra`,
		`${payload}..${signature}`,
		`${payload}.${signature}=`,
		` ${token}`,
		`${swapped}.${signature}`,
		`${payload}.${flipped}`,
		`${"a".repeat(201)}.${signature}`,
		signLikeServer(JSON.stringify({ c: contactId })),
		signLikeServer(JSON.stringify({ c: [contactId], n: newsletterId })),
		signLikeServer(JSON.stringify({ c: contactId, n: "everything" })),
		signLikeServer(JSON.stringify([contactId, newsletterId])),
		signLikeServer("null"),
		signLikeServer("not json"),
	];
	for (const value of rejected) assert.equal(verifyUnsubscribeToken(value), null, String(value));
});

test("tokens signed with another secret are rejected", () => {
	const forged = signLikeServer(
		JSON.stringify({ c: contactId, n: newsletterId }),
		"another-secret-with-at-least-32-characters"
	);
	assert.equal(verifyUnsubscribeToken(forged), null);
	assert.deepEqual(
		verifyUnsubscribeToken(signLikeServer(JSON.stringify({ c: contactId, n: newsletterId }))),
		{ contactId, newsletterId }
	);
});

test("rotating BETTER_AUTH_SECRET invalidates links in sent emails", () => {
	const token = createUnsubscribeToken({ contactId, newsletterId });
	withSecret("rotated-session-secret-with-at-least-32-chars", () =>
		assert.equal(verifyUnsubscribeToken(token), null)
	);
	assert.deepEqual(verifyUnsubscribeToken(token), { contactId, newsletterId });
});

test("signing without BETTER_AUTH_SECRET fails instead of using an empty key", () => {
	withSecret(undefined, () =>
		assert.throws(() => createUnsubscribeToken({ contactId, newsletterId }), /BETTER_AUTH_SECRET/)
	);
});

test("prototype keys never satisfy the payload checks", () => {
	const nested = signLikeServer(`{"__proto__":{"c":"${contactId}","n":"${newsletterId}"}}`);
	assert.equal(verifyUnsubscribeToken(nested), null);

	Object.prototype.c = contactId;
	Object.prototype.n = newsletterId;
	try {
		assert.equal(verifyUnsubscribeToken(signLikeServer("{}")), null);
		assert.equal(verifyUnsubscribeToken(signLikeServer(`{"c":"${contactId}"}`)), null);
	} finally {
		delete Object.prototype.c;
		delete Object.prototype.n;
	}
});

test("links follow RFC 8058 and never include the email address", () => {
	const { pageUrl, headers } = getUnsubscribeLinks({ contactId, newsletterId });
	const page = new URL(pageUrl);
	const oneClick = new URL(headers["List-Unsubscribe"].slice(1, -1));

	assert.equal(page.origin, "https://mail.example.com");
	assert.equal(page.pathname, "/unsubscribe");
	assert.equal(oneClick.origin, "https://mail.example.com");
	assert.equal(oneClick.pathname, "/api/unsubscribe");
	assert.equal(page.searchParams.get("token"), oneClick.searchParams.get("token"));
	assert.deepEqual(verifyUnsubscribeToken(page.searchParams.get("token")), {
		contactId,
		newsletterId,
	});
	assert.match(headers["List-Unsubscribe"], /^<https:\/\/[^>]+>$/);
	assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
	assert.doesNotMatch(pageUrl, /@/);
});
