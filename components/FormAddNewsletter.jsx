"use client";

import { useActionState, useId, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { createNewsletter } from "@/app/(app)/newsletters/actions";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MAX_DESCRIPTION_LENGTH, NEWSLETTER_LIMIT_MESSAGE } from "@/lib/newsletters";
import { getSharedAddress } from "@/lib/sender-rules";
import { slugify } from "@/lib/slug";

// A name and a line about it, like /welcome; the rest is in its settings, which open next. Without a shared
// domain, a newsletter needs an address on one of the account's domains from the start. Only a link opens the
// dialog at the limit, and then it says so.
export default function FormAddNewsletter({ sharedDomain, domains, startsFrom, isAtLimit }) {
	const id = useId();
	const [state, action, isPending] = useActionState(createNewsletter, null);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [localPart, setLocalPart] = useState("hi");
	const [domain, setDomain] = useState(domains[0] ?? "");
	const canCreate = Boolean(sharedDomain || domain);

	if (isAtLimit) {
		return (
			<>
				<DialogHeader>
					<DialogTitle>{NEWSLETTER_LIMIT_MESSAGE}</DialogTitle>
					<DialogDescription className="text-pretty">They share your plan&apos;s emails and subscribers.</DialogDescription>
				</DialogHeader>
				<DialogFooter showCloseButton />
			</>
		);
	}

	return (
		<form action={action} className="flex flex-col gap-5">
			<DialogHeader>
				<DialogTitle>Add a newsletter</DialogTitle>
				<DialogDescription className="text-pretty">
					{startsFrom && `It takes the sender name and postal address of ${startsFrom}. `}Its settings open next.
				</DialogDescription>
			</DialogHeader>
			<div className="flex flex-col gap-2">
				<label htmlFor={`${id}-name`} className="text-sm font-medium">
					Name
				</label>
				<Input
					id={`${id}-name`}
					name="name"
					value={name}
					required
					maxLength={100}
					placeholder="Field notes"
					autoComplete="off"
					autoFocus
					className="h-10"
					onChange={(event) => setName(event.target.value)}
				/>
				{sharedDomain && (
					<p className="text-sm text-muted-foreground wrap-anywhere">
						It sends from{" "}
						<span className="font-mono text-[13px] text-foreground">
							{getSharedAddress(slugify(name) || "your-newsletter", sharedDomain)}
						</span>
					</p>
				)}
			</div>
			<div className="flex flex-col gap-2">
				<div className="flex items-baseline justify-between gap-3">
					<label htmlFor={`${id}-description`} className="text-sm font-medium">
						What it&apos;s about
					</label>
					<span className="text-xs text-muted-foreground tabular-nums">
						{description.length}/{MAX_DESCRIPTION_LENGTH}
					</span>
				</div>
				<Input
					id={`${id}-description`}
					name="description"
					value={description}
					maxLength={MAX_DESCRIPTION_LENGTH}
					placeholder="One idea about building things, every Sunday."
					autoComplete="off"
					className="h-10"
					onChange={(event) => setDescription(event.target.value)}
				/>
			</div>
			{!sharedDomain && (
				<div className="flex flex-col gap-2">
					<label htmlFor={`${id}-from`} className="text-sm font-medium">
						From email
					</label>
					<span className="flex flex-wrap items-center gap-2">
						<span className="flex items-center gap-2">
							<Input
								id={`${id}-from`}
								value={localPart}
								required
								placeholder="hi"
								autoComplete="off"
								autoCapitalize="none"
								spellCheck={false}
								className="h-10 w-32 font-mono"
								onChange={(event) => setLocalPart(event.target.value.split("@")[0].trim())}
							/>
							<span className="text-sm text-muted-foreground">@</span>
						</span>
						<Select value={domain} onValueChange={setDomain} disabled={domains.length === 0}>
							<SelectTrigger className="h-10 min-w-0 flex-auto font-mono data-[size=default]:h-10" aria-label="From domain">
								<SelectValue placeholder="Add a domain first" />
							</SelectTrigger>
							<SelectContent>
								{domains.map((item) => (
									<SelectItem key={item} value={item}>
										{item}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</span>
					{domains.length === 0 && (
						<p className="text-sm text-muted-foreground">
							Add one on the{" "}
							{/* The dialog belongs to the layout, so it would stay open over the Domains page. */}
							<DialogClose asChild>
								<Link href="/domains" className="font-medium text-foreground underline underline-offset-4">
									Domains page
								</Link>
							</DialogClose>{" "}
							to send from it.
						</p>
					)}
					<input type="hidden" name="fromEmail" value={domain ? `${localPart}@${domain}` : ""} />
				</div>
			)}
			{state?.error && (
				<p role="alert" className="text-sm text-pretty text-destructive">
					{state.error}
				</p>
			)}
			<DialogFooter>
				<Button type="submit" disabled={isPending || !canCreate} className="h-10 sm:min-w-36">
					{isPending ? <Loader2 className="animate-spin" /> : "Create newsletter"}
				</Button>
			</DialogFooter>
		</form>
	);
}
