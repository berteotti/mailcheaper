import "server-only";
import { getAppUrl, isEmailAllowed } from "@/lib/config";
import { connectDb, execute, getAll, getOne, getValue, newId, statement } from "@/lib/db";
import { sendInvitation } from "@/lib/platform-email";
import { isRateLimited } from "@/lib/rate-limit";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";

// An account belongs to an organization, and people sign in to it as its members (migrations/0014_organizations.sql).
// A person belongs to one organization at most. Owners invite and remove people, handle billing and can delete it;
// members do everything else. There's always an owner.
export const ROLES = ["owner", "member"];
export const MAX_ORGANIZATION_NAME_LENGTH = 100;
// People and invitations waiting, together.
export const MAX_MEMBERS = 50;
export const INVITATION_DAYS = 7;
const INVITATION_MS = INVITATION_DAYS * 24 * 60 * 60 * 1000;
// Each invitation is an email to an address the owner types.
const INVITATIONS_PER_ORGANIZATION = { name: "invitations", limit: 20, window: "1 d" };
export const INVITATIONS_PATH = "/invitations";

export function isOwner(member) {
	return member?.role === "owner";
}

// A new organization takes its first owner's name, or the start of their email when they haven't given one.
export function getDefaultOrganizationName(user) {
	const name = String(user?.name ?? "").trim();
	const local = String(user?.email ?? "").split("@")[0];
	return (name && !name.includes("@") ? name : local || "My organization").slice(0, MAX_ORGANIZATION_NAME_LENGTH);
}

// The user's organization with its account, the user as its owner. Nothing when they belong to one already: the
// batch checks it, so two first requests at once open one. True when this call opened it.
export async function openOrganization(user) {
	const now = Date.now();
	const userId = String(user.id ?? user._id);
	const organizationId = newId();
	const db = await connectDb();
	const [opened] = await db.batch([
		statement(db, "INSERT INTO organizations (_id, name, createdAt, updatedAt) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM members WHERE userId = ?)", [
			organizationId,
			getDefaultOrganizationName(user),
			now,
			now,
			userId,
		]),
		statement(db, "INSERT INTO accounts (_id, ownerId, organizationId, createdAt, updatedAt) SELECT ?, _id, _id, ?, ? FROM organizations WHERE _id = ?", [
			newId(),
			now,
			now,
			organizationId,
		]),
		statement(db, "INSERT INTO members (_id, organizationId, userId, role, createdAt, updatedAt) SELECT ?, _id, ?, 'owner', ?, ? FROM organizations WHERE _id = ?", [
			newId(),
			userId,
			now,
			now,
			organizationId,
		]),
	]);
	return opened.meta.changes > 0;
}

// The user's membership, their organization and its account, or null.
export async function findMembership(userId) {
	const row = await getOne(
		`SELECT m._id, m.role, m.createdAt, o._id AS organizationId, o.name AS organizationName
		FROM members m JOIN organizations o ON o._id = m.organizationId WHERE m.userId = ?`,
		[String(userId)]
	);
	if (!row) return null;
	const account = await getOne("SELECT * FROM accounts WHERE organizationId = ?", [row.organizationId]);
	if (!account) return null;
	return {
		member: { _id: row._id, userId: String(userId), role: row.role, createdAt: row.createdAt },
		organization: { _id: row.organizationId, name: row.organizationName },
		account,
	};
}

// Owners first, then in the order they joined.
export function listMembers(organizationId) {
	return getAll(
		`SELECT m._id, m.userId, m.role, m.createdAt, u.name, u.email, u.image
		FROM members m JOIN users u ON u.id = m.userId WHERE m.organizationId = ?
		ORDER BY m.role = 'owner' DESC, m.createdAt, m._id`,
		[String(organizationId)]
	);
}

export async function renameOrganization(organizationId, value) {
	const name = String(value ?? "").trim().replace(/\s+/g, " ");
	if (!name) return { error: "Give it a name" };
	if (name.length > MAX_ORGANIZATION_NAME_LENGTH) return { error: `Keep the name under ${MAX_ORGANIZATION_NAME_LENGTH} characters` };
	await execute("UPDATE organizations SET name = ?, updatedAt = ? WHERE _id = ?", [name, Date.now(), String(organizationId)]);
	return { ok: true };
}

