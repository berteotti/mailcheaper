"use client";

import { useActionState, useId, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { addDomainAction } from "@/app/(app)/domains/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeDomainInput, normalizeHostInput } from "@/lib/sender-rules";

const PLACEHOLDER_DOMAIN = "yourdomain.com";

export default function FormAddDomain({ fromLocalPart }) {
	const id = useId();
	const [domainInput, setDomainInput] = useState("");
	const [archiveInput, setArchiveInput] = useState("");
	const [, action, isPending] = useActionState(async (previous, formData) => {
		const result = await addDomainAction(previous, formData);
		if (result?.error) toast.error(result.error);
		else {
			toast.success(`${result.domain} added. Add its DNS records next.`);
			setDomainInput("");
			setArchiveInput("");
		}
		return result;
	}, null);
	const domain = normalizeDomainInput(domainInput);
	const archiveLabel = toArchiveLabel(archiveInput, domain);

	// Only an address or a link is rewritten: a plain domain keeps the browser's own paste, and its undo.
	function pasteDomain(event) {
		const text = event.clipboardData.getData("text");
		const pasted = normalizeDomainInput(text);
		if (!pasted || pasted === text.trim()) return;
		event.preventDefault();
		setDomainInput(pasted);
	}

	return (
		<form action={action} className="overflow-hidden rounded-xl bg-card shadow-border animate-enter">
			<div className="flex flex-col gap-4 p-4 sm:p-5">
				<div>
					<h2 className="font-semibold tracking-tight">Add your domain</h2>
					<p className="mt-1 text-sm text-muted-foreground">Send from an address at your domain, with your archive and links on it.</p>
				</div>
				<div className="flex flex-col gap-2">
					<label htmlFor={`${id}-domain`} className="text-sm font-medium">
						Domain
					</label>
					<div className="flex flex-col gap-2 sm:flex-row">
						<Input
							id={`${id}-domain`}
							name="domain"
							value={domainInput}
							required
							placeholder={PLACEHOLDER_DOMAIN}
							inputMode="url"
							autoComplete="off"
							autoCapitalize="none"
							spellCheck={false}
							className="h-10 font-mono sm:flex-1"
							onChange={(event) => setDomainInput(event.target.value)}
							onPaste={pasteDomain}
							onBlur={() => setDomainInput(domain)}
						/>
						<Button type="submit" disabled={isPending} className="h-10 sm:min-w-32">
							{isPending ? <Loader2 className="animate-spin" /> : <Plus data-icon="inline-start" />}
							Add domain
						</Button>
					</div>
				</div>
			</div>
			<div className="flex flex-col gap-3 border-t border-border/60 bg-muted/40 px-4 py-3.5 text-sm sm:px-5">
				<RowPreview label="Sends from">
					<span className="min-w-0 truncate font-mono text-base sm:text-[13px]">
						{fromLocalPart}@<TextDomain domain={domain} />
					</span>
				</RowPreview>
				<RowPreview label="Archive and links" htmlFor={`${id}-archive`}>
					<label className="flex h-9 max-w-full min-w-0 cursor-text items-center rounded-lg border border-input bg-background px-2.5 font-mono text-base transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 sm:h-8 sm:text-[13px] dark:bg-input/30">
						<input
							id={`${id}-archive`}
							aria-label="Archive and links"
							value={archiveInput}
							style={{ width: `${Math.max(archiveInput.length, 4)}ch` }}
							placeholder="news"
							autoComplete="off"
							autoCapitalize="none"
							spellCheck={false}
							className="max-w-40 min-w-0 bg-transparent outline-none placeholder:text-muted-foreground"
							onChange={(event) => setArchiveInput(event.target.value)}
							onBlur={() => setArchiveInput(archiveLabel)}
						/>
						<span className="truncate text-muted-foreground">.{domain || PLACEHOLDER_DOMAIN}</span>
					</label>
				</RowPreview>
			</div>
			<input type="hidden" name="archiveHost" value={archiveLabel && domain ? `${archiveLabel}.${domain}` : ""} />
		</form>
	);
}

function RowPreview({ label, htmlFor, children }) {
	const Label = htmlFor ? "label" : "span";
	return (
		<div className="grid gap-1.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-4">
			<Label htmlFor={htmlFor} className="text-muted-foreground">
				{label}
			</Label>
			<div className="flex min-w-0">{children}</div>
		</div>
	);
}

function TextDomain({ domain }) {
	return domain || <span className="text-muted-foreground">{PLACEHOLDER_DOMAIN}</span>;
}

// What's typed before the domain: news, or news.yourdomain.com pasted whole.
function toArchiveLabel(value, domain) {
	const host = normalizeHostInput(value);
	return domain && host.endsWith(`.${domain}`) ? host.slice(0, -domain.length - 1) : host;
}
