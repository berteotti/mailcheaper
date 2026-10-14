"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { askToSignOut } from "@/lib/sign-out";
import { cn } from "@/lib/utils";

// Goes inside a form whose action signs out.
export default function ButtonSignout({ children, className }) {
	if (children) {
		return (
			<button
				type="submit"
				onClick={confirmSignout}
				className={cn("text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground", className)}
			>
				{children}
			</button>
		);
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button type="submit" variant="ghost" size="icon" aria-label="Sign out" onClick={confirmSignout}>
					<LogOut />
				</Button>
			</TooltipTrigger>
			<TooltipContent>Sign out</TooltipContent>
		</Tooltip>
	);
}

function confirmSignout(event) {
	if (!askToSignOut()) event.preventDefault();
}