export function listInvitations(organizationId, now = Date.now()) {
	return getAll("SELECT _id, email, role, expiresAt, createdAt FROM invitations WHERE organizationId = ? AND expiresAt > ? ORDER BY createdAt DESC, _id", [
		String(organizationId),
		now,
	]);
}

// The invitations waiting for an address, newest first, with who sent them.
export function findInvitationsFor(email, now = Date.now()) {
	return getAll(
		`SELECT i._id, i.role, i.expiresAt, i.organizationId, o.name AS organizationName, u.name AS inviterName, u.email AS inviterEmail
		FROM invitations i JOIN organizations o ON o._id = i.organizationId LEFT JOIN users u ON u.id = i.invitedBy
		WHERE i.email = ? AND i.expiresAt > ? ORDER BY i.createdAt DESC, i._id`,
		[String(email ?? "").toLowerCase(), now]
	);
}

export async function hasInvitations(email, now = Date.now()) {
	return Boolean(await getOne("SELECT 1 AS found FROM invitations WHERE email = ? AND expiresAt > ? LIMIT 1", [String(email ?? "").toLowerCase(), now]));
}

// Asks someone to join by email, as an owner or a member. Asking the same address again renews its invitation. A
// self-hosted server's invitations go to its allowlist only, since nobody else can sign in to it.
export async function inviteMember({ organization, inviter, email: emailInput, role }) {
	const email = normalizeEmail(emailInput);
	if (!email) return { error: "Enter a valid email" };
	if (!ROLES.includes(role)) return { error: "Pick owner or member" };
	if (!isEmailAllowed(email)) return { error: "This email can't sign in to this server. Add it to ALLOWED_EMAILS first." };
	const organizationId = String(organization._id);
	const isMember = await getOne("SELECT 1 AS found FROM members m JOIN users u ON u.id = m.userId WHERE m.organizationId = ? AND u.email = ?", [
		organizationId,
		email,
	]);
	if (isMember) return { error: "They're in this organization already" };
	const now = Date.now();
	const people = await getValue(
		`SELECT (SELECT count(*) FROM members WHERE organizationId = ?)
		+ (SELECT count(*) FROM invitations WHERE organizationId = ? AND expiresAt > ? AND email != ?)`,
		[organizationId, organizationId, now, email]
	);
	if (people >= MAX_MEMBERS) return { error: `An organization has up to ${MAX_MEMBERS} people, invitations included` };
	if (await isRateLimited({ ...INVITATIONS_PER_ORGANIZATION, key: organizationId })) return { error: "Too many invitations today. Try again tomorrow." };

	const invitation = await getOne(
		`INSERT INTO invitations (_id, organizationId, email, role, invitedBy, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(organizationId, email) DO UPDATE SET role = excluded.role, invitedBy = excluded.invitedBy, expiresAt = excluded.expiresAt,
		updatedAt = excluded.updatedAt RETURNING _id, email, role, expiresAt`,
		[newId(), organizationId, email, role, String(inviter.id), now + INVITATION_MS, now, now]
	);
	const url = `${getAppUrl()}${INVITATIONS_PATH}`;
	try {
		await sendInvitation({ email, inviterName: String(inviter.name ?? "").trim() || inviter.email, organizationName: organization.name, url });
	} catch (error) {
		console.error("[organizations] Could not send an invitation:", error.message);
		return { invitation, warning: `The email couldn't go out. Ask them to sign in at ${url} to join.` };
	}
	return { invitation };
}

export async function cancelInvitation(organizationId, invitationId) {
	if (!isObjectIdString(invitationId)) return false;
	const { meta } = await execute("DELETE FROM invitations WHERE organizationId = ? AND _id = ?", [String(organizationId), invitationId]);
	return meta.changes > 0;
}

export async function declineInvitation(email, invitationId) {
	if (!isObjectIdString(invitationId)) return false;
	const { meta } = await execute("DELETE FROM invitations WHERE email = ? AND _id = ?", [String(email).toLowerCase(), invitationId]);
	return meta.changes > 0;
}

