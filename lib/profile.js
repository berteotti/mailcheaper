import "server-only";
import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { accountIdOf, getOne } from "@/lib/db";

export const MAX_NAME_LENGTH = 80;

// The name and photo the dashboard shows, through Better Auth's user update. A photo is one of the account's
// uploads, or the one the user has already (Google's, from sign-up).
export async function saveProfile({ user, account, name, image }) {
	const cleanName = String(name ?? "").trim().replace(/\s+/g, " ");
	if (cleanName.length > MAX_NAME_LENGTH) return { error: `Keep your name under ${MAX_NAME_LENGTH} characters` };
	const url = String(image ?? "").trim();
	if (url && url !== user.image && !(await getOne("SELECT 1 AS found FROM uploads WHERE accountId = ? AND url = ? LIMIT 1", [accountIdOf(account), url]))) {
		return { error: "Choose a photo you uploaded" };
	}
	await (await getAuth()).api.updateUser({ body: { name: cleanName, image: url || null }, headers: await headers() });
	return { ok: true };
}
