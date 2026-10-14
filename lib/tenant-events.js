import "server-only";
import { blockAccount } from "@/lib/account-blocks";
import { sendAlert } from "@/lib/alerts";
import { getOne } from "@/lib/db";
import { getEmailProvider } from "@/lib/email-provider";
import { getTenantEventPlan } from "@/lib/tenant-event-rules";
import { updateRows } from "@/lib/records";

// Run by the jobs Worker from the outbox ("ses-tenant-event" jobs). Safe to replay: the account's fields are set,
// and an account blocked already isn't blocked again. The tenant name is unique to one account.
export async function handleTenantEvent(event) {
	const plan = getTenantEventPlan(event);
	if (!plan) return { handled: false };

	const account = await getOne("SELECT _id FROM accounts WHERE json_extract(ses, '$.tenantName') = ?", [plan.tenantName]);
	if (!account) {
		console.warn(`[ses-tenants] Event for an unknown tenant ${plan.tenantName}`);
		return { handled: true };
	}
	const set = {
		...(plan.status && { "ses.tenantStatus": plan.status, "ses.tenantStatusAt": plan.occurredAt }),
		...(plan.finding && { "ses.lastFinding": plan.finding }),
	};
	const unset = plan.finding === null ? ["ses.lastFinding"] : [];
	if (Object.keys(set).length > 0 || unset.length > 0) await updateRows("accounts", { where: "_id = ?", params: [account._id] }, { set, unset });

	// SES enabling the tenant again leaves the account blocked: only an admin unblocks it.
	const isBlocked = plan.pause ? await blockAccount(account._id, { reason: plan.pause, by: "ses" }) : false;
	if (!isBlocked) {
		const detail = plan.pause ?? (plan.finding ? `SES finding: ${plan.finding}` : `SES sending status: ${plan.status ?? "finding closed"}`);
		await sendAlert({
			accountId: null,
			key: `tenant:${account._id}:${plan.status ?? plan.finding ?? "closed"}`,
			title: "SES tenant update",
			detail: `Account ${account._id}: ${detail}`,
			path: "/admin",
		});
	}
	return { handled: true, accountId: String(account._id), blocked: isBlocked };
}

// The provider's abuse team holding the account's tenant (error.hold) blocks the account. Unblocking it waits for
// the provider to lift its hold, then for an admin. The provider's own words go to the admins only.
export async function blockAccountForHold(accountId, error) {
	const provider = getEmailProvider();
	const detail = `${provider.name} holds the tenant: ${String(error.message).slice(0, 200)}`;
	const reason = "Our email provider stopped this account's sending";
	const isBlocked = await blockAccount(accountId, { reason, by: provider.id, detail });
	if (!isBlocked) {
		await sendAlert({ accountId: null, key: `tenant-hold:${accountId}`, title: `${provider.name} holds a tenant`, detail: `Account ${accountId}: ${detail}`, path: "/admin" });
	}
	return isBlocked;
}
