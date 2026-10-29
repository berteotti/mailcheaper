import { LIMITS } from "./config.js";
import { WARNING_LABELS, findContentWarnings, getMergeTagWarnings } from "./content-warnings.js";
import { fillMergeTags } from "./merge-tags.js";
import { UNSUBSCRIBE_PLACEHOLDER, findButtonProblem, hasContent } from "./render-email.js";

// contentWarnings: getContentWarnings' for the campaign, when they're read apart from typing, as they never stop a send.
export function getPresendChecks({
	campaign,
	newsletter,
	rendered,
	senderProblem = null,
	isSendingEnabled,
	planProblem = null,
	contentWarnings = getContentWarnings(campaign),
}) {
	const subject = campaign.subject?.trim() ?? "";
	// What inboxes show for a reader without a name, rather than the tags' own length.
	const subjectLength = fillMergeTags(subject).length;
	// The editor's HTML, Markdown drafts included; an HTML email designed elsewhere has no buttons of ours.
	const buttonProblem = campaign.format === "html" ? null : findButtonProblem(campaign.body);
	const warnings = contentWarnings.map(({ count, ...warning }) => ({
		...warning,
		isOk: false,
		isWarning: true,
		detail: count > 1 ? String(count) : null,
	}));

	const checks = [
		{ id: "subject", label: "Subject", isOk: subject.length > 0, message: "Add a subject" },
		{
			id: "subject-length",
			label: "Subject under 70 characters",
			isOk: subjectLength <= 70,
			isWarning: true,
			detail: subjectLength ? String(subjectLength) : null,
		},
		{
			id: "preview",
			label: "Preview text",
			isOk: Boolean(campaign.previewText?.trim()),
			isWarning: true,
		},
		{ id: "content", label: "Content", isOk: hasContent(campaign.body), message: "Add content" },
		...(buttonProblem ? [{ id: "buttons", label: "Buttons", isOk: false, message: buttonProblem }] : []),
		...warnings,
		{
			id: "unsubscribe",
			label: "Unsubscribe link",
			isOk: rendered.html.includes(UNSUBSCRIBE_PLACEHOLDER),
			message: `Add ${UNSUBSCRIBE_PLACEHOLDER} to the HTML`,
		},
		{
			id: "size",
			label: "Under 100 KB",
			isOk: rendered.bytes <= LIMITS.maxEmailBytes,
			detail: `${Math.ceil(rendered.bytes / 1000)} KB`,
			message: "Gmail clips emails over 100 KB",
		},
		{
			id: "address",
			label: "Postal address",
			isOk: Boolean(newsletter.postalAddress?.trim()),
			message: "Add a postal address to the newsletter",
		},
		{
			id: "domain",
			label: "From address allowed",
			isOk: !senderProblem,
			message: senderProblem,
		},
		{ id: "test", label: "Test sent", isOk: Boolean(campaign.testSentAt), isWarning: true },
		{ id: "plan", label: "Within plan limits", isOk: !planProblem, message: planProblem },
		{ id: "sending", label: "Sending on", isOk: isSendingEnabled, message: "Sending is off" },
	];

	return {
		checks,
		blocking: checks.filter(({ isOk, isWarning }) => !isOk && !isWarning),
	};
}

// What may look broken in an issue, to check before it goes out, each { id, label, message, count, words, field }:
// merge tags that go out as written, then its content's (lib/content-warnings.js). words are what to select to fix it,
// in field (subject, previewText or content). body: the editor's HTML, Markdown drafts included, or for format "html"
// an email designed elsewhere.
export function getContentWarnings({ subject, previewText, body, format }) {
	const tags = getMergeTagWarnings([subject, previewText, body]);
	const [tag] = tags;
	return [
		...(tag
			? [
					{
						...tag,
						label: WARNING_LABELS["merge-tags"],
						count: tags.length,
						field: subject?.includes(tag.words) ? "subject" : previewText?.includes(tag.words) ? "previewText" : "content",
					},
				]
			: []),
		...findContentWarnings(body, { isDesigned: format === "html" }),
	];
}
