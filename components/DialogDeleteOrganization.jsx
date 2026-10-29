"use client";

import { useActionState, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { deleteOrganization, sendDeletionCode } from "@/app/(account)/organization/actions";
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

const CODE_PATTERN = /^\d{6}$/;

export default function DialogDeleteOrganization({ name, email, graceDays, isDisabled }) {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button type="button" variant="destructive" disabled={isDisabled}>
					Delete organization
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<StepsDelete name={name} email={email} graceDays={graceDays} />
			</DialogContent>
		</Dialog>
	);
}

// Inside the dialog's content, which unmounts on close: each opening starts from the first step.
function StepsDelete({ name, email, graceDays }) {
	const [isCodeSent, setIsCodeSent] = useState(false);
	const [isSending, startSending] = useTransition();
	const [state, action, isDeleting] = useActionState(deleteOrganization, null);
	const [code, setCode] = useState("");
	const [typedEmail, setTypedEmail] = useState("");
	const isConfirmed = CODE_PATTERN.test(code.replace(/\s/g, "")) && typedEmail.trim().toLowerCase() === email.toLowerCase();

	function sendCode() {
		startSending(async () => {
			const result = await sendDeletionCode();
			if (result?.error) return void toast.error(result.error);
			if (isCodeSent) toast.success(`New code sent to ${email}`);
			setIsCodeSent(true);
		});
	}

	if (!isCodeSent) {
		return (
			<>
				<DialogHeader>
					<DialogTitle>Delete {name}?</DialogTitle>
					<DialogDescription>
						It stops at once: everyone in it is signed out everywhere, API keys and connected apps stop working, and nothing more is
						sent.
					</DialogDescription>
				</DialogHeader>
				<p className="text-sm text-pretty text-muted-foreground">
					In {graceDays} days, its newsletters, contacts, campaigns and images are deleted for good, with its members&apos; sign-ins.
					An owner who signs in before then can restore it.
				</p>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="outline">Cancel</Button>
					</DialogClose>
					<Button onClick={sendCode} disabled={isSending} className="min-w-32">
						{isSending ? <Loader2 className="animate-spin" /> : "Email me a code"}
					</Button>
				</DialogFooter>
			</>
		);
	}

	return (
		<form action={action} className="grid gap-4">
			<DialogHeader>
				<DialogTitle>Confirm it&apos;s you</DialogTitle>
				<DialogDescription>
					Enter the code sent to <span className="font-medium text-foreground">{email}</span>, then type your email address.
				</DialogDescription>
			</DialogHeader>
			<div className="grid gap-2">
				<Label htmlFor="deletion-code">Code</Label>
				<Input
					id="deletion-code"
					name="code"
					value={code}
					onChange={(event) => setCode(event.target.value)}
					inputMode="numeric"
					autoComplete="one-time-code"
					placeholder="000000"
					maxLength={10}
					required
					autoFocus
					className="h-11 text-center font-mono text-lg tracking-[0.4em] tabular-nums"
				/>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="deletion-email">Email address</Label>
				<Input
					id="deletion-email"
					name="email"
					type="email"
					value={typedEmail}
					onChange={(event) => setTypedEmail(event.target.value)}
					placeholder={email}
					autoComplete="off"
					spellCheck={false}
					required
				/>
			</div>
			{state?.error && (
				<p role="alert" className="text-sm text-pretty text-destructive">
					{state.error}
				</p>
			)}
			<DialogFooter className="sm:items-center">
				<button
					type="button"
					onClick={sendCode}
					disabled={isSending}
					className="text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:opacity-50 sm:mr-auto"
				>
					{isSending ? "Sending…" : "Send a new code"}
				</button>
				<DialogClose asChild>
					<Button type="button" variant="outline">
						Cancel
					</Button>
				</DialogClose>
				<Button type="submit" variant="destructive" disabled={!isConfirmed || isDeleting} className="min-w-32">
					{isDeleting ? <Loader2 className="animate-spin" /> : "Delete organization"}
				</Button>
			</DialogFooter>
		</form>
	);
}
