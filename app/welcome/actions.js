"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";
import { requireAccount } from "@/lib/auth";
import { LIST_SIZES, LIST_SOURCES, findFreeSlug, needsOnboarding } from "@/lib/onboarding";
import { updateRows } from "@/lib/records";
import { siteExtensions } from "@/lib/site-extensions";

function readText(formData, key) {
	return String(formData.get(key) ?? "").trim();
}

function readChoice(formData, key, choices) {
	const value = readText(formData, key);
	return choices.includes(value) ? value : null;
}

// Creates the account's newsletter, keeps what it said about its list, then opens the dashboard. Sent twice,
// the second time only finishes: the newsletter is there.
export async function completeOnboarding(_state, formData) {
	const { account } = await requireAccount();
	const name = readText(formData, "name");
	if (!name) return { error: "Name your newsletter" };
	if (await needsOnboarding(account)) {
		const { failure } = await runDashboardAction("create_newsletter", {
			name,
			slug: await findFreeSlug(name),
			description: readText(formData, "description"),
			fromName: readText(formData, "fromName"),
		});
		if (failure) return toFormError(failure);
		await siteExtensions.sendGoalOnNextPage("onboarding_completed");
	}

	const listSize = readChoice(formData, "listSize", LIST_SIZES.map(({ id }) => id));
	const listSource = listSize && listSize !== "none" ? readChoice(formData, "listSource", LIST_SOURCES) : null;
	await updateRows(
		"accounts",
		{ where: "_id = ?", params: [account._id] },
		{
			set: {
				"onboarding.completedAt": new Date(),
				...(listSize && { "onboarding.listSize": listSize }),
				...(listSource && { "onboarding.listSource": listSource }),
			},
		}
	);
	redirect("/");
}

// The dashboard's get-started panel, hidden on the account so it stays hidden on every device.
export async function dismissGetStarted() {
	const { account } = await requireAccount();
	await updateRows(
		"accounts",
		{ where: "_id = ? AND json_extract(onboarding, '$.checklistDismissedAt') IS NULL", params: [account._id] },
		{ set: { "onboarding.checklistDismissedAt": new Date() } }
	);
	revalidatePath("/", "layout");
	return { ok: true };
}
