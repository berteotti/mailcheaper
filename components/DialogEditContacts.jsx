"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList, Loader2 } from "lucide-react";
import ButtonCopy from "@/components/ButtonCopy";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { changeContacts, describeContactChange } from "@/lib/contact-changes";
import { formatNumber } from "@/lib/format";
import { LANGUAGE_OPTIONS, getLanguageName } from "@/lib/languages";
import { parseEmailList } from "@/lib/validation";

// Longer than any language code, so it can't be one.
const NEWSLETTER_LANGUAGE = "newsletter";
const CHANGES = {
	unsubscribe: { label: "Unsubscribe", change: { status: "unsubscribed" }, isDestructive: true },
	reactivate: { label: "Reactivate", change: { status: "active" } },
	language: { label: "Change language", button: "Update" },
	delete: { label: "Delete", change: "delete", isDestructive: true },
};

// The newsletter's contacts, named by a pasted list of addresses: one change to all of them, and what became of each.
export default function DialogEditContacts({ newsletter, newsletterLanguage }) {
	const router = useRouter();
	const [isOpen, setIsOpen] = useState(false);
	const [text, setText] = useState("");
	const [kind, setKind] = useState("unsubscribe");
	const [language, setLanguage] = useState(NEWSLETTER_LANGUAGE);
	const [progress, setProgress] = useState(0);
	const [result, setResult] = useState(null);
	const [isPending, startTransition] = useTransition();
	const emails = useMemo(() => parseEmailList(text), [text]);
	const { label, button = label, isDestructive } = CHANGES[kind];

	function changeOpen(open) {
		if (isPending) return;
		setIsOpen(open);
		if (open) return;
		setText("");
		setKind("unsubscribe");
		setLanguage(NEWSLETTER_LANGUAGE);
		setResult(null);
	}

	function apply(event) {
		event.preventDefault();
		const change = CHANGES[kind].change ?? { language: language === NEWSLETTER_LANGUAGE ? null : language };
		setProgress(0);
		startTransition(async () => {
			const totals = await changeContacts(change, { emails, newsletterId: newsletter.id }, setProgress);
			setResult({
				error: totals.error,
				lines: !totals.error || Object.keys(totals).length > 1 ? describeContactChange(change, totals) : [],
				notFound: totals.notFound ?? [],
			});
			router.refresh();
		});
	}

	return (
		<Dialog open={isOpen} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" disabled={!newsletter}>
					<ClipboardList data-icon="inline-start" />
					Edit by email
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Edit contacts by email</DialogTitle>
					<DialogDescription>
						Paste addresses, separated by commas, spaces or new lines. Only{" "}
						<span className="font-medium text-foreground">{newsletter?.name}</span>&apos;s contacts change.
					</DialogDescription>
				</DialogHeader>

				{result ? (
					<div className="flex flex-col gap-3">
						{result.error && <p className="text-sm text-destructive">{result.error}</p>}
						{result.lines.length > 0 && (
							<ul className="flex flex-col gap-1 text-sm">
								{result.lines.map((line, index) => (
									<li key={line} className={index === 0 ? "font-medium" : "text-muted-foreground"}>
										{line}
									</li>
								))}
							</ul>
						)}
						{result.notFound.length > 0 && (
							<div className="flex flex-col gap-1.5">
								<div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
									Not contacts of {newsletter?.name}
									<ButtonCopy value={result.notFound.join("\n")} label="Copy addresses" />
								</div>
								<ul className="max-h-40 divide-y overflow-y-auto rounded-xl text-sm shadow-border">
									{result.notFound.map((email) => (
										<li key={email} className="truncate px-3 py-1.5">
											{email}
										</li>
									))}
								</ul>
							</div>
						)}
					</div>
				) : (
					<form id="edit-contacts" onSubmit={apply} className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<Textarea
								value={text}
								onChange={(event) => setText(event.target.value)}
								placeholder="jane@example.com, sam@example.com"
								aria-label="Email addresses"
								className="max-h-48 min-h-28"
								disabled={isPending}
								autoFocus
							/>
							<p className="text-xs text-muted-foreground tabular-nums">
								{isPending
									? `${formatNumber(progress)} of ${formatNumber(emails.length)} done`
									: `${formatNumber(emails.length)} ${emails.length === 1 ? "address" : "addresses"}`}
							</p>
						</div>
						<div className="flex flex-col gap-2 sm:flex-row">
							<Select value={kind} onValueChange={setKind} disabled={isPending}>
								<SelectTrigger className="w-full" aria-label="Change">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Object.entries(CHANGES).map(([key, { label }]) => (
										<SelectItem key={key} value={key}>
											{label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{kind === "language" && (
								<Select value={language} onValueChange={setLanguage} disabled={isPending}>
									<SelectTrigger className="w-full" aria-label="Language">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={NEWSLETTER_LANGUAGE}>
											Newsletter&apos;s ({getLanguageName(newsletterLanguage)})
										</SelectItem>
										<SelectSeparator />
										{LANGUAGE_OPTIONS.map(([code, name]) => (
											<SelectItem key={code} value={code}>
												{name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</div>
					</form>
				)}

				<DialogFooter>
					{result ? (
						<Button onClick={() => changeOpen(false)} className="min-w-24">
							Done
						</Button>
					) : (
						<>
							<Button variant="outline" onClick={() => changeOpen(false)} disabled={isPending}>
								Cancel
							</Button>
							<Button
								type="submit"
								form="edit-contacts"
								variant={isDestructive ? "destructive" : "default"}
								disabled={emails.length === 0 || isPending}
								className="min-w-24"
							>
								{isPending ? <Loader2 className="animate-spin" /> : `${button} ${formatNumber(emails.length)}`}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
