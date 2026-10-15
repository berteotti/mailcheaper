import "server-only";
import { getSharedDomain } from "@/lib/config";
import { accountIdOf, getOne } from "@/lib/db";
import { hasConnectedApp } from "@/lib/oauth";
import { updateRows } from "@/lib/records";

// A campaign that went out or will: unscheduling one takes it back to draft.
const SENT_STATUSES = ["scheduled", "sending", "paused", "sent"];

// The dashboard's get-started panel, for any account, paying or not, until it's dismissed or finished.
export function isGetStartedOpen(account) {
	return !account.onboarding?.checklistDismissedAt && !account.onboarding?.checklistFinishedAt;
}

// One cheap query per step, all at once. With a shared domain, sending from one's own is optional. Once every
// other step is done the list is finished for good: a key revoked later doesn't bring it back. The steps are the
// account's; the draft to open is the open newsletter's.
export async function getGetStartedSteps(account, newsletterId) {
	const accountId = accountIdOf(account);
	const exists = (sql, params = []) => getOne(`SELECT 1 AS found ${sql} LIMIT 1`, [accountId, ...params]);
	const [campaign, contact, apiKey, isAppConnected, domain, sent, draft] = await Promise.all([
		exists("FROM campaigns WHERE accountId = ? AND status != 'canceled'"),
		exists("FROM contacts WHERE accountId = ?"),
		exists("FROM api_keys WHERE accountId = ? AND level = 'full' AND revokedAt IS NULL"),
		hasConnectedApp(account),
		exists("FROM domains WHERE accountId = ? AND verified = 1"),
		exists("FROM campaigns WHERE accountId = ? AND status IN (SELECT value FROM json_each(?))", [JSON.stringify(SENT_STATUSES)]),
		newsletterId
			? getOne("SELECT _id FROM campaigns WHERE accountId = ? AND newsletterId = ? AND status = 'draft' ORDER BY updatedAt DESC LIMIT 1", [
					accountId,
					String(newsletterId),
				])
			: null,
	]);
	const steps = [
		{ id: "write", isDone: Boolean(campaign) },
		{ id: "subscribers", isDone: Boolean(contact) },
		{ id: "agent", isDone: Boolean(apiKey) || isAppConnected },
		{ id: "domain", isDone: Boolean(domain), isOptional: Boolean(getSharedDomain()) },
		{ id: "send", isDone: Boolean(sent) },
	];
	const isFinished = steps.every(({ isDone, isOptional }) => isDone || isOptional);
	if (isFinished) {
		await updateRows(
			"accounts",
			{ where: "_id = ? AND json_extract(onboarding, '$.checklistFinishedAt') IS NULL", params: [accountId] },
			{ set: { "onboarding.checklistFinishedAt": new Date() } }
		);
	}
	return { steps, draftId: draft ? String(draft._id) : null, isFinished };
}
