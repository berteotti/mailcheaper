import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { execute, getAll, getOne, getValue } from "../lib/db.js";
import { activate, as, callApi, catchRedirect, form, mockStripe, platformEmails, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { RedirectError } from "./stubs/next-navigation.mjs";

// Organizations through the real pages' actions: inviting people, joining, roles, leaving and removing, what members
// can't do, deleting an organization with several people, and organizations kept apart.
const OWNERS_ONLY = { error: "Only the organization's owners can do this" };
const LAST_OWNER = { error: "An organization needs an owner. Make someone else an owner first." };

let app;
let m;

// The action's answer, or where it sent the browser.
function answer(user, run) {
	return as(user, run).catch((error) => {
		if (error instanceof RedirectError) return { redirect: error.url };
		throw error;
	});
}

function invite(owner, email, role = "member") {
	return as(owner, () => m.organization.invite(null, form({ email, role })));
}

function findInvitation(email) {
	return getOne("SELECT * FROM invitations WHERE email = ?", [email]);
}

function findMember(user) {
	return getOne("SELECT * FROM members WHERE userId = ?", [user.userId]);
}

function join(user, invitation, fields = {}) {
	return answer(user, () => m.invitations.joinOrganization(null, form({ invitationId: invitation._id, ...fields })));
}

// Someone invited signs in for the first time and joins.
async function invitedMember(owner, email, role = "member") {
	assert.equal((await invite(owner, email, role)).email, email);
	const user = await signIn(email);
	assert.deepEqual(await join(user, await findInvitation(email)), { redirect: "/" });
	user.accountId = owner.accountId;
	return user;
}

async function connectApp(user, clientId = "app-client") {
	const now = new Date().toISOString();
	await execute("INSERT OR IGNORE INTO oauthClient (id, clientId, redirectUris, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)", [
		`client-${clientId}`,
		clientId,
		JSON.stringify(["https://app.example/callback"]),
		now,
		now,
	]);
	await execute("INSERT INTO oauthConsent (id, clientId, userId, scopes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)", [
		`consent-${clientId}-${user.userId}`,
		clientId,
		user.userId,
		JSON.stringify(["mailcheap:full"]),
		now,
		now,
	]);
}

before(async () => {
	app = await startTestApp();
	m = {
		organization: await import("../app/(account)/organization/actions.js"),
		invitations: await import("../app/invitations/actions.js"),
		restore: await import("../app/restore/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		billing: await import("../app/(account)/billing/actions.js"),
		auth: await import("../lib/auth.js"),
		organizations: await import("../lib/organizations.js"),
		oauth: await import("../lib/oauth.js"),
		alerts: await import("../lib/alerts.js"),
		runAction: await import("../lib/actions/run-action.js"),
		deletion: await import("../lib/account-deletion.js"),
		purge: await import("../lib/account-purge.js"),
	};
});

after(() => app?.stop());

describe("invitations", () => {
	test("someone invited signs up into the organization, without one of their own, and works in its account", async () => {
		const owner = await signIn("ivy@example.com");
		await execute("UPDATE users SET name = 'Ivy' WHERE id = ?", [owner.userId]);
		assert.deepEqual(await as(owner, () => m.organization.updateOrganization(null, form({ name: "  Acme   Press " }))), { ok: true });

		assert.deepEqual(await invite(owner, "Jo@Example.com"), { email: "jo@example.com", warning: undefined });
		const email = platformEmails.at(-1);
		assert.deepEqual(email.to, ["jo@example.com"]);
		assert.equal(email.subject, "Join Acme Press on MailCheap");
		assert.match(email.text, /^Ivy invited you to join Acme Press on MailCheap\./);
		assert.match(email.text, /http:\/\/localhost:3000\/invitations/);

		const jo = await signIn("jo@example.com");
		assert.equal(jo.account, null, "no organization of their own while an invitation waits");
		assert.equal(await as(jo, () => catchRedirect(m.auth.requireAccount())), "/invitations");

		assert.deepEqual(await join(jo, await findInvitation("jo@example.com")), { redirect: "/" });
		const current = await as(jo, () => m.auth.requireAccount());
		assert.equal(String(current.account._id), String(owner.accountId));
		assert.equal(current.organization.name, "Acme Press");
		assert.equal(current.member.role, "member");
		assert.equal(await findInvitation("jo@example.com"), null, "the invitation is used up");
		assert.equal(await getValue("SELECT count(*) FROM organizations"), await getValue("SELECT count(*) FROM accounts"), "no organization opened for Jo");
	});

	test("asking again renews the invitation; an owner cancels it; a member can't be invited twice", async () => {
		const owner = await signIn("renew-owner@example.com");
		await invite(owner, "renew@example.com", "member");
		const first = await findInvitation("renew@example.com");
		await invite(owner, "renew@example.com", "owner");
		const renewed = await findInvitation("renew@example.com");
		assert.equal(renewed._id, first._id);
		assert.equal(renewed.role, "owner");

		assert.deepEqual(await as(owner, () => m.organization.cancelInvite(renewed._id)), { ok: true });
		assert.equal(await findInvitation("renew@example.com"), null);

		const member = await invitedMember(owner, "renewed-member@example.com");
		assert.deepEqual(await invite(owner, member.email), { error: "They're in this organization already" });
		assert.deepEqual(await invite(owner, "not an email"), { error: "Enter a valid email" });
		assert.deepEqual(await invite(owner, "x@example.com", "admin"), { error: "Pick owner or member" });
	});

	test("an invitation only works for its own address, until it expires", async () => {
		const owner = await signIn("only-owner@example.com");
		await invite(owner, "meant@example.com");
		const invitation = await findInvitation("meant@example.com");

		const other = await signIn("other-reader@example.com");
		assert.deepEqual(await join(other, invitation, { leave: other.account.organizationId }), { error: "This invitation expired or was canceled" });
		assert.equal(String((await findMember(other)).organizationId), String(other.account.organizationId), "still in their own");
		assert.equal(await as(other, () => m.invitations.decline(invitation._id)).catch((error) => error.url), "/invitations");
		assert.ok(await findInvitation("meant@example.com"), "someone else can't decline it either");

		await execute("UPDATE invitations SET expiresAt = ? WHERE _id = ?", [Date.now() - 1000, invitation._id]);
		const meant = await signIn("meant@example.com");
		assert.ok(meant.account, "an expired invitation doesn't hold back their own organization");
		assert.deepEqual(await join(meant, invitation, { leave: meant.account.organizationId }), { error: "This invitation expired or was canceled" });
	});

	test("someone in an organization leaves it to join, only when the page said so, and never as its only owner", async () => {
		const owner = await signIn("switch-owner@example.com");
		const solo = await signIn("solo@example.com");
		await invite(owner, "solo@example.com");
		const invitation = await findInvitation("solo@example.com");

		assert.deepEqual(await join(solo, invitation), { error: "Leave your organization first" });
		assert.deepEqual(await join(solo, invitation, { leave: solo.account.organizationId }), {
			error: "You're its only owner. Make someone else an owner first.",
		});

		const partner = await invitedMember(solo, "solo-partner@example.com", "owner");
		await connectApp(solo, "solo-app");
		assert.deepEqual(await join(solo, invitation, { leave: solo.account.organizationId }), { redirect: "/" });
		assert.equal(String((await findMember(solo)).organizationId), String(owner.account.organizationId));
		assert.equal(await getValue("SELECT count(*) FROM oauthConsent WHERE userId = ?", [solo.userId]), 0, "the apps they connected disconnect");
		assert.equal((await findMember(partner)).role, "owner", "their old organization keeps its other owner");
	});

	test("instead of joining, someone invited starts their own organization, where the invitation waits", async () => {
		const owner = await signIn("waits-owner@example.com");
		await invite(owner, "own-way@example.com");
		const user = await signIn("own-way@example.com");
		assert.equal(user.account, null);
		assert.equal(await as(user, () => m.invitations.startOwnOrganization()).catch((error) => error.url), "/");
		const current = await as(user, () => m.auth.requireAccount());
		assert.equal(current.member.role, "owner");
		assert.notEqual(String(current.account._id), String(owner.accountId));
		assert.ok(await findInvitation("own-way@example.com"));
	});

	test("a self-hosted server invites only addresses on its allowlist", async () => {
		const owner = await signIn("allow-owner@example.com");
		await withEnv({ MAILCHEAP_CLOUD: "", ALLOWED_EMAILS: "@example.com, allow-owner@example.com" }, async () => {
			assert.deepEqual(await invite(owner, "outsider@example.org"), {
				error: "This email can't sign in to this server. Add it to ALLOWED_EMAILS first.",
			});
			assert.equal((await invite(owner, "insider@example.com")).email, "insider@example.com");
		});
	});
});

describe("roles", () => {
	test("members can't manage people, rename, bill or delete; API keys bill for the organization", async () => {
		const owner = await signIn("roles-owner@example.com");
		await activate(owner);
		const member = await invitedMember(owner, "roles-member@example.com");
		const ownerRow = await findMember(owner);

		assert.deepEqual(await invite(member, "friend@example.com"), OWNERS_ONLY);
		assert.deepEqual(await as(member, () => m.organization.setRole(ownerRow._id, "member")), OWNERS_ONLY);
		assert.deepEqual(await as(member, () => m.organization.removeFromOrganization(ownerRow._id)), OWNERS_ONLY);
		assert.deepEqual(await as(member, () => m.organization.updateOrganization(null, form({ name: "Mine now" }))), OWNERS_ONLY);
		assert.deepEqual(await as(member, () => m.organization.sendDeletionCode()), OWNERS_ONLY);
		assert.deepEqual(await as(member, () => m.organization.deleteOrganization(null, form({ email: member.email, code: "123456" }))), OWNERS_ONLY);

		assert.deepEqual(await answer(member, () => m.billing.openBillingPortal()), { redirect: "/billing?error=owner" });
		const { account, member: membership, user } = await as(member, () => m.auth.requireAccount());
		await assert.rejects(m.runAction.runAction("open_billing_portal", { account, user, member: membership, via: "dashboard" }), { code: "forbidden" });
		await assert.rejects(m.runAction.runAction("change_plan", { account, user, member: membership, via: "mcp", input: { plan: "growth" } }), {
			code: "forbidden",
		});

		const url = "https://billing.stripe.com/p/session/bps_1";
		mockStripe(({ method, path }) => (method === "POST" && path === "/v1/billing_portal/sessions" ? { id: "bps_1", object: "billing_portal.session", url } : null));
		const created = await as(member, () => m.apiKeys.createApiKey(null, form({ name: "Member's key", level: "full" })));
		const portal = await callApi("POST", "/api/v1/billing/portal", { key: created.key });
		assert.deepEqual(portal.body, { url }, "an API key acts for the whole organization");
		mockStripe(null);
	});

	test("there's always an owner: the last one can't step down, be removed or leave", async () => {
		const owner = await signIn("last-owner@example.com");
		const ownerRow = await findMember(owner);
		const member = await invitedMember(owner, "next-owner@example.com");
		const memberRow = await findMember(member);

		assert.deepEqual(await as(owner, () => m.organization.setRole(ownerRow._id, "member")), LAST_OWNER);
		assert.deepEqual(await as(owner, () => m.organization.leaveOrganization()), LAST_OWNER);
		assert.equal(await m.organizations.canLeave(ownerRow), false);
		assert.deepEqual(await as(owner, () => m.organization.removeFromOrganization(ownerRow._id)), { error: "Leave the organization instead" });

		assert.deepEqual(await as(owner, () => m.organization.setRole(memberRow._id, "owner")), { ok: true });
		assert.deepEqual(await as(owner, () => m.organization.setRole(ownerRow._id, "member")), { ok: true });
		assert.deepEqual(await as(member, () => m.organization.removeFromOrganization(ownerRow._id)), { ok: true });
		assert.deepEqual(await as(member, () => m.organization.setRole(memberRow._id, "member")), LAST_OWNER);
	});

	test("an organization's alerts go to every owner", async () => {
		const owner = await signIn("alert-owner@example.com");
		await invitedMember(owner, "alert-second@example.com", "owner");
		await invitedMember(owner, "alert-member@example.com", "member");
		const before = platformEmails.length;
		await m.alerts.sendAlert({ accountId: owner.accountId, key: "owners", title: "Something to see", detail: "For the owners" });
		const sent = platformEmails.slice(before).flatMap(({ to }) => to).sort();
		assert.deepEqual(sent, ["alert-owner@example.com", "alert-second@example.com"]);
	});
});

describe("leaving and removing", () => {
	test("someone removed is signed out, their apps disconnect, and their next sign-in opens an organization of their own", async () => {
		const owner = await signIn("remove-owner@example.com");
		const member = await invitedMember(owner, "removed@example.com");
		await connectApp(member, "member-app");
		await connectApp(owner, "owner-app");
		const apps = await m.oauth.listConnectedApps({ _id: owner.accountId });
		assert.deepEqual(apps.map(({ clientId }) => clientId).sort(), ["member-app", "owner-app"], "the organization's apps are everyone's");

		const memberRow = await findMember(member);
		assert.deepEqual(await as(owner, () => m.organization.removeFromOrganization(memberRow._id)), { ok: true });
		assert.equal(await as(member, () => m.auth.getCurrentAccount()), null, "signed out");
		assert.deepEqual((await m.oauth.listConnectedApps({ _id: owner.accountId })).map(({ clientId }) => clientId), ["owner-app"]);

		const again = await signIn("removed@example.com");
		const current = await as(again, () => m.auth.requireAccount());
		assert.notEqual(String(current.account._id), String(owner.accountId));
		assert.equal(current.member.role, "owner");
	});

	test("a member leaves, signed out everywhere", async () => {
		const owner = await signIn("leave-owner@example.com");
		const member = await invitedMember(owner, "leaver@example.com");
		assert.deepEqual(await answer(member, () => m.organization.leaveOrganization()), { redirect: "/signin" });
		assert.equal(await findMember(member), null);
		assert.equal(await getValue("SELECT count(*) FROM sessions WHERE userId = ?", [member.userId]), 0);
	});

	test("organizations stay apart: an owner can't reach another organization's people or invitations", async () => {
		const ours = await signIn("apart-ours@example.com");
		const theirs = await signIn("apart-theirs@example.com");
		const theirMember = await invitedMember(theirs, "apart-member@example.com");
		await invite(theirs, "apart-invited@example.com");
		const theirMemberRow = await findMember(theirMember);
		const theirInvitation = await findInvitation("apart-invited@example.com");

		assert.deepEqual(await as(ours, () => m.organization.removeFromOrganization(theirMemberRow._id)), { error: "They're not in this organization" });
		assert.deepEqual(await as(ours, () => m.organization.setRole(theirMemberRow._id, "owner")), { error: "They're not in this organization" });
		assert.deepEqual(await as(ours, () => m.organization.cancelInvite(theirInvitation._id)), { error: "This invitation is gone already" });
		assert.equal((await findMember(theirMember)).role, "member");
		assert.ok(await findInvitation("apart-invited@example.com"));
		assert.deepEqual(await m.organizations.listMembers(ours.account.organizationId).then((rows) => rows.map(({ email }) => email)), [ours.email]);
	});
});

describe("deleting an organization", () => {
	test("everyone in it is signed out; the purge deletes their sign-ins, its people, its invitations and the organization", async () => {
		const owner = await signIn("gone-owner@example.com");
		const member = await invitedMember(owner, "gone-member@example.com");
		await invite(owner, "gone-invited@example.com");
		const bystander = await signIn("gone-bystander@example.com");
		const { account, user } = await as(owner, () => m.auth.requireAccount());

		const now = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
		const { purgeAt } = await as(owner, () => m.deletion.requestDeletion({ account, user, now }));
		assert.equal(await as(member, () => m.auth.getCurrentAccount()), null, "the member is signed out too");
		assert.equal(await findInvitation("gone-invited@example.com"), null, "its invitations are canceled");

		const restoring = await signIn("gone-member@example.com");
		assert.equal(await as(restoring, () => catchRedirect(m.auth.requireAccount())), "/restore");
		assert.deepEqual(await as(restoring, () => m.restore.restoreDeletedAccount()), {
			error: "Only the organization's owners can restore it.",
		});

		assert.deepEqual(await m.purge.runPurge({ accountId: String(account._id), purgeAt: purgeAt.toISOString() }), { purged: true });
		assert.equal(await getValue("SELECT count(*) FROM users WHERE id IN (?, ?)", [owner.userId, member.userId]), 0);
		assert.equal(await getValue("SELECT count(*) FROM members WHERE organizationId = ?", [account.organizationId]), 0);
		assert.equal(await getValue("SELECT count(*) FROM organizations WHERE _id = ?", [account.organizationId]), 0);
		assert.equal(await getValue("SELECT count(*) FROM accounts WHERE _id = ?", [account._id]), 0);
		assert.ok(await findMember(bystander), "other organizations stay");
	});
});

test("the migration gives every account from before an organization, its user as the owner", () => {
	const dir = new URL("../migrations/", import.meta.url);
	const files = readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	for (const file of files.filter((file) => file < "0014")) db.exec(readFileSync(new URL(file, dir), "utf8"));
	const at = Date.parse("2026-10-14T12:00:00Z");
	const user = db.prepare(`INSERT INTO users (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`);
	user.run("user-named", "Nora Writer", "nora@example.com", "2026-10-14", "2026-10-14");
	user.run("user-unnamed", "", "quill@example.com", "2026-10-14", "2026-10-14");
	const account = db.prepare("INSERT INTO accounts (_id, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?)");
	account.run("00000000000000000000000a", "user-named", at, at);
	account.run("00000000000000000000000b", "user-unnamed", at, at);

	for (const file of files.filter((file) => file >= "0014")) db.exec(readFileSync(new URL(file, dir), "utf8"));
	const rows = db.prepare(
		`SELECT a._id, o.name, m.userId, m.role FROM accounts a JOIN organizations o ON o._id = a.organizationId
		JOIN members m ON m.organizationId = o._id ORDER BY a._id`
	).all();
	assert.deepEqual(rows.map((row) => ({ ...row })), [
		{ _id: "00000000000000000000000a", name: "Nora Writer", userId: "user-named", role: "owner" },
		{ _id: "00000000000000000000000b", name: "quill", userId: "user-unnamed", role: "owner" },
	]);
	db.close();
});

test("two first requests at once open one organization", async () => {
	const user = await signIn("twice@example.com");
	await execute("DELETE FROM members WHERE userId = ?", [user.userId]);
	const opened = await Promise.all([
		m.organizations.openOrganization({ id: user.userId, email: user.email }),
		m.organizations.openOrganization({ id: user.userId, email: user.email }),
	]);
	assert.deepEqual(opened.sort(), [false, true]);
	assert.equal(await getValue("SELECT count(*) FROM members WHERE userId = ?", [user.userId]), 1);
	const orphans = await getAll("SELECT _id FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.organizationId = o._id)");
	assert.deepEqual(orphans, []);
});
