"use server";

import { isObjectIdString as isValidObjectId } from "@/lib/validation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { importContactRows } from "@/lib/contact-import";
import { MAX_IMPORT_ROWS_PER_REQUEST } from "@/lib/csv-import";
import { execute } from "@/lib/db";
import { findNewsletter } from "@/lib/newsletter-data";

export async function importContacts({ newsletterId, rows }) {
	await requireSession();
	if (!isValidObjectId(newsletterId)) return { error: "Newsletter not found" };
	if (!Array.isArray(rows) || rows.length > MAX_IMPORT_ROWS_PER_REQUEST) return { error: "Too many rows" };

	if (!(await findNewsletter(newsletterId))) return { error: "Newsletter not found" };

	const result = await importContactRows({ newsletterId: newsletterId.toLowerCase(), rows });
	revalidatePath("/contacts");
	return result;
}

export async function setContactStatus(id, status) {
	await requireSession();
	if (!isValidObjectId(id) || !["active", "unsubscribed"].includes(status)) {
		return { error: "Invalid request" };
	}

	// Reactivation only applies to dormant contacts; unsubscribes, bounces and complaints are final. It
	// starts the list cleanup over, or the next send would make them dormant again.
	const now = Date.now();
	const result = status === "active"
		? await execute(`UPDATE contacts SET status = 'active', ignoredIssues = 0,
			lastEngagedAt = max(coalesce(lastEngagedAt, 0), ?), updatedAt = ? WHERE _id = lower(?) AND status = 'dormant'
			AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = contacts.email)`, [now, now, id])
		: await execute(`UPDATE contacts SET status = 'unsubscribed', unsubscribedAt = ?, updatedAt = ?
			WHERE _id = lower(?) AND status IN ('active', 'dormant', 'pending')`, [now, now, id]);

	revalidatePath("/contacts");
	return result.meta.changes ? { ok: true } : { error: "Status cannot change" };
}
