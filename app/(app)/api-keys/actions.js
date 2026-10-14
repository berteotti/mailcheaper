"use server";

import { isObjectIdString as isValidObjectId } from "@/lib/validation";
import { revalidatePath } from "next/cache";
import { notifyActivity } from "@/lib/activity-notice";
import { generateApiKey } from "@/lib/api-keys";
import { requireSession } from "@/lib/auth";
import { getAppUrl } from "@/lib/config";
import { execute, newId } from "@/lib/db";

export async function createApiKey(_state, formData) {
	await requireSession();
	const name = String(formData.get("name") ?? "")
		.trim()
		.slice(0, 60);
	if (!name) return { error: "Name is required" };

	const { key, prefix, hash } = generateApiKey();
	const now = Date.now();
	await execute("INSERT INTO api_keys (_id, name, prefix, hash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
		[newId(), name, prefix, hash, now, now]);
	await notifyActivity([`API key created: ${name}`, `${getAppUrl()}/api-keys`]);

	revalidatePath("/api-keys");
	return { key };
}

export async function revokeApiKey(id) {
	await requireSession();
	if (!isValidObjectId(id)) return { error: "Key not found" };

	const now = Date.now();
	await execute("UPDATE api_keys SET revokedAt = ?, updatedAt = ? WHERE _id = lower(?) AND revokedAt IS NULL", [now, now, id]);

	revalidatePath("/api-keys");
	return { ok: true };
}
