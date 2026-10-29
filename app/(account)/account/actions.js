"use server";

import { revalidatePath } from "next/cache";
import { requireAccount } from "@/lib/auth";
import { saveProfile } from "@/lib/profile";

export async function updateProfile(_state, formData) {
	const { user, account } = await requireAccount();
	const result = await saveProfile({ user, account, name: formData.get("name"), image: formData.get("image") });
	if (result.ok) revalidatePath("/", "layout");
	return result;
}
