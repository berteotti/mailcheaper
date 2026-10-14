"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isDeletionPending } from "@/lib/account-state";
import { notifyActivity } from "@/lib/alerts";
import { getAuth, getCurrentAccount } from "@/lib/auth";
import { answerConsent } from "@/lib/oauth";
import { isExpiredOAuthQuery, readOAuthQuery, readOAuthQueryField } from "@/lib/oauth-rules";

const EXPIRED_MESSAGE = "This request expired. Go back to the app and connect MailCheap again.";

// Allow or Cancel: either way the browser goes back to the app, with a code or with access_denied.
export async function answerConsentRequest(_state, formData) {
	const query = readOAuthQueryField(formData.get("oauth_query"));
	if (!query) return { error: EXPIRED_MESSAGE };
	const current = await getCurrentAccount();
	if (!current) redirect(`/signin?${query}`);
	if (isDeletionPending(current.account)) redirect("/restore");
	const accept = formData.get("decision") === "allow";
	let url;
	try {
		url = await answerConsent({ query, accept });
	} catch (error) {
		if (isExpiredOAuthQuery(error)) return { error: EXPIRED_MESSAGE };
		console.error("[oauth] Consent failed:", error?.message);
		return { error: "Couldn't answer the app. Go back to it and connect MailCheap again." };
	}
	if (!url) return { error: EXPIRED_MESSAGE };
	if (accept) await notifyActivity(["App connected", readOAuthQuery(query).clientId], { accountId: current.account._id });
	redirect(url);
}

// Signs out and back to the sign-in page with the same request, to connect another account.
export async function switchAccount(formData) {
	const query = readOAuthQueryField(formData.get("oauth_query"));
	await (await getAuth()).api.signOut({ headers: await headers() });
	redirect(query ? `/signin?${query}` : "/signin");
}
