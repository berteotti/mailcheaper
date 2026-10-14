import "server-only";
import { hashApiKey, readBearerToken, shouldTouchLastUsed } from "@/lib/api-key-tokens";
import { execute, getOne } from "@/lib/db";

export { generateApiKey, hashApiKey } from "@/lib/api-key-tokens";

export async function authenticateRequest(request) {
	const key = readBearerToken(request.headers.get("authorization"));
	if (!key) return null;

	const apiKey = await getOne("SELECT * FROM api_keys WHERE hash = ? AND revokedAt IS NULL", [hashApiKey(key)]);
	if (!apiKey) return null;

	const now = new Date();
	if (shouldTouchLastUsed(apiKey.lastUsedAt, now.getTime())) {
		await execute("UPDATE api_keys SET lastUsedAt = ?, updatedAt = ? WHERE _id = ? AND revokedAt IS NULL", [now, now, apiKey._id]).catch((error) =>
			console.error("[api-keys] Could not update lastUsedAt:", error.message)
		);
	}
	return apiKey;
}
