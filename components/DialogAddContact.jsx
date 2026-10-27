"use client";

import { useActionState, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { addContact } from "@/app/(app)/contacts/actions";
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
import { Input } from "@/components/ui/input";
import { ERROR_CODES } from "@/lib/account-state";
import { usePaywall } from "@/lib/use-paywall";

// Into the newsletter the page shows.
export default function DialogAddContact({ newsletter, variant = "outline", size }) {
	const [isOpen, setIsOpen] = useState(false);
	const [formKey, setFormKey] = useState(0);

	function changeOpen(open) {
		setIsOpen(open);
		if (!open) setFormKey((key) => key + 1);
	}

	return (
		<Dialog open={isOpen} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button variant={variant} size={size} disabled={!newsletter}>
					<Plus data-icon="inline-start" />
					Add contact
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<FormContact key={formKey} newsletter={newsletter} onClose={() => changeOpen(false)} />
			</DialogContent>
		</Dialog>
	);
}

function FormContact({ newsletter, onClose }) {
	const paywall = usePaywall();
	const [email, setEmail] = useState("");
	const [hasConsent, setHasConsent] = useState(false);
	const [state, action, isPending] = useActionState(async (previous, formData) => {
		const result = await addContact(previous, formData);
		if (result?.code === ERROR_CODES.subscriptionRequired && paywall) {
			onClose();
			paywall.open("contact");
		} else if (!result?.error) {
			onClose();
			toast.success(getAddedMessage(result));
		}
		return result;
	}, null);

	return (
		<form action={action} className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>Add a contact</DialogTitle>
				<DialogDescription>
					They join <span className="font-medium text-foreground">{newsletter?.name}</span> right away, with no confirmation
					email.
				</DialogDescription>
			</DialogHeader>
			<input type="hidden" name="newsletterId" value={newsletter?.id ?? ""} />
			<Input
				type="email"
				name="email"
				value={email}
				onChange={(event) => setEmail(event.target.value)}
				placeholder="Email, e.g. jane@example.com"
				aria-label="Email"
				required
				autoFocus
				maxLength={320}
				autoComplete="email"
				spellCheck={false}
			/>
			<div className="grid grid-cols-2 gap-2">
				<Input name="firstName" placeholder="First name" aria-label="First name" maxLength={100} autoComplete="off" />
				<Input name="lastName" placeholder="Last name" aria-label="Last name" maxLength={100} autoComplete="off" />
			</div>
			<label className="flex items-start gap-2.5 text-sm">
				<input
					type="checkbox"
					name="consent"
					checked={hasConsent}
					onChange={(event) => setHasConsent(event.target.checked)}
					required
					className="mt-0.5 size-4 shrink-0 accent-foreground"
				/>
				This person agreed to get my emails
			</label>
			{state?.error && <p className="text-sm text-destructive">{state.error}</p>}
			<DialogFooter>
				<Button type="submit" disabled={!hasConsent || isPending} className="min-w-20">
					{isPending ? <Loader2 className="animate-spin" /> : "Add"}
				</Button>
			</DialogFooter>
		</form>
	);
}

// A suppressed address joins as bounced, complained or unsubscribed.
function getAddedMessage({ email, status }) {
	return status === "active" ? `${email} added` : `${email} added as ${status}`;
}
