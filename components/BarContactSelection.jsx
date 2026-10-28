"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Languages, Loader2, Trash2, UserCheck, UserX, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { changeContacts, describeContactChange } from "@/lib/contact-changes";
import { formatCount, formatNumber } from "@/lib/format";
import { LANGUAGE_OPTIONS, getLanguageName } from "@/lib/languages";
import { useContactSelection } from "@/lib/use-contact-selection";

// The changes that can't be undone ask first.
const CONFIRMATIONS = {
	delete: {
		title: "Delete",
		description:
			"They go for good, with the emails sent to them. Unsubscribed, bounced and complained contacts stay, as the record that keeps the address out.",
		change: "delete",
	},
	unsubscribe: {
		title: "Unsubscribe",
		description: "They stop getting emails for good: only signing up again brings them back.",
		change: { status: "unsubscribed" },
	},
};

// What to do with the contacts ticked in the list, while there are any.
export default function BarContactSelection({ newsletterLanguage }) {
	const router = useRouter();
	const { selected, clear } = useContactSelection();
	// { kind, count, isOpen }: the count it asked about stays while the dialog closes.
	const [confirming, setConfirming] = useState(null);
	const [isPending, startTransition] = useTransition();
	const confirmation = confirming && CONFIRMATIONS[confirming.kind];

	function apply(change) {
		startTransition(async () => {
			const totals = await changeContacts(change, { ids: [...selected] });
			if (totals.error) toast.error(totals.error);
			if (!totals.error || Object.keys(totals).length > 1) {
				const [done, ...rest] = describeContactChange(change, totals);
				toast.success(done);
				for (const line of rest) toast(line);
			}
			setConfirming((current) => current && { ...current, isOpen: false });
			clear();
			router.refresh();
		});
	}

	function confirm(kind) {
		setConfirming({ kind, count: selected.size, isOpen: true });
	}

	return (
		<>
			{selected.size > 0 && (
				<div className="pointer-events-none fixed inset-x-4 bottom-4 z-40 flex justify-center sm:bottom-6 md:left-64">
					<div
						role="toolbar"
						aria-label="Selected contacts"
						className="pointer-events-auto flex items-center gap-1 rounded-xl bg-card p-1.5 pl-3.5 shadow-float animate-enter"
					>
						<span className="mr-1.5 flex items-center gap-1.5 text-sm font-medium whitespace-nowrap tabular-nums">
							{isPending && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
							{formatNumber(selected.size)} selected
						</span>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="sm" disabled={isPending}>
									Edit
									<ChevronDown data-icon="inline-end" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="center" side="top">
								<DropdownMenuSub>
									<DropdownMenuSubTrigger>
										<Languages />
										Language
									</DropdownMenuSubTrigger>
									<DropdownMenuSubContent className="max-h-80 overflow-y-auto">
										<DropdownMenuItem onSelect={() => apply({ language: null })}>
											Newsletter&apos;s ({getLanguageName(newsletterLanguage)})
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										{LANGUAGE_OPTIONS.map(([code, name]) => (
											<DropdownMenuItem key={code} onSelect={() => apply({ language: code })}>
												{name}
											</DropdownMenuItem>
										))}
									</DropdownMenuSubContent>
								</DropdownMenuSub>
								<DropdownMenuSeparator />
								<DropdownMenuItem onSelect={() => apply({ status: "active" })}>
									<UserCheck />
									Reactivate
								</DropdownMenuItem>
								<DropdownMenuItem variant="destructive" onSelect={() => confirm("unsubscribe")}>
									<UserX />
									Unsubscribe
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						<Button variant="ghost" size="sm" onClick={() => confirm("delete")} disabled={isPending}>
							<Trash2 data-icon="inline-start" />
							Delete
						</Button>
						<Button variant="ghost" size="icon-sm" onClick={clear} disabled={isPending} aria-label="Clear selection">
							<X />
						</Button>
					</div>
				</div>
			)}
			<Dialog
				open={Boolean(confirming?.isOpen)}
				onOpenChange={(open) => !open && !isPending && setConfirming((current) => ({ ...current, isOpen: false }))}
			>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>
							{confirmation?.title} {formatCount(confirming?.count, "contact")}?
						</DialogTitle>
						<DialogDescription>{confirmation?.description}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setConfirming({ ...confirming, isOpen: false })} disabled={isPending}>
							Cancel
						</Button>
						<Button variant="destructive" onClick={() => apply(confirmation.change)} disabled={isPending} className="min-w-24">
							{isPending ? <Loader2 className="animate-spin" /> : confirmation?.title}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
