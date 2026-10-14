import { formatSentence } from "./format.js";

// Where the settings form starts a welcome email switched on with no subject and no content. Only a prefill:
// saved welcome emails go out as they are (lib/sending-rules.js).
export function prefillWelcome(welcome, newsletter) {
	if (welcome.subject.trim() || welcome.markdown.trim()) return welcome;
	const name = newsletter?.name?.trim() || "the newsletter";
	const intro = [`Thanks for joining ${name}.`, formatSentence(newsletter?.description)].filter(Boolean).join(" ");
	return {
		...welcome,
		subject: `Welcome to ${name}`,
		markdown: `${intro}

The next issue lands in your inbox. Hit reply to say hi.`,
	};
}
