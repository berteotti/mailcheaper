import "server-only";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { getOne, newId } from "@/lib/db";
import { waitForSendSlot } from "@/lib/pacing";
import { sendSesEmail } from "@/lib/ses";

const DEFAULT_COOLDOWN_MINUTES = 60;

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

// Optional: needs ALERT_FROM on a verified domain, and goes out only while sending is on.
export async function sendEmail({ title, text }) {
	const { ALERT_FROM: from, ADMIN_EMAIL: to } = process.env;
	if (!from || !to || !isSendingEnabled()) return;
	await waitForSendSlot();
	await sendSesEmail({
		from,
		to,
		subject: `[Mailcheap] ${title}`,
		text,
		html: `<pre style="font:14px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
	});
}

// A single conditional upsert wins each cooldown, including concurrent consumers.
async function claimAlert({ key, title, cooldownMinutes }) {
	const now = Date.now();
	return Boolean(await getOne(`INSERT INTO alerts (_id, key, title, lastSentAt, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET
		title = excluded.title, lastSentAt = excluded.lastSentAt, updatedAt = excluded.updatedAt
		WHERE alerts.lastSentAt IS NULL OR alerts.lastSentAt < ? RETURNING _id`,
	[newId(), key, title, now, now, now, now - cooldownMinutes * 60_000]));
}

// Never throws: a failing alert must not break a send or a webhook. Always logged; emailed to
// ADMIN_EMAIL at most once per cooldown.
export async function sendAlert({ key, title, detail, path = "", cooldownMinutes = DEFAULT_COOLDOWN_MINUTES }) {
	console.warn(`[alert] ${title}: ${detail}`);
	try {
		if (!(await claimAlert({ key, title, cooldownMinutes }))) return;
		await sendEmail({ title, text: `${title}\n${detail}\n${getAppUrl()}${path}` });
	} catch (error) {
		console.error("[alert] Could not send:", error?.message);
	}
}
