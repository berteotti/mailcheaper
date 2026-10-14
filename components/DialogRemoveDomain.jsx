"use client";

import { useState, useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { removeDomainAction } from "@/app/(app)/domains/actions";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";

export default function DialogRemoveDomain({ id, domain }) {
	const [isOpen, setIsOpen] = useState(false);
	const [isRemoving, startRemoving] = useTransition();

	function remove() {
		startRemoving(async () => {
			const result = await removeDomainAction(id);
			if (result?.error) return void toast.error(result.error);
			setIsOpen(false);
			toast.success(`${domain} removed`);
		});
	}

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				<Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${domain}`} className="text-muted-foreground hover:text-foreground">
					<Trash2 />
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Remove {domain}?</DialogTitle>
					<DialogDescription>
						Newsletters can&apos;t send from it anymore, and its archive subdomain stops working. You can add it again later.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="outline">Cancel</Button>
					</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={isRemoving} className="min-w-20">
						{isRemoving ? <Loader2 className="animate-spin" /> : "Remove"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
