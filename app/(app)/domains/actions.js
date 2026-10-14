"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

// SES or Vercel not answering gets a retry hint instead of their error.
function toDomainError(failure, label) {
	const isOurSide = ["internal_error", "unavailable"].includes(failure.code);
	return isOurSide ? { error: `${label} failed, try again in a minute` } : toFormError(failure);
}

export async function addDomainAction(_state, formData) {
	const { output, failure } = await runDashboardAction("add_domain", {
		domain: String(formData.get("domain") ?? ""),
		archiveHost: String(formData.get("archiveHost") ?? ""),
	});
	revalidatePath("/domains");
	return failure ? toDomainError(failure, "Adding the domain") : { ok: true, domain: output.domain };
}

export async function checkDomainAction(domainId) {
	const { output, failure } = await runDashboardAction("check_domain", { id: String(domainId) });
	revalidatePath("/domains");
	if (failure) return toDomainError(failure, "Checking the domain");
	return { ok: true, verified: output.verified, archiveHostVerified: output.archiveHostVerified };
}

export async function removeDomainAction(domainId) {
	const { output, failure } = await runDashboardAction("remove_domain", { id: String(domainId) });
	revalidatePath("/domains");
	return failure ? toDomainError(failure, "Removing the domain") : { ok: true, removed: output.removed };
}

// update_newsletter takes an address at any domain the account added; switching from here waits until it's verified.
export async function switchToDomainAction(_state, formData) {
	const listed = await runDashboardAction("list_domains");
	if (listed.failure) return toFormError(listed.failure);
	const domain = listed.output.domains.find(({ id }) => id === String(formData.get("domainId") ?? ""));
	if (!domain) return { error: "Domain not found" };
	if (!domain.verified) return { error: `${domain.domain} isn't verified yet` };
	const { output, failure } = await runDashboardAction("update_newsletter", {
		id: String(formData.get("newsletterId") ?? ""),
		fromEmail: `${String(formData.get("localPart") ?? "").trim()}@${domain.domain}`,
	});
	revalidatePath("/domains");
	return failure ? toFormError(failure) : { ok: true, fromEmail: output.fromEmail };
}
