"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";
import { getSelectedNewsletter, saveSelectedNewsletter, switchNewsletter } from "@/lib/selected-newsletter";

function readText(formData, key) {
	return String(formData.get(key) ?? "").trim();
}

// Empty stays unset, so the newsletter's default applies.
function readNumber(formData, key) {
	const text = readText(formData, key);
	return text ? Number(text) : null;
}

// A collapsed email section sends no fields, and what it had saved stays as it is.
function readSettings(formData) {
	return {
		name: readText(formData, "name"),
		slug: readText(formData, "slug"),
		...(formData.has("language") && { language: readText(formData, "language") }),
		imageUrl: readText(formData, "imageUrl"),
		fromName: readText(formData, "fromName"),
		fromEmail: readText(formData, "fromEmail"),
		replyTo: readText(formData, "replyTo"),
		postalAddress: readText(formData, "postalAddress"),
		archiveEnabled: formData.get("archiveEnabled") === "on",
		description: readText(formData, "description"),
		author: { bio: readText(formData, "authorBio"), imageUrl: readText(formData, "authorImageUrl") },
		socialLinks: readText(formData, "socialLinks").split(/[\s,]+/).filter(Boolean),
		requireConfirmation: formData.get("requireConfirmation") === "on",
		cleanup: {
			enabled: formData.get("cleanupEnabled") === "on",
			issues: readNumber(formData, "cleanupIssues"),
			days: readNumber(formData, "cleanupDays"),
		},
		...(formData.has("welcomeSubject") && {
			welcome: {
				enabled: formData.get("welcomeEnabled") === "on",
				subject: readText(formData, "welcomeSubject"),
				previewText: readText(formData, "welcomePreviewText"),
				markdown: String(formData.get("welcomeMarkdown") ?? ""),
			},
		}),
		...(formData.has("confirmationSubject") && {
			confirmation: {
				subject: readText(formData, "confirmationSubject"),
				previewText: readText(formData, "confirmationPreviewText"),
				markdown: String(formData.get("confirmationMarkdown") ?? ""),
			},
		}),
	};
}

export async function sendWelcomeTest(newsletterId) {
	const { failure } = await runDashboardAction("send_welcome_test_email", { id: String(newsletterId ?? "") });
	return failure ? toFormError(failure) : { ok: true };
}

export async function saveNewsletter(_state, formData) {
	const id = readText(formData, "id");
	const settings = readSettings(formData);
	const { output, failure } = id
		? await runDashboardAction("update_newsletter", { id, ...settings })
		: await runDashboardAction("create_newsletter", settings);
	if (failure) return toFormError(failure);
	revalidatePath("/newsletters");
	if (!id) redirect(`/newsletters/${output.id}`);
	return { ok: true, savedAt: Date.now() };
}

// Delete newsletter's dialog, with the name its user typed. The dashboard opens the account's first newsletter next.
export async function deleteNewsletter(id, confirmName) {
	const { failure } = await runDashboardAction("delete_newsletter", { id: String(id ?? ""), confirmName: String(confirmName ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/", "layout");
	redirect("/");
}

// The newsletter menu. Which newsletter the dashboard shows is its own state, a cookie: no action of the API runs.
export async function selectNewsletter(id, pathname) {
	return switchNewsletter(id, pathname);
}

// Add a newsletter: a name and a description. The sender's name and postal address are the newsletter's that was
// open, so it can send once its settings look right; without a shared domain, the form also asks for its address.
export async function createNewsletter(_state, formData) {
	const name = readText(formData, "name");
	if (!name) return { error: "Name your newsletter" };
	const { selected } = await getSelectedNewsletter();
	const fromEmail = readText(formData, "fromEmail");
	const { output, failure } = await runDashboardAction("create_newsletter", {
		name,
		description: readText(formData, "description"),
		...(fromEmail && { fromEmail }),
		...(selected?.fromName && { fromName: selected.fromName }),
		...(selected?.postalAddress && { postalAddress: selected.postalAddress }),
	});
	if (failure) return toFormError(failure);
	await saveSelectedNewsletter(output.id);
	redirect("/newsletters");
}

// Design (FormTheme): a preset alone applies it as it comes; the customizer sends a theme's full values.
export async function saveTheme(newsletterId, theme) {
	const { output, failure } = await runDashboardAction("update_newsletter", { id: String(newsletterId ?? ""), theme });
	if (failure) return toFormError(failure);
	revalidatePath("/newsletters", "layout");
	return { ok: true, theme: output.theme };
}
