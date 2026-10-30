"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

// languages: the ones the dialog keeps, when it leaves some out.
export async function importContacts({ newsletterId, rows, consent, importId, duplicates, languages }) {
	const { output, failure } = await runDashboardAction("import_contacts", {
		newsletter: String(newsletterId ?? ""),
		contacts: Array.isArray(rows) ? rows : [],
		consent: consent === true,
		...(importId && { importId: String(importId) }),
		...(duplicates && { duplicates }),
		...(Array.isArray(languages) && { languages: languages.map(String) }),
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
		firstName: String(formData.get("firstName") ?? ""),
		lastName: String(formData.get("lastName") ?? ""),
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

// null: the newsletter's language applies again.
export async function setContactLanguage(id, language) {
	const { failure } = await runDashboardAction("update_contact_language", { id: String(id), language: language ?? null });
	revalidatePath("/contacts");
	return failure ? toFormError(failure) : { ok: true };
}

// An empty name clears it.
export async function setContactName(id, { firstName, lastName } = {}) {
	const { output, failure } = await runDashboardAction("update_contact_name", {
		id: String(id),
		firstName: String(firstName ?? ""),
		lastName: String(lastName ?? ""),
	});
	revalidatePath("/contacts");
	return failure ? toFormError(failure) : { firstName: output.firstName, lastName: output.lastName };
}

// One page of the address check; the dialog passes nextCursor back until it's null.
export async function findUnreachableContacts({ newsletterId, cursor }) {
	const { output, failure } = await runDashboardAction("find_unreachable_contacts", {
		newsletter: String(newsletterId ?? ""),
		...(cursor && { cursor: String(cursor) }),
	});
	return failure ? toFormError(failure) : output;
}

// The contacts picked in the list (ids), or pasted as addresses (emails), which only name the newsletter's.
function toNamedContacts({ ids, emails, newsletterId }) {
	return {
		...(Array.isArray(ids) && { ids: ids.map(String) }),
		...(Array.isArray(emails) && { emails: emails.map(String) }),
		...(newsletterId && { newsletter: String(newsletterId) }),
	};
}

export async function deleteContacts(contacts = {}) {
	const { output, failure } = await runDashboardAction("delete_contacts", toNamedContacts(contacts));
	revalidatePath("/contacts");
	return failure ? toFormError(failure) : output;
}

// change: { status } or { language }, null for the newsletter's.
export async function updateContacts(contacts = {}, { status, language } = {}) {
	const { output, failure } = await runDashboardAction("update_contacts", {
		...toNamedContacts(contacts),
		...(status && { status }),
		...(language !== undefined && { language }),
	});
	revalidatePath("/contacts");
	return failure ? toFormError(failure) : output;
}

// A link to the CSV with the list's filters, valid for an hour. Its language is that tag alone, as the list has it.
export async function exportContacts({ newsletterId, status, query, language } = {}) {
	const { output, failure } = await runDashboardAction("export_contacts", {
		...(newsletterId && { newsletter: String(newsletterId) }),
		...(status && { status }),
		...(query && { search: String(query) }),
		...(language && { language: String(language), exactLanguage: true }),
	});
	return failure ? toFormError(failure) : { url: output.url, count: output.count };
}
