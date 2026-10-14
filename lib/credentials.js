import crypto from "node:crypto";

// Secrets a provider shows once (PostShiba SMTP passwords), kept encrypted at rest with AES-256-GCM and
// CREDENTIALS_ENCRYPTION_KEY. Each value has its own IV, and its context (the account and cluster) is
// authenticated with it, so a value copied onto another account doesn't decrypt. Never log a decrypted value.
const VERSION = "v1";
const KEY_PATTERN = /^(?:[0-9a-f]{64}|[A-Za-z0-9+/_-]{43}=?)$/i;

function getKey(env = process.env) {
	const value = String(env.CREDENTIALS_ENCRYPTION_KEY ?? "").trim();
	const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
	if (!KEY_PATTERN.test(value) || key.length !== 32) {
		throw new Error("CREDENTIALS_ENCRYPTION_KEY must be 32 random bytes in base64 or hex (openssl rand -base64 32)");
	}
	return key;
}

export function encryptSecret(plaintext, { context }, env = process.env) {
	if (typeof plaintext !== "string" || !plaintext) throw new Error("Nothing to encrypt");
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", getKey(env), iv, { authTagLength: 16 });
	cipher.setAAD(Buffer.from(String(context)));
	const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptSecret(value, { context }, env = process.env) {
	const [version, iv, tag, data, ...rest] = String(value ?? "").split(".");
	if (version !== VERSION || !iv || !tag || !data || rest.length > 0) throw new Error("Not an encrypted credential");
	try {
		const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(env), Buffer.from(iv, "base64url"), { authTagLength: 16 });
		decipher.setAAD(Buffer.from(String(context)));
		decipher.setAuthTag(Buffer.from(tag, "base64url"));
		return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
	} catch (error) {
		if (error.message.startsWith("CREDENTIALS_ENCRYPTION_KEY")) throw error;
		throw new Error("The credential doesn't decrypt: CREDENTIALS_ENCRYPTION_KEY changed, or it belongs to another account");
	}
}
