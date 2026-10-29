"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDeletionBlockers, requestDeletion } from "@/lib/account-deletion";
import { notifyActivity } from "@/lib/alerts";
import { checkDeletionCode, endSessions, requireAccount, sendDeletionCodeEmail, signOutEverywhere } from "@/lib/auth";
import { disconnectUserApps } from "@/lib/oauth";
import { cancelInvitation, changeRole, inviteMember, isOwner, removeMember, renameOrganization } from "@/lib/organizations";
import { isRateLimited } from "@/lib/rate-limit";
import { normalizeEmail } from "@/lib/validation";

// Each code also dies after 3 wrong tries and 5 minutes (Better Auth's emailOTP).
const CODES_PER_ACCOUNT = { name: "deletion-code", limit: 3, window: "15 m" };
const CHECKS_PER_ACCOUNT = { name: "deletion-check", limit: 10, window: "15 m" };
const CODE_PATTERN = /^\d{6}$/;
const BLOCKED_MESSAGE = "Your organization can't be deleted yet. This page says what to do first.";
const OWNERS_ONLY = { error: "Only the organization's owners can do this" };

async function requireOwner() {
	const current = await requireAccount();
	return isOwner(current.member) ? current : null;
}

export async function updateOrganization(_state, formData) {
	const current = await requireOwner();
	if (!current) return OWNERS_ONLY;
	const result = await renameOrganization(current.organization._id, formData.get("name"));
	if (result.ok) revalidatePath("/", "layout");
	return result;
}

export async function invite(_state, formData) {
	const current = await requireOwner();
	if (!current) return OWNERS_ONLY;
	const { invitation, warning, error } = await inviteMember({
		organization: current.organization,
		inviter: current.user,
		email: formData.get("email"),
		role: String(formData.get("role") ?? ""),
	});
	if (error) return { error };
	await notifyActivity(["Invitation sent", `${invitation.email} (${invitation.role})`], { accountId: current.account._id });
	revalidatePath("/organization");
	return { email: invitation.email, warning };
}

export async function cancelInvite(invitationId) {
	const current = await requireOwner();
	if (!current) return OWNERS_ONLY;
	if (!(await cancelInvitation(current.organization._id, String(invitationId)))) return { error: "This invitation is gone already" };
	revalidatePath("/organization");
	return { ok: true };
}

export async function setRole(memberId, role) {
	const current = await requireOwner();
	if (!current) return OWNERS_ONLY;
	const result = await changeRole({ organizationId: current.organization._id, memberId: String(memberId), role: String(role) });
	if (result.ok) revalidatePath("/", "layout");
	return result;
}

// Their sessions end and the apps they connected disconnect, since those work in whichever organization they're in.
// API keys belong to the organization and stay.
export async function removeFromOrganization(memberId) {
	const current = await requireOwner();
	if (!current) return OWNERS_ONLY;
	if (String(memberId) === String(current.member._id)) return { error: "Leave the organization instead" };
	const result = await removeMember({ organizationId: current.organization._id, memberId: String(memberId) });
	if (result.error) return result;
	await disconnectUserApps(result.userId);
	await endSessions(result.userId);
	revalidatePath("/organization");
	return { ok: true };
}

// The next sign-in opens an organization of their own, unless an invitation waits for them.
export async function leaveOrganization() {
	const { user, account, organization, member } = await requireAccount();
	const result = await removeMember({ organizationId: organization._id, memberId: String(member._id) });
	if (result.error) return result;
	await disconnectUserApps(user.id);
	await notifyActivity(["Left the organization", user.email], { accountId: account._id });
	await signOutEverywhere(user.id);
	redirect("/signin");
}

export async function sendDeletionCode() {
	const current = await requireOwner();
	if (!current) return OWNERS_ONLY;
	const { user, account } = current;
	if (await getDeletionBlockers(account)) return { error: BLOCKED_MESSAGE };
	if (await isRateLimited({ ...CODES_PER_ACCOUNT, key: String(account._id) })) return { error: "Too many codes. Try again in 15 minutes." };
	try {
		await sendDeletionCodeEmail(user.email);
	} catch (error) {
		console.error("[account] Could not send a deletion code:", error.message);
		return { error: "Couldn't send the code. Try again in a minute." };
	}
	return { sent: true };
}

// A session left open somewhere isn't enough: it takes an owner, a code sent for this, and their email typed out.
export async function deleteOrganization(_state, formData) {
	const current = await requireOwner();
	if (!current) return OWNERS_ONLY;
	const { user, account } = current;
	const code = String(formData.get("code") ?? "").replace(/\s/g, "");
	if (normalizeEmail(formData.get("email")) !== normalizeEmail(user.email)) return { error: "Type your email address to confirm" };
	if (!CODE_PATTERN.test(code)) return { error: "Enter the 6-digit code" };
	if (await isRateLimited({ ...CHECKS_PER_ACCOUNT, key: String(account._id) })) return { error: "Too many tries. Try again in 15 minutes." };
	if (await getDeletionBlockers(account)) return { error: BLOCKED_MESSAGE };
	if (!(await checkDeletionCode(user.email, code))) return { error: "This code is wrong or expired" };
	try {
		await requestDeletion({ account, user });
	} catch (error) {
		console.error("[account] Deletion failed:", error);
		return { error: "Couldn't delete your organization. Try again in a minute." };
	}
	await notifyActivity(["Organization deleted", user.email], { accountId: account._id });
	redirect("/signin?deleted=1");
}
