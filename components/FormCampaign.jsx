"use client";

import { useCallback, useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState, useTransition } from "react";
import { Check, CircleAlert, Copy, FlaskConical, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
	addCampaignEdition,
	deleteCampaignEdition,
	duplicateCampaign,
	saveCampaign,
	saveCampaignEdition,
	sendTestCampaign,
	setCampaignLanguage,
} from "@/app/(app)/campaigns/actions";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import BadgeStatus from "@/components/BadgeStatus";
import DialogDeleteEdition from "@/components/DialogDeleteEdition";
import DialogDiscardCampaign from "@/components/DialogDiscardCampaign";
import DialogScheduleCampaign from "@/components/DialogScheduleCampaign";
import DialogSendCampaign from "@/components/DialogSendCampaign";
import EditorRich from "@/components/EditorRich";
import GatePlan from "@/components/GatePlan";
import HeaderPage from "@/components/HeaderPage";
import InputCampaignSlug from "@/components/InputCampaignSlug";
import ListChecks from "@/components/ListChecks";
import PreviewEmail from "@/components/PreviewEmail";
import TabsEditions from "@/components/TabsEditions";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/format";
import { DEFAULT_LANGUAGE, getLanguageName, getLanguageTag, matchLanguage } from "@/lib/languages";
import { markdownToHtml } from "@/lib/markdown";
import { getPresendChecks } from "@/lib/presend-checks";
import { UNSUBSCRIBE_PLACEHOLDER, hasContent, renderEmail, withResponsiveImages } from "@/lib/render-email";
import { slugify } from "@/lib/slug";
import { usePaywall } from "@/lib/use-paywall";
import { useToastError } from "@/lib/use-toast-error";
import { useAutosave } from "@/lib/use-autosave";

const UPLOADING_MESSAGE = "Wait for images to finish uploading";
// The campaign's own subject and content among its editions, whatever its language: longer than any language code.
const OWN = "campaign";

// The editor saves rich text, or the HTML of an imported issue; Markdown opens as rich text.
function toDraft(content) {
	return {
		subject: content.subject,
		previewText: content.previewText,
		body: content.format === "markdown" ? markdownToHtml(content.markdown) : content.html,
		format: content.format === "html" ? "html" : "rich",
	};
}

