import "server-only";
import { headers } from "next/headers";
import { findOwnerEmail } from "@/lib/accounts";
import { formatActivity } from "@/lib/activity";
import { getAdminEmails, getAppUrl } from "@/lib/config";
import { getOne, newId } from "@/lib/db";
import { canSendPlatformEmail, sendPlatformEmail } from "@/lib/platform-email";
import { getClientIp } from "@/lib/rate-limit";

const DEFAULT_COOLDOWN_MINUTES = 60;

// An account's alerts go to its owner, platform alerts to ADMIN_EMAILS, as MailCheap's own emails (lib/platform-email.js).
async function emailAlert({ accountId, title, text }) {
	if (!canSendPlatformEmail()) return;
	const recipients = accountId ? [await findOwnerEmail(accountId)].filter(Boolean) : getAdminEmails();
	await Promise.all(recipients.map((to) => sendPlatformEmail({ to, subject: `[MailCheap] ${title}`, text })));
}

// A single conditional upsert wins each cooldown, including concurrent consumers. Platform alerts have no
// account; the unique index treats them as account ''.
async function claimAlert({ accountId, key, title, cooldownMinutes }) {
	const now = Date.now();
	return Boolean(
		await getOne(
			`INSERT INTO alerts (_id, accountId, key, title, lastSentAt, createdAt, updatedAt)
			VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(coalesce(accountId, ''), key) DO UPDATE SET
			title = excluded.title, lastSentAt = excluded.lastSentAt, updatedAt = excluded.updatedAt
			WHERE alerts.lastSentAt IS NULL OR alerts.lastSentAt < ? RETURNING _id`,
			[newId(), accountId ? String(accountId) : null, key, title, now, now, now, now - cooldownMinutes * 60_000]
		)
	);
}

// Never throws: a failing alert must not break a send or a webhook. Always logged; emailed at most once
// per cooldown.
export async function sendAlert({
	accountId,
	key,
	title,
	detail,
	path = "",
	cooldownMinutes = DEFAULT_COOLDOWN_MINUTES,
}) {
	console.warn(`[alert]${accountId ? ` account ${accountId}:` : ""} ${title}: ${detail}`);
	try {
		if (!(await claimAlert({ accountId, key, title, cooldownMinutes }))) return;
		await emailAlert({ accountId, title, text: `${title}\n${detail}\n${getAppUrl()}${path}` });
	} catch (error) {
		console.error("[alert] Could not send:", error?.message);
	}
}

// Sign-ins, new API keys and sends, every time, in the logs with where they came from.
export async function notifyActivity(lines, { accountId, withUserAgent = false } = {}) {
	try {
		const list = await headers();
		const text = formatActivity(lines, {
			ip: getClientIp(list),
			country: list.get("cf-ipcountry"),
			userAgent: withUserAgent ? (list.get("user-agent") ?? "") : undefined,
		});
		console.info(`[activity]${accountId ? ` account ${accountId}:` : ""} ${text.replaceAll("\n", " | ")}`);
	} catch (error) {
		console.error("[alert] Activity notice failed:", error?.message);
	}
}
