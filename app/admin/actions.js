"use server";

import { revalidatePath } from "next/cache";
import { blockAccount, unblockAccount } from "@/lib/account-blocks";
import { setLimitOverrides, setSendSpread } from "@/lib/accounts";
import { requireAdmin } from "@/lib/auth";
import { grantFreePlan, revokeFreePlan } from "@/lib/billing";
import { isCloud } from "@/lib/config";
import { getPlan } from "@/lib/plans";
import { isObjectIdString } from "@/lib/validation";

const MAX_REASON_LENGTH = 200;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Empty means the plan's number; anything else must be a whole number.
function readLimit(value) {
	const text = String(value ?? "")
		.replaceAll(",", "")
		.trim();
	if (!text) return undefined;
	const number = Number(text);
	return Number.isInteger(number) && number >= 0 ? number : Number.NaN;
}

// A day from the date field: the plan ends as that day starts, at midnight UTC. Empty means no end.
function readEndDate(value) {
	const text = String(value ?? "").trim();
	if (!text) return null;
	return DATE_PATTERN.test(text) ? new Date(`${text}T00:00:00Z`) : new Date(Number.NaN);
}

// reason: what the account's owner reads on their dashboard.
export async function blockAccountAction(accountId, reason) {
	const admin = await requireAdmin();
	if (!isObjectIdString(accountId)) return { error: "Account not found" };
	const text = String(reason ?? "").trim().slice(0, MAX_REASON_LENGTH);
	const isBlocked = await blockAccount(accountId, { reason: text, by: "admin", detail: `Blocked by ${admin.email}` });
	console.info(`[admin] ${admin.email} blocked account ${accountId}`);
	revalidatePath("/admin");
	return isBlocked ? { ok: true } : { error: "Already blocked" };
}

// The only way a block ends. Its campaigns stay paused until their owner resumes them.
export async function unblockAccountAction(accountId) {
	const admin = await requireAdmin();
	if (!isObjectIdString(accountId)) return { error: "Account not found" };
	try {
		if (!(await unblockAccount(accountId))) return { error: "Not blocked" };
	} catch (error) {
		console.error(`[admin] The provider didn't resume account ${accountId}:`, error);
		return { error: `Still blocked, the tenant wasn't resumed: ${error.message}` };
	}
	console.info(`[admin] ${admin.email} unblocked account ${accountId}`);
	revalidatePath("/admin");
	return { ok: true };
}

export async function setSpread(accountId, isOn) {
	const admin = await requireAdmin();
	if (!isObjectIdString(accountId)) return { error: "Account not found" };
	if (!(await setSendSpread(accountId, isOn === true))) return { error: "Account not found" };
	console.info(`[admin] ${admin.email} turned ${isOn === true ? "on" : "off"} the warm-up for account ${accountId}`);
	revalidatePath("/admin");
	return { ok: true };
}

export async function saveLimits(_state, formData) {
	const admin = await requireAdmin();
	const accountId = String(formData.get("accountId") ?? "");
	if (!isObjectIdString(accountId)) return { error: "Account not found" };
	const limits = { emailsPerMonth: readLimit(formData.get("emailsPerMonth")), subscribers: readLimit(formData.get("subscribers")) };
	if (Object.values(limits).some(Number.isNaN)) return { error: "Use whole numbers, or leave empty for the plan's" };

	if (!(await setLimitOverrides(accountId, limits))) return { error: "Account not found" };
	console.info(`[admin] ${admin.email} set limits for account ${accountId}: ${JSON.stringify(limits)}`);
	revalidatePath("/admin");
	return { ok: true, savedAt: Date.now() };
}

export async function giveFreePlan(_state, formData) {
	const admin = await requireAdmin();
	if (!isCloud()) return { error: "There are no plans on a self-hosted server" };
	const accountId = String(formData.get("accountId") ?? "");
	if (!isObjectIdString(accountId)) return { error: "Account not found" };
	const plan = getPlan(String(formData.get("plan") ?? ""));
	if (!plan) return { error: "Pick a plan" };
	const until = readEndDate(formData.get("until"));
	if (until && !(until > new Date())) return { error: "Pick an end date after today, or none" };

	if (!(await grantFreePlan({ accountId, plan: plan.id, until, by: admin.email }))) return { error: "Account not found" };
	console.info(`[admin] ${admin.email} gave account ${accountId} a free ${plan.name} plan${until ? ` until ${until.toISOString()}` : ""}`);
	revalidatePath("/admin");
	return { ok: true, savedAt: Date.now() };
}

export async function endFreePlan(accountId) {
	const admin = await requireAdmin();
	if (!isObjectIdString(accountId)) return { error: "Account not found" };
	if (!(await revokeFreePlan(accountId))) return { error: "No free plan to end" };
	console.info(`[admin] ${admin.email} ended the free plan of account ${accountId}`);
	revalidatePath("/admin");
	return { ok: true };
}