// A membership that can go: a member's, an owner's while another owner stays, or anyone's in an organization being
// deleted, which nobody needs to restore.
const CAN_LEAVE = `(role = 'member'
	OR (SELECT count(*) FROM members owners WHERE owners.organizationId = members.organizationId AND owners.role = 'owner') > 1
	OR EXISTS (SELECT 1 FROM accounts a WHERE a.organizationId = members.organizationId AND json_extract(a.deletion, '$.requestedAt') IS NOT NULL))`;

// Whether the member could leave now, for the pages to say so before they try.
export async function canLeave(member) {
	return Boolean(await getOne(`SELECT 1 AS found FROM members WHERE _id = ? AND ${CAN_LEAVE}`, [String(member._id)]));
}

// Joins the organization that invited the user, and the invitation goes, in one batch. Someone in an organization
// leaves it first (leaving), when they can and the invitation holds: the caller cuts their access to it
// (app/invitations/actions.js).
export async function acceptInvitation({ user, invitationId, leaving = null }) {
	const expired = { error: "This invitation expired or was canceled" };
	if (!isObjectIdString(invitationId)) return expired;
	const now = Date.now();
	const userId = String(user.id);
	const email = String(user.email).toLowerCase();
	const isValid = "EXISTS (SELECT 1 FROM invitations WHERE _id = ? AND email = ? AND expiresAt > ?)";
	const db = await connectDb();
	const results = await db.batch([
		...(leaving
			? [statement(db, `DELETE FROM members WHERE _id = ? AND userId = ? AND ${CAN_LEAVE} AND ${isValid}`, [String(leaving._id), userId, invitationId, email, now])]
			: []),
		statement(
			db,
			`INSERT INTO members (_id, organizationId, userId, role, createdAt, updatedAt)
			SELECT ?, organizationId, ?, role, ?, ? FROM invitations WHERE _id = ? AND email = ? AND expiresAt > ?
			AND NOT EXISTS (SELECT 1 FROM members WHERE userId = ?)`,
			[newId(), userId, now, now, invitationId, email, now, userId]
		),
		statement(db, "DELETE FROM invitations WHERE _id = ? AND email = ? AND EXISTS (SELECT 1 FROM members WHERE userId = ? AND organizationId = invitations.organizationId)", [
			invitationId,
			email,
			userId,
		]),
	]);
	if (results.at(-2).meta.changes > 0) return { ok: true };
	if (!(await getOne(`SELECT 1 AS found WHERE ${isValid}`, [invitationId, email, now]))) return expired;
	if (leaving && results[0].meta.changes === 0) return { error: "You're its only owner. Make someone else an owner first." };
	return { error: "Leave your organization first" };
}

// Owners change anyone's role, theirs too, as long as an owner stays.
export async function changeRole({ organizationId, memberId, role }) {
	if (!ROLES.includes(role)) return { error: "Pick owner or member" };
	const member = isObjectIdString(memberId) ? await getOne("SELECT _id FROM members WHERE organizationId = ? AND _id = ?", [String(organizationId), memberId]) : null;
	if (!member) return { error: "They're not in this organization" };
	const { meta } = await execute(`UPDATE members SET role = ?, updatedAt = ? WHERE _id = ? AND (? = 'owner' OR ${CAN_LEAVE})`, [role, Date.now(), member._id, role]);
	return meta.changes > 0 ? { ok: true } : { error: "An organization needs an owner. Make someone else an owner first." };
}

// Taking someone out, or leaving: the membership goes when it can (CAN_LEAVE). Returns the user who left, whose access
// the caller cuts.
export async function removeMember({ organizationId, memberId }) {
	if (!isObjectIdString(memberId)) return { error: "They're not in this organization" };
	const removed = await getOne(`DELETE FROM members WHERE organizationId = ? AND _id = ? AND ${CAN_LEAVE} RETURNING userId`, [String(organizationId), memberId]);
	if (removed) return { userId: removed.userId };
	const exists = await getOne("SELECT 1 AS found FROM members WHERE organizationId = ? AND _id = ?", [String(organizationId), memberId]);
	return { error: exists ? "An organization needs an owner. Make someone else an owner first." : "They're not in this organization" };
}
