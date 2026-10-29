"use server";

import { redirect } from "next/navigation";
import { notifyActivity } from "@/lib/alerts";
import { getCurrentAccount } from "@/lib/auth";
import { disconnectUserApps } from "@/lib/oauth";
import { INVITATIONS_PATH, acceptInvitation, declineInvitation, findMembership, openOrganization } from "@/lib/organizations";

async function requireUser() {
	const current = await getCurrentAccount();
	if (!current) redirect(`/signin?next=${INVITATIONS_PATH}`);
	return current;
}

// Someone in an organization leaves it to join, only when the page said so (leave: the organization it showed), so a
// page left open after joining another can't take them out of it. The apps they connected disconnect: they worked in
// the organization they leave.
export async function joinOrganization(_state, formData) {
	const { user, organization, member } = await requireUser();
	const leaving = member && formData.get("leave") === String(organization._id) ? member : null;
	const result = await acceptInvitation({ user, invitationId: String(formData.get("invitationId") ?? ""), leaving });
	if (result.error) return result;
	if (leaving) await disconnectUserApps(user.id);
	const joined = await findMembership(user.id);
	await notifyActivity(["Joined the organization", user.email], { accountId: joined.account._id });
	redirect("/");
}

export async function decline(invitationId) {
	const { user } = await requireUser();
	await declineInvitation(user.email, String(invitationId));
	redirect(INVITATIONS_PATH);
}

// Instead of joining: an organization of their own, where the invitations wait until they leave it.
export async function startOwnOrganization() {
	const { user } = await requireUser();
	await openOrganization(user);
	redirect("/");
}
