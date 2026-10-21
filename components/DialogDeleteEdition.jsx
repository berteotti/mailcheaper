"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { formatNumber } from "@/lib/format";
import { getLanguageName } from "@/lib/languages";

// Opened from a tab's menu, so the caller owns the open state. nextLanguage: what its readers get once it's gone, or
// null for nothing. onDelete resolves to false when it didn't.
export default function DialogDeleteEdition({ language, contacts, nextLanguage, onDelete, onOpenChange }) {
	const [isDeleting, startDeleting] = useTransition();
	const name = language ? getLanguageName(language) : "";

	function remove() {
		startDeleting(async () => {
			if (!(await onDelete(language))) return;
			onOpenChange(false);
			toast.success(`${name} edition deleted`);
		});
	}

	return (
		<Dialog open={Boolean(language)} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Delete the {name} edition?</DialogTitle>
					<DialogDescription>
						Its subject and content are deleted.{" "}
						{contacts > 0
							? `${formatNumber(contacts)} ${contacts === 1 ? "contact reads" : "contacts read"} it: ${nextLanguage ? `they get ${getLanguageName(nextLanguage)} instead.` : "they get nothing from this campaign."}`
							: "No contact reads it yet."}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="outline">Cancel</Button>
					</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={isDeleting} className="min-w-20">
						{isDeleting ? <Loader2 className="animate-spin" /> : "Delete"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
