"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { setContactName } from "@/app/(app)/contacts/actions";
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
import { Input } from "@/components/ui/input";

// Opened from a contact's menu, so the caller owns the open state.
export default function DialogContactName({ id, email, firstName, lastName, isOpen, onOpenChange }) {
	const [isSaving, startSaving] = useTransition();

	function save(formData) {
		startSaving(async () => {
			const result = await setContactName(id, { firstName: formData.get("firstName"), lastName: formData.get("lastName") });
			if (result?.error) return void toast.error(result.error);
			onOpenChange(false);
		});
	}

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<form action={save} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>Edit name</DialogTitle>
						<DialogDescription className="truncate">{email}</DialogDescription>
					</DialogHeader>
					<div className="grid grid-cols-2 gap-2">
						<Input
							name="firstName"
							defaultValue={firstName ?? ""}
							placeholder="First name"
							aria-label="First name"
							maxLength={100}
							autoComplete="off"
							autoFocus
						/>
						<Input
							name="lastName"
							defaultValue={lastName ?? ""}
							placeholder="Last name"
							aria-label="Last name"
							maxLength={100}
							autoComplete="off"
						/>
					</div>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline">
								Cancel
							</Button>
						</DialogClose>
						<Button type="submit" disabled={isSaving} className="min-w-20">
							{isSaving ? <Loader2 className="animate-spin" /> : "Save"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
