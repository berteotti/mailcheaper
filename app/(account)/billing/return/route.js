import { redirect } from "next/navigation";
import { hasActiveSubscription } from "@/lib/account-state";
import { findAccountById } from "@/lib/accounts";
import { requireAccount } from "@/lib/auth";
import { syncCheckoutSession } from "@/lib/billing";
import { isCloud } from "@/lib/config";

// Checkout's success URL. The webhook may not have arrived yet, so the session is read here too.
export async function GET(request) {
	const { account } = await requireAccount();
	if (!isCloud()) redirect("/billing");
	const sessionId = new URL(request.url).searchParams.get("session_id");
	if (sessionId) {
		try {
			await syncCheckoutSession({ account, sessionId });
		} catch (error) {
			console.error("[billing] Couldn't read the checkout session:", error.message);
		}
	}
	const current = await findAccountById(account._id);
	redirect(hasActiveSubscription(current) ? "/" : "/billing?checkout=pending");
}
