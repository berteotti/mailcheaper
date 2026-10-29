"use client";

import { useActionState, useState } from "react";
import { Loader2, UserPlus } from "lucide-react";
import { invite } from "@/app/(account)/organization/actions";
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

export default function DialogInviteMember({ organizationName, invitationDays }) {
	const [isOpen, setIsOpen] = useState(false);
	const [formKey, setFormKey] = useState(0);

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				setIsOpen(open);
				if (!open) setFormKey((key) => key + 1);
			}}
		>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					<UserPlus data-icon="inline-start" />
					Invite
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<FormInvite key={formKey} organizationName={organizationName} invitationDays={invitationDays} />
			</DialogContent>
		</Dialog>
	);
}

function FormInvite({ organizationName, invitationDays }) {
	const [state, action, isPending] = useActionState(invite, null);

	if (state?.email) {
		return (
			<>
				<DialogHeader>
					<DialogTitle>Invitation sent</DialogTitle>
					<DialogDescription>
						{state.warning ?? `${state.email} joins once they sign in with that address, within ${invitationDays} days.`}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose asChild>
						<Button>Done</Button>
					</DialogClose>
				</DialogFooter>
			</>
		);
	}

	return (
		<form action={action} className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>Invite to {organizationName}</DialogTitle>
				<DialogDescription>They get an email, and join when they sign in with that address.</DialogDescription>
			</DialogHeader>
			<Input name="email" type="email" placeholder="jane@example.com" required autoFocus autoComplete="off" spellCheck={false} />
			<fieldset className="grid gap-2">
				<legend className="sr-only">Role</legend>
				{ROLES.map(({ value, label, description }) => (
					<label
						key={value}
						className="flex items-start gap-3 rounded-lg p-3 shadow-border transition-[box-shadow,background-color] duration-150 hover:shadow-border-hover has-checked:bg-muted/60 has-checked:shadow-border-hover"
					>
						<input type="radio" name="role" value={value} defaultChecked={value === "member"} className="mt-0.5 size-4 shrink-0 accent-foreground" />
						<span className="flex flex-col gap-0.5">
							<span className="text-sm font-medium">{label}</span>
							<span className="text-xs text-pretty text-muted-foreground">{description}</span>
						</span>
					</label>
				))}
			</fieldset>
			{state?.error && <p className="text-sm text-destructive">{state.error}</p>}
			<DialogFooter>
				<Button type="submit" disabled={isPending} className="min-w-20">
					{isPending ? <Loader2 className="animate-spin" /> : "Invite"}
				</Button>
			</DialogFooter>
		</form>
	);
}

export const ROLES = [
	{ value: "member", label: "Member", description: "Newsletters, campaigns, contacts, domains and API keys." },
	{ value: "owner", label: "Owner", description: "All of that, plus people, billing and deleting the organization." },
];
