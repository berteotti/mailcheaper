"use client";

import { useId, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { deleteNewsletter } from "@/app/(app)/newsletters/actions";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// In the newsletter's settings form, so no form of its own: the dialog's content is portaled out of it, but its
// events still reach the settings form through React.
export default function DialogDeleteNewsletter({ id, name, isDisabled }) {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button type="button" variant="destructive" disabled={isDisabled}>
					Delete newsletter
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<StepConfirm id={id} name={name} />
			</DialogContent>
		</Dialog>
	);
}

// Inside the dialog's content, which unmounts on close: each opening starts empty.
function StepConfirm({ id, name }) {
	const inputId = useId();
	const [typedName, setTypedName] = useState("");
	const [error, setError] = useState(null);
	const [isDeleting, startDeleting] = useTransition();
	const isConfirmed = typedName.trim() === name;

	function remove() {
		if (!isConfirmed || isDeleting) return;
		startDeleting(async () => {
			const result = await deleteNewsletter(id, typedName);
			if (result?.error) setError(result.error);
		});
	}

	return (
		<div className="grid gap-4">
			<DialogHeader>
				<DialogTitle>Delete {name}?</DialogTitle>
				<DialogDescription className="text-pretty">
					Its contacts, campaigns, archive and stats are deleted for good. This can&apos;t be undone.
				</DialogDescription>
			</DialogHeader>
			<div className="grid gap-2">
				<Label htmlFor={inputId}>Type its name to confirm</Label>
				<Input
					id={inputId}
					value={typedName}
					onChange={(event) => setTypedName(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter") return;
						event.preventDefault();
						remove();
					}}
					placeholder={name}
					autoComplete="off"
					spellCheck={false}
					autoFocus
				/>
			</div>
			{error && (
				<p role="alert" className="text-sm text-pretty text-destructive">
					{error}
				</p>
			)}
			<DialogFooter>
				<DialogClose asChild>
					<Button type="button" variant="outline">
						Cancel
					</Button>
				</DialogClose>
				<Button type="button" variant="destructive" onClick={remove} disabled={!isConfirmed || isDeleting} className="min-w-36">
					{isDeleting ? <Loader2 className="animate-spin" /> : "Delete newsletter"}
				</Button>
			</DialogFooter>
		</div>
	);
}
