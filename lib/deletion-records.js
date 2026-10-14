import "server-only";
import crypto from "node:crypto";
import { sendAlert } from "@/lib/alerts";
import { getAppSecret } from "@/lib/config";
import { connectDb, execute, getOne, newId, statement } from "@/lib/db";
import { normalizeEmail } from "@/lib/validation";

// Keyed with a key derived from BETTER_AUTH_SECRET: a plain hash of an email is easy to reverse with a list of emails.
function getHashKey() {
	return Buffer.from(crypto.hkdfSync("sha256", getAppSecret(), "", "mailcheap-deleted-email-v1", 32));
}

export function hashEmail(email) {
	const value = normalizeEmail(email) ?? String(email ?? "").trim().toLowerCase();
	return crypto.createHmac("sha256", getHashKey()).update(value).digest("base64url");
}

// The first request's date stays, and a purge that runs again finds the record there.
export function recordDeletionStatement(db, { account, email, requestedAt }) {
	return statement(
		db,
		`INSERT INTO deletion_records (_id, accountId, emailHash, accountCreatedAt, requestedAt) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(accountId) DO NOTHING`,
		[newId(), String(account._id), hashEmail(email), account.createdAt ?? null, requestedAt]
	);
}

export async function recordDeletion(values) {
	await recordDeletionStatement(await connectDb(), values).run();
}

// A restored account wasn't deleted after all.
export function forgetDeletion(accountId) {
	return execute("DELETE FROM deletion_records WHERE accountId = ?", [String(accountId)]);
}

export function markPurged(accountId) {
	return execute("UPDATE deletion_records SET purgedAt = ? WHERE accountId = ?", [new Date(), String(accountId)]);
}

// A new account whose email deleted one before: the admins hear of it, so abuse can be noticed. Never throws.
export async function noticeDeletedBefore(email) {
	try {
		const record = await getOne("SELECT * FROM deletion_records WHERE emailHash = ? ORDER BY requestedAt DESC LIMIT 1", [hashEmail(email)]);
		if (!record) return;
		await sendAlert({
			accountId: null,
			key: `deleted-email-signup:${record.accountId}`,
			title: "A deleted account's email signed up again",
			detail: `${email} deleted account ${record.accountId} on ${record.requestedAt.toISOString().slice(0, 10)}.`,
			path: "/admin",
		});
	} catch (error) {
		console.error("[account] Could not check deletion records:", error.message);
	}
}
