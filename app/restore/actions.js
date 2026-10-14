"use server";

import { redirect } from "next/navigation";
import { restoreAccount } from "@/lib/account-deletion";
import { isDeletionPending } from "@/lib/account-state";
import { getCurrentAccount } from "@/lib/auth";

export async function restoreDeletedAccount() {
	const current = await getCurrentAccount();
	if (!current) redirect("/signin");
	if (isDeletionPending(current.account) && !(await restoreAccount(current.account))) {
		return { error: "Your account is being deleted, so it can't be restored anymore." };
	}
	redirect("/");
}
