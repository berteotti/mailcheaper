import "server-only";
import { APP_NAME, getEmailFrom, getEmailReplyTo, getPlatformEmailService, isCloud } from "@/lib/config";
import { getEmailProvider, isEmailProviderConfigured } from "@/lib/email-provider";
import { escapeHtml } from "@/lib/render-email";

const RESEND_URL = "https://api.resend.com/emails";
const CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4";

async function sendWithResend({ from, to, subject, text, html }) {
	const replyTo = getEmailReplyTo();
	const response = await fetch(RESEND_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({ from, to: [to], subject, text, ...(html && { html }), ...(replyTo && { reply_to: replyTo }) }),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`Resend answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

// Cloudflare Email Service takes a display name apart from the address: "MailCheap <login@example.com>".
function toCloudflareAddress(value) {
	const match = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$/.exec(value);
	if (!match) return value.trim();
	return match[1] ? { address: match[2], name: match[1] } : match[2];
}

async function sendWithCloudflare({ from, to, subject, text, html }) {
	const replyTo = getEmailReplyTo();
	const url = `${CLOUDFLARE_API_URL}/accounts/${encodeURIComponent(process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID.trim())}/email/sending/send`;
	const response = await fetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_EMAIL_API_TOKEN.trim()}`, "Content-Type": "application/json" },
		body: JSON.stringify({ from: toCloudflareAddress(from), to: [to], subject, text, ...(html && { html }), ...(replyTo && { reply_to: replyTo }) }),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`Cloudflare Email Service answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

// MailCheap's own emails (sign-in codes, alerts) go through Resend or Cloudflare Email Service, apart from
// customers' emails, so a problem at the email provider never blocks a login. MailCheap Cloud never sends them any
// other way; a self-hosted server with neither sends them through its email provider.
export async function sendPlatformEmail({ to, subject, text, html }) {
	const from = getEmailFrom();
	if (!from) throw new Error("EMAIL_FROM is not set: MailCheap's own emails need a from address on a domain Resend, Cloudflare or the email provider verified");
	const { service, problem } = getPlatformEmailService();
	if (problem) throw new Error(problem);
	if (service === "resend") return sendWithResend({ from, to, subject, text, html });
	if (service === "cloudflare") return sendWithCloudflare({ from, to, subject, text, html });
	if (isCloud()) throw new Error("Neither RESEND_API_KEY nor CLOUDFLARE_EMAIL_API_TOKEN is set: MailCheap Cloud sends its own emails through Resend or Cloudflare only");
	await getEmailProvider().sendPlatformEmail({ from, to, subject, text, html });
}

// Without a way out, alerts are only logged.
export function canSendPlatformEmail() {
	if (!getEmailFrom()) return false;
	const { service, problem } = getPlatformEmailService();
	if (problem) return false;
	return Boolean(service) || (!isCloud() && isEmailProviderConfigured());
}

// Without Resend or Cloudflare in development, the code shows in the server console instead. Never in production.
async function sendCode({ email, code, label, subject, purpose, ifNotAsked }) {
	if (!getPlatformEmailService().service && process.env.NODE_ENV === "development") {
		console.info(`[${label}] Code for ${email}: ${code}`);
		return;
	}
	const safeCode = escapeHtml(code);
	await sendPlatformEmail({
		to: email,
		subject,
		text: `${purpose} is ${code}. It expires in 5 minutes.\n\n${ifNotAsked}`,
		html: `<div style="max-width:420px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#18181b"><p style="margin:0 0 12px;font-size:15px">${purpose}:</p><p style="margin:0 0 24px;font-size:32px;font-weight:600;letter-spacing:6px">${safeCode}</p><p style="margin:0;font-size:13px;line-height:1.5;color:#71717a">It expires in 5 minutes. ${ifNotAsked}</p></div>`,
	});
}

export function sendSigninCode({ email, code }) {
	return sendCode({
		email,
		code,
		label: "signin",
		subject: `${code} is your ${APP_NAME} code`,
		purpose: "Your sign-in code",
		ifNotAsked: "If you didn't ask for it, you can ignore this email.",
	});
}

// A subject of its own: the owner sees what a code is for, and that someone asked for it.
export function sendDeletionCode({ email, code }) {
	return sendCode({
		email,
		code,
		label: "account",
		subject: `${code} is your code to delete your ${APP_NAME} account`,
		purpose: `Your code to delete your ${APP_NAME} account`,
		ifNotAsked: "If you didn't ask for it, don't share it: your account stays as it is.",
	});
}
