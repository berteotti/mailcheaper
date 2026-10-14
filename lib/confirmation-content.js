import { formatSentence } from "./format.js";
import { renderEmail } from "./render-email.js";

export const CONFIRM_URL_PLACEHOLDER = "{{confirm_url}}";
const CONFIRM_LINK = `href="${CONFIRM_URL_PLACEHOLDER}"`;
const NEXT_STEP = "Confirm your email and the next issue lands in your inbox.";

// The built-in email, and where a newsletter's own version starts. Kept short: one job, one button.
function getDefaultConfirmation(newsletter) {
	const name = newsletter?.name?.trim() || "the newsletter";
	const description = formatSentence(newsletter?.description);
	return {
		subject: `Confirm your subscription to ${name}`,
		previewText: `One click and you're in. Until then, you won't get ${name}.`,
		markdown: `**One click and you're in.**

You asked to get ${name}. ${description ? `${description}\n\n${NEXT_STEP}` : NEXT_STEP}

<a ${CONFIRM_LINK} style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;">Confirm my subscription</a>

Didn't sign up? Ignore this email and you won't hear from us again.`,
	};
}

// Browsers send a textarea's line breaks as CRLF.
function normalizeWhitespace(text) {
	return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}

export function isDefaultConfirmation(confirmation, ...newsletters) {
	return newsletters.some((newsletter) => {
		const builtIn = getDefaultConfirmation(newsletter);
		return ["subject", "previewText", "markdown"].every(
			(key) => normalizeWhitespace(confirmation?.[key]) === normalizeWhitespace(builtIn[key])
		);
	});
}

// Markdown links encode the braces (%7B%7B), so only an HTML link keeps the placeholder.
export function getConfirmationProblem({ subject, markdown }) {
	if (!subject?.trim()) return "Confirmation email needs a subject";
	if (!renderEmail({ markdown }).html.includes(CONFIRM_LINK)) {
		return `Confirmation email needs its button: a link like <a ${CONFIRM_LINK}>Confirm</a>`;
	}
	return null;
}

// What a new subscriber gets when their newsletter asks them to confirm. It's the only email they get,
// so a newsletter can write its own; without one, or if it lost its button, the built-in one goes out.
export function getConfirmationContent(newsletter) {
	const custom = newsletter?.confirmation;
	const { subject, previewText, markdown } =
		custom && !getConfirmationProblem(custom) ? custom : getDefaultConfirmation(newsletter);
	return { format: "markdown", subject: subject.trim(), previewText: previewText?.trim() ?? "", markdown };
}
