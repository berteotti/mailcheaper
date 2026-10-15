import crypto from "node:crypto";

// full: every customer action. signups: only adding contacts, for keys in website code. Keys made before levels
// existed have none and count as signups (getKeyLevel).
export const API_KEY_LEVELS = ["full", "signups"];

const API_KEY_PATTERN = /^mc_[A-Za-z0-9_-]{43}$/;
const LAST_USED_RESOLUTION_MS = 60_000;

// Only the SHA-256 hash is stored: a database leak doesn't leak usable keys.
export function hashApiKey(key) {
	return crypto.createHash("sha256").update(String(key)).digest("hex");
}

export function generateApiKey() {
	const key = `mc_${crypto.randomBytes(32).toString("base64url")}`;
	return { key, prefix: `${key.slice(0, 10)}…`, hash: hashApiKey(key) };
}

export function readBearerToken(authorization) {
	const match = /^Bearer\s+(\S+)$/i.exec(String(authorization ?? "").trim());
	return match && API_KEY_PATTERN.test(match[1]) ? match[1] : null;
}

export function shouldTouchLastUsed(lastUsedAt, now = Date.now()) {
	if (!lastUsedAt) return true;
	return now - new Date(lastUsedAt).getTime() >= LAST_USED_RESOLUTION_MS;
}

// Anything but an explicit full access key, keys from before levels included, can only add contacts.
export function getKeyLevel(apiKey) {
	return apiKey?.level === "full" ? "full" : "signups";
}
