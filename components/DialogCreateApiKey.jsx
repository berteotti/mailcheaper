"use client";

import { useActionState, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { createApiKey } from "@/app/(app)/api-keys/actions";
import ButtonCopy from "@/components/ButtonCopy";
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

export default function DialogCreateApiKey() {
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
				<Button>
					<Plus data-icon="inline-start" />
					New
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<FormApiKey key={formKey} />
			</DialogContent>
		</Dialog>
	);
}

function FormApiKey() {
	const [state, action, isPending] = useActionState(createApiKey, null);

	if (state?.key) {
		return (
			<>
				<DialogHeader>
					<DialogTitle>Copy your key</DialogTitle>
					<DialogDescription>
						{state.level === "signups"
							? "It is shown once. It can only add contacts, so it can go in your website's code."
							: "It is shown once. Keep it on a server or in your AI assistant's settings, never in a web page."}
					</DialogDescription>
				</DialogHeader>
				<div className="flex items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-3">
					<code className="min-w-0 flex-1 truncate font-mono text-[13px]">{state.key}</code>
					<ButtonCopy value={state.key} label="Copy key" />
				</div>
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
				<DialogTitle>New API key</DialogTitle>
				<DialogDescription>For the REST API and the MCP server.</DialogDescription>
			</DialogHeader>
			<Input name="name" placeholder="Name, e.g. Website signups" required autoFocus maxLength={60} />
			<fieldset className="grid gap-2">
				<legend className="sr-only">Access</legend>
				{LEVELS.map(({ value, label, description }) => (
					<label
						key={value}
						className="flex items-start gap-3 rounded-lg p-3 shadow-border transition-[box-shadow,background-color] duration-150 hover:shadow-border-hover has-checked:bg-muted/60 has-checked:shadow-border-hover"
					>
						<input
							type="radio"
							name="level"
							value={value}
							defaultChecked={value === "full"}
							className="mt-0.5 size-4 shrink-0 accent-foreground"
						/>
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
					{isPending ? <Loader2 className="animate-spin" /> : "Create"}
				</Button>
			</DialogFooter>
		</form>
	);
}

const LEVELS = [
	{
		value: "full",
		label: "Full access",
		description: "Everything the dashboard does: campaigns, contacts, domains, billing. For scripts and AI assistants.",
	},
	{ value: "signups", label: "Signups only", description: "Adds contacts and nothing else, for signup forms on your website." },
];
