import { deleteContacts, updateContacts } from "@/app/(app)/contacts/actions";
import { formatCount, formatNumber } from "@/lib/format";

// update_contacts and delete_contacts take 100 IDs or addresses per call.
const CONTACTS_PER_CALL = 100;
const DONE = { active: "reactivated", unsubscribed: "unsubscribed" };
const ALREADY = { active: "already active", unsubscribed: "already unsubscribed" };
const SKIPPED = {
	active: "only dormant contacts can be reactivated",
	unsubscribed: "bounced and complained contacts can't change",
};

// One change to the contacts picked in the list (ids) or pasted (emails), a call per 100: "delete", or { status } or
// { language } (null for the newsletter's). What the calls answered, added up; error: why one failed, which stops
// the rest. onProgress gets how many have been sent.
export async function changeContacts(change, { ids, emails, newsletterId }, onProgress) {
	const [kind, values] = ids ? ["ids", ids] : ["emails", emails ?? []];
	const totals = {};
	for (let start = 0; start < values.length; start += CONTACTS_PER_CALL) {
		const contacts = { [kind]: values.slice(start, start + CONTACTS_PER_CALL), newsletterId };
		const result = change === "delete" ? await deleteContacts(contacts) : await updateContacts(contacts, change);
		if (result?.error) return { ...totals, error: result.error };
		for (const [key, list] of Object.entries(result)) totals[key] = [...(totals[key] ?? []), ...list];
		onProgress?.(Math.min(start + CONTACTS_PER_CALL, values.length));
	}
	return totals;
}

// What changeContacts did, a line each: the first is what changed.
export function describeContactChange(change, { deleted = [], kept = [], updated = [], unchanged = [], skipped = [], notFound = [] }) {
	const lines = [];
	if (change === "delete") {
		lines.push(`${formatCount(deleted.length, "contact")} deleted`);
		if (kept.length > 0) lines.push(`${formatNumber(kept.length)} kept: they unsubscribed, bounced or complained, or an email to them is going out`);
	} else {
		lines.push(`${formatCount(updated.length, "contact")} ${DONE[change.status] ?? "updated"}`);
		if (unchanged.length > 0) lines.push(`${formatNumber(unchanged.length)} ${ALREADY[change.status] ?? "already had it"}`);
		if (skipped.length > 0) lines.push(`${formatNumber(skipped.length)} skipped: ${SKIPPED[change.status]}`);
	}
	if (notFound.length > 0) lines.push(`${formatNumber(notFound.length)} not found`);
	return lines;
}
