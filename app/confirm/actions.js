"use server";

import { after } from "next/server";
import { isSendingEnabled } from "@/lib/config";
import { verifyConfirmToken } from "@/lib/confirmation";
import { confirmContact } from "@/lib/contacts";
import { queueWelcomeEmail } from "@/lib/sending";
import { findNewsletter } from "@/lib/newsletter-data";

export async function confirmSubscription(token) {
	const reference = verifyConfirmToken(token);
	if (!reference) return { error: "invalid" };

	const { contact, confirmed } = await confirmContact(reference);
	if (contact?.status !== "active") return { error: "invalid" };

	if (confirmed && isSendingEnabled()) {
		const newsletter = await findNewsletter(reference.newsletterId);
		// Skipped while the newsletter confirms signups: the confirmation was their one email.
		after(() =>
			queueWelcomeEmail({ newsletter, contact }).catch((error) =>
				console.error(`[confirm] Welcome email for ${contact._id} failed:`, error.message)
			)
		);
	}
	return { ok: true };
}
