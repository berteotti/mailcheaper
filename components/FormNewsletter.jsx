"use client";

import { useActionState, useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";
import { ExternalLink, FlaskConical, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { saveNewsletter, sendWelcomeTest } from "@/app/(app)/newsletters/actions";
import InputImage from "@/components/InputImage";
import PreviewEmail from "@/components/PreviewEmail";
import StatusSaved from "@/components/StatusSaved";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CLEANUP_LIMITS, LAST_CHANCE_DAYS, getCleanupSettings } from "@/lib/cleanup";
import { CONFIRM_URL_PLACEHOLDER, getConfirmationContent } from "@/lib/confirmation-content";
import { formatNumber } from "@/lib/format";
import { DEFAULT_LANGUAGE, LANGUAGE_OPTIONS, getLanguageTag } from "@/lib/languages";
import { KEEP_URL_PLACEHOLDER, getLastChanceContent } from "@/lib/last-chance-content";
import { MAX_AUTHOR_BIO_LENGTH, MAX_DESCRIPTION_LENGTH } from "@/lib/newsletters";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail } from "@/lib/render-email";
import { getSharedAddress, isOnSharedDomain } from "@/lib/sender-rules";
import { slugify } from "@/lib/slug";
import { usePaywall } from "@/lib/use-paywall";
import { cn } from "@/lib/utils";
import { prefillWelcome } from "@/lib/welcome-content";

const IMAGE_PREVIEW_PATTERN = /^(https:\/\/\S+\.\S{2,}\/\S+|\/\S+\.\w{3,4})$/;

