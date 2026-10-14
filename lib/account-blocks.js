import "server-only";
import { BLOCKED_BY, ERROR_CODES, getUnblockHint, isBlocked } from "@/lib/account-state";
import { sendAlert } from "@/lib/alerts";
import { getOne } from "@/lib/db";
import { updateOne, updateRows } from "@/lib/records";
import { resumeTenant, suspendTenantQuietly } from "@/lib/tenants";

export const BLOCKED_CAMPAIGN_REASON = "the account is blocked";

// Every block, whatever set it off, reaches the admins and the owner at once: no cooldown.
async function alertBlock(accountId, { reason, by, detail }) {
	const why = [reason, detail].filter(Boolean).join(". ") || "no reason given";
	await Promise.all([
		sendAlert({
			accountId: null,
			key: `account-blocked:${accountId}`,
			title: "Account blocked",
			detail: `Account ${accountId}, blocked by ${BLOCKED_BY[by] ?? by}: ${why}. Unblock it on the admin page once it's sorted out.`,
			path: "/admin",
			cooldownMinutes: 0,
		}),
		sendAlert({
			accountId,
			key: "account-blocked",
			title: "Account blocked",
			detail: `${reason ? `${reason}. ` : ""}Nothing is sent from this account, welcome emails included, and imports and changes are off. ${getUnblockHint()}`,
			path: "/",
			cooldownMinutes: 0,
		}),
	]);
}

// Spam signals stop the whole account at once: every newsletter's sends, welcome and confirmation emails, imports,
// new contacts and every change but stopping things (lib/actions/run-action.js), and its tenant at the provider.
// Nothing lifts it but an admin (unblockAccount). reason: what the owner reads. detail: for the admins only, like a
// provider's own answer. True when this call blocked it.
export async function blockAccount(accountId, { reason, by = "admin", detail } = {}) {
	const blocked = await updateOne(
		"accounts",
		{ where: "_id = ? AND status != 'paused'", params: [String(accountId)] },
		{ set: { status: "paused", pausedAt: new Date(), pauseReason: reason || null, pausedBy: by } }
	);
	if (!blocked) return false;
	await updateRows(
		"campaigns",
		{ where: "accountId = ? AND status = 'sending'", params: [String(accountId)] },
		{ set: { status: "paused", pauseReason: BLOCKED_CAMPAIGN_REASON, pauseCode: ERROR_CODES.accountBlocked } }
	);
	await suspendTenantQuietly(accountId);
	await alertBlock(accountId, { reason, by, detail });
	return true;
}

// From the admin page only. The provider lifts its own pause on the tenant first, and throws while it holds it
// (PostShiba's operator_hold), so a provider's hold waits for the provider too. True when this call unblocked it.
export async function unblockAccount(accountId) {
	const account = await getOne("SELECT status FROM accounts WHERE _id = ?", [String(accountId)]);
	if (!isBlocked(account)) return false;
	await resumeTenant(accountId);
	const unblocked = await updateOne(
		"accounts",
		{ where: "_id = ? AND status = 'paused'", params: [String(accountId)] },
		{ set: { status: "active" }, unset: ["pausedAt", "pauseReason", "pausedBy"] }
	);
	return Boolean(unblocked);
}
