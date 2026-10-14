"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

export async function importContacts({ newsletterId, rows, consent, importId, duplicates }) {
	const { output, failure } = await runDashboardAction("import_contacts", {
		newsletter: String(newsletterId ?? ""),
		contacts: Array.isArray(rows) ? rows : [],
		consent: consent === true,
		...(importId && { importId: String(importId) }),
		...(duplicates && { duplicates }),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/contacts");
	return output;
}

// With the box ticked, the contact is active at once: no confirmation email, the welcome email if it's on.
export async function addContact(_state, formData) {
	const { output, failure } = await runDashboardAction("add_contact", {
		newsletter: String(formData.get("newsletterId") ?? ""),
		email: String(formData.get("email") ?? ""),
		consent: formData.get("consent") === "on",
	});
	if (failure) return toFormError(failure);
	revalidatePath("/contacts");
	if (!output.created) return { error: `${output.email} is already a contact` };
	return { email: output.email, status: output.status };
}

export async function setContactStatus(id, status) {
	const { failure } = await runDashboardAction("update_contact_status", { id: String(id), status });
	revalidatePath("/contacts");
	return failure ? toFormError(failure) : { ok: true };
}

// A link to the CSV with the list's filters, valid for an hour.
export async function exportContacts({ newsletterId, status, query } = {}) {
	const { output, failure } = await runDashboardAction("export_contacts", {
		...(newsletterId && { newsletter: String(newsletterId) }),
		...(status && { status }),
		...(query && { search: String(query) }),
	});
	return failure ? toFormError(failure) : { url: output.url, count: output.count };
}
