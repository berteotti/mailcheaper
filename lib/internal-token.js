import { createHmac, timingSafeEqual } from "node:crypto";
import { MIN_SECRET_LENGTH } from "./config.js";

// The jobs Worker calls the app Worker over a private service binding; the app's routes are still public,
// so internal requests also carry a key derived from BETTER_AUTH_SECRET for that purpose alone.
export function getInternalToken(purpose, secret = process.env.BETTER_AUTH_SECRET) {
	if (!secret || secret.length < MIN_SECRET_LENGTH) throw new Error("BETTER_AUTH_SECRET is missing");
	return createHmac("sha256", secret).update(`mailcheap-internal-v1:${purpose}`).digest("base64url");
}

export function isInternalToken(purpose, value, secret = process.env.BETTER_AUTH_SECRET) {
	try {
		const expected = Buffer.from(getInternalToken(purpose, secret));
		const actual = Buffer.from(String(value ?? ""));
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}