export default function FormCampaign({
	campaign,
	newsletter,
	editions,
	language,
	audience,
	audienceCount,
	senderProblem,
	isSendingEnabled,
	testEmail,
	sendTimes,
	archiveUrlBase,
	planProblem,
	emailsLeft,
	warmup,
	newContacts,
}) {
	const [isDiscardOpen, setIsDiscardOpen] = useState(false);
	const [deleting, setDeleting] = useState(null);
	// Each language's subject, preview text and body, saved together: a save sends the ones that changed.
	const [drafts, setDrafts] = useState(() => ({
		[OWN]: toDraft(campaign),
		...Object.fromEntries(editions.map((edition) => [getLanguageTag(edition), toDraft(edition)])),
	}));
	const savedDraftsRef = useRef(drafts);
	const [active, setActive] = useState(OWN);
	const values = drafts[active] ?? drafts[OWN];
	const isHtml = values.format === "html";
	const activeLanguage = active === OWN ? language : active;
	const save = useCallback(
		async (snapshot) => {
			for (const [key, draft] of Object.entries(snapshot)) {
				if (savedDraftsRef.current[key] === draft) continue;
				const result = key === OWN ? await saveCampaign(campaign._id, draft) : await saveCampaignEdition(campaign._id, key, draft);
				if (result?.error) return result;
				savedDraftsRef.current = { ...savedDraftsRef.current, [key]: draft };
			}
			return { ok: true };
		},
		[campaign._id]
	);
	const { isDirty, isSaving, error, flush } = useAutosave(drafts, save);
	const [isTesting, startTesting] = useTransition();
	const [isWorking, startWorking] = useTransition();
	const toastError = useToastError();
	const paywall = usePaywall();
	const hasPlan = paywall?.hasPlan ?? true;
	const deferredValues = useDeferredValue(values);
	const isUploading = Object.values(drafts).some(({ body }) => body.includes('src="blob:'));

	const rendered = useMemo(
		() =>
			renderEmail({
				format: deferredValues.format,
				html: deferredValues.body,
				subject: deferredValues.subject,
				previewText: deferredValues.previewText,
				newsletter,
				language: activeLanguage,
			}),
		[deferredValues, newsletter, activeLanguage]
	);
	const previewHtml = useMemo(
		() => withResponsiveImages(rendered.html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#")),
		[rendered.html]
	);
	const { checks, blocking } = getPresendChecks({
		campaign: { ...campaign, ...values },
		newsletter,
		rendered,
		senderProblem,
		isSendingEnabled,
		planProblem,
	});
	// The checks list is the open language's; the other languages block a send without a subject or content.
	const otherProblem = Object.entries(drafts)
		.filter(([key]) => key !== active)
		.map(([key, draft]) => {
			const problem = !draft.subject.trim() ? "add a subject" : !hasContent(draft.body) ? "add content" : null;
			return problem && `${getLanguageName(key === OWN ? language : key)}: ${problem}`;
		})
		.find(Boolean);
	// Without a plan, Send and Schedule open the paywall first; the checks wait until there's one.
	const blockingMessage = !hasPlan ? null : isUploading ? UPLOADING_MESSAGE : (blocking[0]?.message ?? otherProblem);
	const contactsReading = (tag) => audience.reduce((sum, row) => sum + (row.edition === tag ? row.contacts : 0), 0);
	const tabs = [
		{ key: OWN, language, contacts: contactsReading(language) },
		...Object.keys(drafts)
			.filter((key) => key !== OWN)
			.map((key) => ({ key, language: key, contacts: contactsReading(key) })),
	];
	const leftOut = audience.filter(({ edition }) => !edition);
	const leftOutCount = leftOut.reduce((sum, { contacts }) => sum + contacts, 0);
	// Languages read by contacts who get another one, or nothing, to add first.
	const missing = audience.filter(({ language: tag, edition }) => matchLanguage(tag, edition ? [edition] : []) === null);
	// Once an edition is gone, its readers get another of the campaign's languages, else the newsletter's, if it has it.
	const getNextLanguage = (tag) => {
		const others = tabs.map((tab) => tab.language).filter((each) => each !== tag);
		return matchLanguage(tag, others) ?? matchLanguage(getLanguageTag(newsletter) ?? DEFAULT_LANGUAGE, others);
	};

	async function persist() {
		if (await flush()) return true;
		toast.error("Couldn't save the draft");
		return false;
	}

	function sendTest() {
		if (!hasPlan) return paywall.open("test");
		startTesting(async () => {
			if (isUploading) return void toast.error(UPLOADING_MESSAGE);
			if (!(await persist())) return;
			const result = await sendTestCampaign(campaign._id, active === OWN ? null : active);
			if (result?.error) toastError(result);
			else toast.success(`Test sent to ${testEmail}`);
		});
	}

	function runAction(action) {
		startWorking(async () => {
			const result = await action(campaign._id);
			if (result?.error) toast.error(result.error);
		});
	}

	function addEdition(tag) {
		startWorking(async () => {
			if (!(await persist())) return;
			const result = await addCampaignEdition(campaign._id, tag);
			if (result?.error) return void toast.error(result.error);
			const draft = { subject: "", previewText: "", body: "", format: "rich" };
			savedDraftsRef.current = { ...savedDraftsRef.current, [tag]: draft };
			setDrafts((current) => ({ ...current, [tag]: draft }));
			setActive(tag);
		});
	}

	// What was typed in it is saved first, so a save still waiting can't bring it back.
	async function deleteEdition(tag) {
		if (!(await persist())) return false;
		const result = await deleteCampaignEdition(campaign._id, tag);
		if (result?.error) {
			toast.error(result.error);
			return false;
		}
		const withoutEdition = ({ [tag]: _deleted, ...rest }) => rest;
		savedDraftsRef.current = withoutEdition(savedDraftsRef.current);
		setDrafts(withoutEdition);
		setActive(OWN);
		return true;
	}

	function changeLanguage(tag) {
		runAction((id) => setCampaignLanguage(id, tag));
	}

	const onKeyDown = useEffectEvent((event) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
			event.preventDefault();
			flush();
		}
	});
	const onBeforeUnload = useEffectEvent((event) => {
		if (!isDirty && !isSaving) return;
		flush();
		event.preventDefault();
	});

	useEffect(() => {
		function handleKeyDown(event) {
			onKeyDown(event);
		}
		function handleBeforeUnload(event) {
			onBeforeUnload(event);
		}
		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("beforeunload", handleBeforeUnload);
		};
	}, []);

	function update(key) {
		return (event) => setDrafts((current) => ({ ...current, [active]: { ...current[active], [key]: event.target.value } }));
	}

	const updateBody = useCallback((body) => setDrafts((current) => ({ ...current, [active]: { ...current[active], body } })), [active]);

	const from = newsletter.fromName
		? `${newsletter.fromName} <${newsletter.fromEmail}>`
		: newsletter.fromEmail;

	return (
		<>
			<HeaderPage
				title={drafts[OWN].subject || "Untitled"}
				backHref="/campaigns"
				icon={<AvatarNewsletter newsletter={newsletter} size={28} />}
				meta={<BadgeStatus status={campaign.status} />}
			>
				<StatusSave isSaving={isDirty || isSaving} error={error} onRetry={flush} />
				<Tooltip>
					<TooltipTrigger asChild>
						<span tabIndex={isSendingEnabled || !hasPlan ? -1 : 0} className="rounded-lg">
							<Button variant="outline" onClick={sendTest} disabled={(hasPlan && !isSendingEnabled) || isTesting}>
								{isTesting ? (
									<Loader2 data-icon="inline-start" className="animate-spin" />
								) : (
									<FlaskConical data-icon="inline-start" />
								)}
								Test
							</Button>
						</span>
					</TooltipTrigger>
					<TooltipContent>
						{isSendingEnabled || !hasPlan
							? `Sends the ${getLanguageName(activeLanguage)} email to ${testEmail}`
							: "Sending is off"}
					</TooltipContent>
				</Tooltip>
				<GatePlan reason="schedule">
					<DialogScheduleCampaign
						campaignId={campaign._id}
						scheduledAt={campaign.status === "scheduled" ? campaign.scheduledAt : null}
						audienceLimit={campaign.audienceLimit}
						audienceCount={audienceCount}
						history={sendTimes.history}
						taken={sendTimes.taken}
						isCleanupEnabled={Boolean(newsletter.cleanup?.enabled)}
						warmup={warmup}
						newContacts={newContacts}
						blockingMessage={blockingMessage}
						onBeforeSchedule={persist}
					/>
				</GatePlan>
				<GatePlan reason="send">
					<DialogSendCampaign
						campaignId={campaign._id}
						audienceCount={audienceCount}
						emailsLeft={emailsLeft}
						scheduledAt={campaign.status === "scheduled" ? campaign.scheduledAt : null}
						isCleanupEnabled={Boolean(newsletter.cleanup?.enabled)}
						warmup={warmup}
						newContacts={newContacts}
						blockingMessage={blockingMessage}
						onBeforeSend={persist}
					/>
				</GatePlan>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon" aria-label="More" disabled={isWorking}>
							<MoreHorizontal />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={() => runAction(duplicateCampaign)}>
							<Copy />
							Duplicate
						</DropdownMenuItem>
						<DropdownMenuItem variant="destructive" onSelect={() => setIsDiscardOpen(true)}>
							<Trash2 />
							Discard
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<DialogDiscardCampaign
					id={campaign._id}
					subject={drafts[OWN].subject}
					scheduledAt={campaign.status === "scheduled" ? campaign.scheduledAt : null}
					isOpen={isDiscardOpen}
					onOpenChange={setIsDiscardOpen}
					redirectTo="/campaigns"
				/>
			</HeaderPage>

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
				<div className="overflow-hidden rounded-xl bg-card shadow-border animate-enter">
					<Row label="From">
						<span className="truncate text-sm">{from}</span>
					</Row>
					<Row label="To">
						<span className="flex min-w-0 items-center gap-2 text-sm">
							<AvatarNewsletter newsletter={newsletter} size={18} />
							<span className="truncate">
								{newsletter.name}
								<span className="text-muted-foreground tabular-nums">
									{" "}
									· {formatNumber(audienceCount)}
								</span>
							</span>
							{leftOutCount > 0 && (
								<Tooltip>
									<TooltipTrigger asChild>
										<span
											tabIndex={0}
											className="shrink-0 rounded text-muted-foreground tabular-nums underline decoration-dotted underline-offset-4"
										>
											{formatNumber(leftOutCount)} left out
										</span>
									</TooltipTrigger>
									<TooltipContent>
										Nothing in their language or the newsletter&apos;s:{" "}
										{leftOut.map(({ language: tag, contacts }) => `${getLanguageName(tag)} (${formatNumber(contacts)})`).join(", ")}
									</TooltipContent>
								</Tooltip>
							)}
						</span>
					</Row>
					<Row label="Language">
						<TabsEditions
							tabs={tabs}
							active={active}
							missing={missing}
							ownLanguage={getLanguageTag(campaign)}
							newsletterLanguage={getLanguageTag(newsletter)}
							isPending={isWorking}
							onSelect={setActive}
							onAdd={addEdition}
							onDelete={setDeleting}
							onChangeLanguage={changeLanguage}
						/>
					</Row>
					<Row label="Subject">
						<input
							value={values.subject}
							onChange={update("subject")}
							placeholder="Subject"
							maxLength={200}
							className="h-11 w-full min-w-0 bg-transparent text-sm font-medium outline-none placeholder:font-normal placeholder:text-muted-foreground"
						/>
					</Row>
					<Row label="Preview">
						<input
							value={values.previewText}
							onChange={update("previewText")}
							placeholder="Text shown after the subject"
							maxLength={300}
							className="h-11 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
						/>
					</Row>
					{archiveUrlBase && active === OWN && (
						<Row label="URL">
							<InputCampaignSlug
								campaignId={campaign._id}
								initialSlug={campaign.archiveSlug ?? ""}
								placeholder={slugify(values.subject, 80) || "issue"}
								urlBase={archiveUrlBase}
							/>
						</Row>
					)}
					{isHtml ? (
						<div className="relative">
							<span className="pointer-events-none absolute top-3 right-4 text-xs text-muted-foreground">HTML</span>
							<textarea
								value={values.body}
								onChange={update("body")}
								placeholder="<html>"
								spellCheck={false}
								aria-label="Content"
								className="block min-h-[560px] w-full resize-none bg-transparent px-4 py-4 font-mono text-[13px] leading-6 outline-none [field-sizing:content] placeholder:text-muted-foreground"
							/>
						</div>
					) : (
						<EditorRich key={active} content={values.body} onChange={updateBody} />
					)}
				</div>

				<div
					style={{ "--stagger": 1 }}
					className="flex flex-col gap-4 animate-enter lg:sticky lg:top-[calc(var(--plan-bar-height)+1.5rem)] lg:h-[calc(100dvh-var(--plan-bar-height)-3rem)]"
				>
					<ListChecks checks={checks} />
					<PreviewEmail
						sender={newsletter}
						subject={deferredValues.subject}
						previewText={deferredValues.previewText}
						html={previewHtml}
						className="lg:min-h-0 lg:flex-1"
						toolbar={
							<span className="text-xs text-muted-foreground tabular-nums">
								{Math.ceil(rendered.bytes / 1000)} KB
							</span>
						}
					/>
				</div>
			</div>
			<DialogDeleteEdition
				language={deleting}
				contacts={deleting ? contactsReading(deleting) : 0}
				nextLanguage={deleting ? getNextLanguage(deleting) : null}
				onDelete={deleteEdition}
				onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
			/>
		</>
	);
}

function StatusSave({ isSaving, error, onRetry }) {
	if (error) {
		return (
			<button
				type="button"
				onClick={onRetry}
				title={error}
				className="flex items-center gap-1.5 text-xs text-destructive hover:underline"
			>
				<CircleAlert className="size-3.5" />
				Not saved, retry
			</button>
		);
	}
	return (
		<span aria-live="polite" className="flex min-w-16 items-center justify-end gap-1.5 text-xs text-muted-foreground">
			{isSaving ? (
				"Saving…"
			) : (
				<>
					<Check className="size-3.5" />
					Saved
				</>
			)}
		</span>
	);
}

function Row({ label, children }) {
	return (
		<div className="grid min-h-11 grid-cols-[4.5rem_minmax(0,1fr)] items-center border-b border-border/60 px-4 transition-colors duration-150 focus-within:bg-muted/40">
			<span className="text-sm text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}