// footer: what goes after the sections, above the save bar.
export default function FormNewsletter({ newsletter, domains, sharedDomain, isSendingEnabled, testEmail, cleanupTotals, footer }) {
	const paywall = usePaywall();
	const hasPlan = paywall?.hasPlan ?? true;
	const archiveHost = domains.find(({ archiveHostVerified }) => archiveHostVerified)?.archiveHost;
	const [state, action, isPending] = useActionState(saveNewsletter, null);
	const [isTesting, startTesting] = useTransition();
	const [name, setName] = useState(newsletter?.name ?? "");
	const [description, setDescription] = useState(newsletter?.description ?? "");
	const [slug, setSlug] = useState(newsletter?.slug ?? "");
	const [isSlugEdited, setIsSlugEdited] = useState(Boolean(newsletter));
	const [fromName, setFromName] = useState(newsletter?.fromName ?? "");
	const [fromLocal, setFromLocal] = useState(() => getInitialFrom({ newsletter, domains, sharedDomain }).local);
	const [fromDomain, setFromDomain] = useState(() => getInitialFrom({ newsletter, domains, sharedDomain }).domain);
	const [imageUrl, setImageUrl] = useState(newsletter?.imageUrl ?? "");
	const [isConfirmationRequired, setIsConfirmationRequired] = useState(newsletter ? Boolean(newsletter.requireConfirmation) : true);
	const [confirmationEdits, setConfirmationEdits] = useState(null);
	const [isWelcomeEnabled, setIsWelcomeEnabled] = useState(Boolean(newsletter?.welcome?.enabled));
	const [welcome, setWelcome] = useState({
		subject: newsletter?.welcome?.subject ?? "",
		previewText: newsletter?.welcome?.previewText ?? "",
		markdown: newsletter?.welcome?.markdown ?? "",
	});
	const [isArchiveEnabled, setIsArchiveEnabled] = useState(Boolean(newsletter?.archiveEnabled));
	const savedCleanup = getCleanupSettings(newsletter);
	const [isCleanupEnabled, setIsCleanupEnabled] = useState(newsletter ? savedCleanup.enabled : true);
	const [cleanup, setCleanup] = useState({ issues: String(savedCleanup.issues), days: String(savedCleanup.days) });
	const deferredWelcome = useDeferredValue(welcome);
	const archiveAddress = archiveHost ?? (sharedDomain ? `${slug || "slug"}.${sharedDomain}` : `/archive/${slug || "slug"}`);
	const sharedAddress = sharedDomain ? getSharedAddress(slug || "slug", sharedDomain) : null;
	const fromEmail = fromDomain === sharedDomain ? sharedAddress : fromDomain ? `${fromLocal}@${fromDomain}` : "";

	useEffect(() => {
		if (state?.error) toast.error(state.error);
	}, [state]);

	const welcomeHtml = useMemo(
		() =>
			renderEmail({
				markdown: deferredWelcome.markdown,
				subject: deferredWelcome.subject,
				previewText: deferredWelcome.previewText,
				newsletter: { name, postalAddress: newsletter?.postalAddress },
			}).html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#"),
		[deferredWelcome, name, newsletter?.postalAddress]
	);

	// Until it's edited, the built-in email follows the name and the description.
	const confirmation = useMemo(
		() => confirmationEdits ?? getConfirmationContent({ name, description, confirmation: newsletter?.confirmation }),
		[confirmationEdits, name, description, newsletter?.confirmation]
	);
	const deferredConfirmation = useDeferredValue(confirmation);
	const confirmationHtml = useMemo(
		() =>
			renderEmail({ ...deferredConfirmation, newsletter: { name, postalAddress: newsletter?.postalAddress } })
				.html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#")
				.replaceAll(CONFIRM_URL_PLACEHOLDER, "#"),
		[deferredConfirmation, name, newsletter?.postalAddress]
	);

	const lastChance = useMemo(() => {
		const content = getLastChanceContent({ name, fromEmail });
		const { html } = renderEmail({ ...content, newsletter: { name, postalAddress: newsletter?.postalAddress } });
		return {
			...content,
			html: html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#").replaceAll(KEEP_URL_PLACEHOLDER, "#"),
		};
	}, [name, fromEmail, newsletter?.postalAddress]);

	const previewImageUrl = IMAGE_PREVIEW_PATTERN.test(imageUrl) ? imageUrl : "";
	const isShared = Boolean(sharedDomain) && fromDomain === sharedDomain;
	const isDomainUnverified = !isShared && domains.some(({ domain, verified }) => domain === fromDomain && !verified);
	const fromHint = getFromHint({ isShared, isDomainUnverified, fromDomain, hasDomains: domains.length > 0 });

	function updateConfirmation(key) {
		return (event) => {
			const { value } = event.target;
			setConfirmationEdits((current) => ({ ...(current ?? confirmation), [key]: value }));
		};
	}

	function updateWelcome(key) {
		return (event) => {
			const { value } = event.target;
			setWelcome((current) => ({ ...current, [key]: value }));
		};
	}

	function switchWelcome(isEnabled) {
		setIsWelcomeEnabled(isEnabled);
		if (isEnabled) setWelcome((current) => prefillWelcome(current, { name, description }));
	}

	function updateCleanup(key) {
		return (event) => {
			const { value } = event.target;
			setCleanup((current) => ({ ...current, [key]: value }));
		};
	}

	function sendTest() {
		if (!hasPlan) return paywall.open("test");
		startTesting(async () => {
			const result = await sendWelcomeTest(newsletter._id);
			if (result?.error) toast.error(result.error);
			else toast.success(`Test sent to ${testEmail}`);
		});
	}

	return (
		<form action={action} className="flex flex-col gap-4">
			{newsletter && <input type="hidden" name="id" value={newsletter._id} />}

			<Section title="General" stagger={0}>
				<Field label="Name">
					<Input
						name="name"
						value={name}
						required
						placeholder="Field notes"
						onChange={(event) => {
							setName(event.target.value);
							if (!isSlugEdited) setSlug(slugify(event.target.value));
						}}
					/>
				</Field>
				<Field label="Slug">
					<Input
						name="slug"
						value={slug}
						required
						placeholder="field-notes"
						className="font-mono"
						onChange={(event) => {
							setSlug(event.target.value);
							setIsSlugEdited(true);
						}}
					/>
				</Field>
				<Field label="Language" hint="What it's written in. Contacts without a language of their own are in this one.">
					<Select name="language" defaultValue={getLanguageTag(newsletter) ?? DEFAULT_LANGUAGE}>
						<SelectTrigger className="h-9 w-full sm:w-56" aria-label="Language">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{LANGUAGE_OPTIONS.map(([code, name]) => (
								<SelectItem key={code} value={code}>
									{name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field label="Image" hint="Square logo, 128×128 or larger">
					<InputImage name="imageUrl" defaultValue={newsletter?.imageUrl} label="newsletter image" onChange={setImageUrl} />
				</Field>
			</Section>

			<Section title="Sender" stagger={1}>
				<Field label="From name">
					<Input
						name="fromName"
						value={fromName}
						placeholder="Jane Doe"
						onChange={(event) => setFromName(event.target.value)}
					/>
				</Field>
				<Field label="From email" hint={fromHint} isWarning={isDomainUnverified}>
					<span className="flex flex-wrap items-center gap-2">
						<span className="flex items-center gap-2">
							<Input
								value={isShared ? sharedAddress.split("@")[0] : fromLocal}
								readOnly={isShared}
								required
								aria-label="From email name"
								placeholder="hi"
								className={cn("w-32 font-mono", isShared && "text-muted-foreground")}
								onChange={(event) => setFromLocal(event.target.value.trim())}
							/>
							<span className="text-sm text-muted-foreground">@</span>
						</span>
						{/* The shared domain has the slug in it, so it can be wider than the column. */}
						<Select value={fromDomain} onValueChange={setFromDomain}>
							<SelectTrigger
								className="min-h-9 min-w-0 flex-auto py-1.5 text-left font-mono whitespace-normal wrap-anywhere data-[size=default]:h-auto *:data-[slot=select-value]:line-clamp-none"
								aria-label="From domain"
							>
								<SelectValue placeholder="Add a domain first" />
							</SelectTrigger>
							<SelectContent className="max-w-[calc(100vw-20px)] wrap-anywhere">
								{sharedDomain && <SelectItem value={sharedDomain}>{sharedAddress.split("@")[1]}</SelectItem>}
								{domains.map(({ domain }) => (
									<SelectItem key={domain} value={domain}>
										{domain}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</span>
					<input type="hidden" name="fromEmail" value={fromEmail} />
				</Field>
				<Field label="Reply-to">
					<Input name="replyTo" type="email" defaultValue={newsletter?.replyTo} placeholder="Optional" />
				</Field>
				<Field label="Postal address" hint="Shown in the footer of every email. Anti-spam laws require one.">
					<Textarea
						name="postalAddress"
						defaultValue={newsletter?.postalAddress}
						rows={2}
						placeholder="Company name, street, city, country"
					/>
				</Field>
			</Section>

			<Section
				title="Confirm new signups"
				stagger={2}
				action={
					<Switch
						name="requireConfirmation"
						checked={isConfirmationRequired}
						onCheckedChange={setIsConfirmationRequired}
						aria-label="Confirm new signups"
					/>
				}
			>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					New subscribers get this email and only join once they click its button, so fake and mistyped
					addresses never reach the list. It&apos;s the only email they get: say what comes next.
				</p>
				{isConfirmationRequired && (
					<>
						<Field label="Subject">
							<Input
								name="confirmationSubject"
								value={confirmation.subject}
								required
								onChange={updateConfirmation("subject")}
							/>
						</Field>
						<Field label="Preview text">
							<Input
								name="confirmationPreviewText"
								value={confirmation.previewText}
								placeholder="Optional"
								onChange={updateConfirmation("previewText")}
							/>
						</Field>
						<Field
							label="Content"
							hint={`Markdown. Keep the button: its ${CONFIRM_URL_PLACEHOLDER} becomes each subscriber's link.`}
						>
							<Textarea
								name="confirmationMarkdown"
								value={confirmation.markdown}
								onChange={updateConfirmation("markdown")}
								className="min-h-48 font-mono text-[13px] leading-6"
							/>
						</Field>
						<div className="p-3">
							<PreviewEmail
								html={confirmationHtml}
								sender={{ name, fromName, fromEmail, imageUrl: previewImageUrl }}
								subject={deferredConfirmation.subject}
								previewText={deferredConfirmation.previewText}
								fit="content"
							/>
						</div>
					</>
				)}
			</Section>

			<Section
				title="Welcome email"
				stagger={3}
				collapsedNote={
					isConfirmationRequired &&
					"Not sent while new signups confirm, since the confirmation email replaces it. Its content is kept."
				}
				action={
					<Switch
						name="welcomeEnabled"
						checked={isWelcomeEnabled}
						onCheckedChange={switchWelcome}
						aria-label="Welcome email"
					/>
				}
			>
				<Field label="Subject">
					<Input name="welcomeSubject" value={welcome.subject} onChange={updateWelcome("subject")} />
				</Field>
				<Field label="Preview text">
					<Input
						name="welcomePreviewText"
						value={welcome.previewText}
						placeholder="Optional"
						onChange={updateWelcome("previewText")}
					/>
				</Field>
				<Field label="Content" hint={`Markdown. {{first_name|there}} becomes each subscriber's first name, or "there" without one. {{first_name}} alone leaves nothing.`}>
					<Textarea
						name="welcomeMarkdown"
						value={welcome.markdown}
						onChange={updateWelcome("markdown")}
						className="min-h-48 font-mono text-[13px] leading-6"
					/>
				</Field>
				{deferredWelcome.markdown.trim() && (
					<div className="p-3">
						<PreviewEmail
							html={welcomeHtml}
							sender={{ name, fromName, fromEmail, imageUrl: previewImageUrl }}
							subject={deferredWelcome.subject}
							previewText={deferredWelcome.previewText}
							fit="content"
						/>
					</div>
				)}
				{newsletter && (
					<div className="flex items-center justify-between gap-3 px-4 py-3">
						<p className="text-xs wrap-anywhere text-muted-foreground">
							{isSendingEnabled || !hasPlan ? `Sends the saved version to ${testEmail}` : "Sending is off"}
						</p>
						<Button type="button" variant="outline" size="sm" onClick={sendTest} disabled={(hasPlan && !isSendingEnabled) || isTesting}>
							{isTesting ? <Loader2 className="animate-spin" /> : <FlaskConical />}
							Send test
						</Button>
					</div>
				)}
			</Section>

			<Section
				title="List cleanup"
				stagger={4}
				action={
					<Switch
						name="cleanupEnabled"
						checked={isCleanupEnabled}
						onCheckedChange={setIsCleanupEnabled}
						aria-label="List cleanup"
					/>
				}
			>
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					Stops sending to contacts who stopped opening, unless they answer a last-chance email. Each time you send an
					issue, contacts who ignored the last {cleanup.issues || savedCleanup.issues} issues and showed no sign of life
					for {cleanup.days || savedCleanup.days} days get this email instead. A click
					on its button keeps them. Anyone who doesn&apos;t answer by a send{" "}
					{LAST_CHANCE_DAYS} days later becomes dormant: not unsubscribed, not deleted, and back if they sign up again.
				</p>
				<Field label="Ignored issues" hint="In a row, counting from the first issue MailCheap sent">
					<Input
						name="cleanupIssues"
						type="number"
						inputMode="numeric"
						min={CLEANUP_LIMITS.minIssues}
						max={CLEANUP_LIMITS.maxIssues}
						value={cleanup.issues}
						onChange={updateCleanup("issues")}
						className="w-28 tabular-nums"
					/>
				</Field>
				<Field label="Quiet for" hint="Days since the last open, click or signup">
					<span className="flex items-center gap-2">
						<Input
							name="cleanupDays"
							type="number"
							inputMode="numeric"
							min={CLEANUP_LIMITS.minDays}
							max={CLEANUP_LIMITS.maxDays}
							value={cleanup.days}
							onChange={updateCleanup("days")}
							className="w-28 tabular-nums"
						/>
						<span className="text-sm text-muted-foreground">days</span>
					</span>
				</Field>
				{cleanupTotals && <CleanupTotals totals={cleanupTotals} />}
				{isCleanupEnabled && (
					<div className="p-3">
						<PreviewEmail
							html={lastChance.html}
							sender={{ name, fromName, fromEmail, imageUrl: previewImageUrl }}
							subject={lastChance.subject}
							previewText={lastChance.previewText}
							fit="content"
						/>
					</div>
				)}
			</Section>

			<Section
				title="Public archive"
				stagger={5}
				action={
					<div className="flex items-center gap-3">
						{newsletter?.archiveEnabled && (
							<a
								href={`/archive/${newsletter.slug}`}
								target="_blank"
								rel="noreferrer"
								className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
							>
								View
								<ExternalLink className="size-3" />
							</a>
						)}
						<Switch
							name="archiveEnabled"
							checked={isArchiveEnabled}
							onCheckedChange={setIsArchiveEnabled}
							aria-label="Public archive"
						/>
					</div>
				}
			>
				<p className="px-4 py-3 text-sm text-pretty wrap-anywhere text-muted-foreground">
					Sent issues get a page with a signup form, at {archiveAddress}.
					{!archiveHost && " Add a domain on the Domains page to serve it on your own subdomain."}
				</p>
				<Field label="Description" hint="One sentence under the name and in the subscribe popup">
					<Textarea
						name="description"
						value={description}
						rows={2}
						maxLength={MAX_DESCRIPTION_LENGTH}
						placeholder="One idea about building things, every Sunday."
						onChange={(event) => setDescription(event.target.value)}
					/>
				</Field>
				<Field label="Author bio" hint="Under your name on the author page">
					<Input
						name="authorBio"
						defaultValue={newsletter?.author?.bio}
						maxLength={MAX_AUTHOR_BIO_LENGTH}
						placeholder="I write about building small software companies."
					/>
				</Field>
				<Field label="Author photo" hint="Square photo on the author page. The newsletter image otherwise.">
					<InputImage name="authorImageUrl" defaultValue={newsletter?.author?.imageUrl} label="author photo" />
				</Field>
				<Field label="Social links" hint="One link per line">
					<Textarea
						name="socialLinks"
						defaultValue={newsletter?.socialLinks?.join("\n")}
						rows={3}
						placeholder={"https://x.com/example\nhttps://youtube.com/@example"}
						className="font-mono text-[13px] leading-6"
					/>
				</Field>
			</Section>

			{footer}

			<div
				data-save-bar
				className="sticky bottom-0 -mx-4 mt-2 -mb-6 flex h-(--save-bar-height) items-center justify-end gap-3 bg-background/80 px-4 backdrop-blur-md md:-mx-10 md:-mb-10 md:px-10"
			>
				<StatusSaved savedAt={isPending ? null : state?.savedAt} />
				<Button type="submit" disabled={isPending} className="min-w-20">
					{isPending ? <Loader2 className="animate-spin" /> : newsletter ? "Save" : "Create"}
				</Button>
			</div>
		</form>
	);
}

// With a collapsedNote, the note stands in for the action and the fields, which aren't sent with the form.
function Section({ title, action, stagger, collapsedNote, children }) {
	return (
		<section style={{ "--stagger": stagger }} className="rounded-xl bg-card shadow-border animate-enter">
			<div className="flex h-12 items-center justify-between gap-3 px-4">
				<h2 className="text-sm font-medium">{title}</h2>
				{!collapsedNote && action}
			</div>
			{collapsedNote ? (
				<p className="border-t border-border/60 px-4 py-3 text-sm text-pretty text-muted-foreground">
					{collapsedNote}
				</p>
			) : (
				children && <div className="divide-y divide-border/60 border-t border-border/60">{children}</div>
			)}
		</section>
	);
}

function CleanupTotals({ totals }) {
	const stats = [
		{ label: "Waiting for an answer", value: totals.waiting },
		{ label: "Kept after the email", value: totals.kept },
		{ label: "Made dormant", value: totals.dormant },
	];
	return (
		<dl className="grid grid-cols-3 divide-x divide-border/60">
			{stats.map(({ label, value }) => (
				<div key={label} className="flex flex-col gap-1 px-4 py-3">
					<dt className="text-xs text-pretty text-muted-foreground">{label}</dt>
					<dd className="text-lg font-semibold tabular-nums">{formatNumber(value)}</dd>
				</div>
			))}
		</dl>
	);
}

// The saved address if it's on a domain the account can use, else the shared address, else the first domain.
// The shared domain stands for the shared address, whose subdomain follows the slug.
function getInitialFrom({ newsletter, domains, sharedDomain }) {
	const [local = "", domain = ""] = String(newsletter?.fromEmail ?? "").split("@");
	if (isOnSharedDomain(newsletter?.fromEmail, sharedDomain)) return { local: "hi", domain: sharedDomain };
	if (domain && domains.some((item) => item.domain === domain)) return { local, domain };
	return { local: local || "hi", domain: sharedDomain ?? domains[0]?.domain ?? "" };
}

function getFromHint({ isShared, isDomainUnverified, fromDomain, hasDomains }) {
	if (isShared) return "The shared address follows the slug and needs no setup. Replies go to the reply-to, or to your account email.";
	if (isDomainUnverified) return `${fromDomain} isn't verified yet. Emails wait until its DNS records are in.`;
	if (!fromDomain && !hasDomains) return "Add a domain on the Domains page to send from it";
	return null;
}

function Field({ label, hint, isWarning, children }) {
	return (
		<label className="grid gap-2 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
			<span className="text-sm text-muted-foreground sm:pt-2">{label}</span>
			<span className="flex min-w-0 flex-col gap-1.5">
				{children}
				{hint && (
					<span
						className={cn(
							"text-xs",
							isWarning ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
						)}
					>
						{hint}
					</span>
				)}
			</span>
		</label>
	);
}
