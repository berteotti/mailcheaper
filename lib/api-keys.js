import "server-only";
import { isDeletionPending } from "@/lib/account-state";
import { findAccountById, findUser, isUserAllowed } from "@/lib/accounts";
import { getKeyLevel, hashApiKey, readBearerToken, shouldTouchLastUsed } from "@/lib/api-key-tokens";
import { isCloud } from "@/lib/config";
import { accountIdOf, execute, getAll, getOne } from "@/lib/db";

export { generateApiKey, getKeyLevel, hashApiKey } from "@/lib/api-key-tokens";

// The key decides the account: requests only ever reach that account's data, at the key's level.
export async function authenticateRequest(request) {
	const key = readBearerToken(request.headers.get("authorization"));
	if (!key) return null;

	// The key's hash is unique across accounts: it finds the account, so no account names this query.
	const apiKey = await getOne("SELECT * FROM api_keys WHERE hash = ? AND revokedAt IS NULL", [hashApiKey(key)]);
	if (!apiKey) return null;
	const account = await findAccountById(apiKey.accountId);
	if (!account || isDeletionPending(account)) return null;
	// On a self-hosted server, an owner taken off the allowlist takes their keys with them.
	if (!isCloud() && !isUserAllowed(await findUser(account.ownerId))) return null;

	const now = new Date();
	if (shouldTouchLastUsed(apiKey.lastUsedAt, now.getTime())) {
		await execute("UPDATE api_keys SET lastUsedAt = ?, updatedAt = ? WHERE accountId = ? AND _id = ? AND revokedAt IS NULL", [
			now,
			now,
			account._id,
			apiKey._id,
		]).catch((error) => console.error("[api-keys] Could not update lastUsedAt:", error.message));
	}
	return { apiKey, account, level: getKeyLevel(apiKey) };
}

export function listApiKeys(account) {
	return getAll("SELECT _id, accountId, name, prefix, level, lastUsedAt, revokedAt, createdAt, updatedAt FROM api_keys WHERE accountId = ? ORDER BY createdAt DESC", [
		accountIdOf(account),
	]);
}
