"use client";

import { ChevronDown, FlaskConical, Loader2 } from "lucide-react";
import AvatarUser from "@/components/AvatarUser";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// Sends a test to the person signed in, the first of `recipients`. With others in the organization, it asks who
// gets it first.
export default function ButtonSendTest({ recipients, isTesting, disabled, size, onSend, children }) {
	const icon = isTesting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <FlaskConical data-icon="inline-start" />;

	if (recipients.length < 2) {
		return (
			<Button type="button" variant="outline" size={size} onClick={() => onSend(recipients[0]?.email)} disabled={disabled}>
				{icon}
				{children}
			</Button>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button type="button" variant="outline" size={size} disabled={disabled}>
					{icon}
					{children}
					<ChevronDown data-icon="inline-end" className="text-muted-foreground" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
				<DropdownMenuLabel>Send to</DropdownMenuLabel>
				{recipients.map((person, index) => (
					<DropdownMenuItem key={person.email} onSelect={() => onSend(person.email)} className="gap-2">
						<AvatarUser name={person.name} email={person.email} image={person.image} size={24} />
						<span className="flex min-w-0 flex-col">
							<span className="truncate">
								{person.name || person.email}
								{index === 0 && <span className="text-muted-foreground"> (you)</span>}
							</span>
							{person.name && <span className="truncate text-xs text-muted-foreground">{person.email}</span>}
						</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
