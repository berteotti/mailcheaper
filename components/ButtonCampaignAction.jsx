"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToastError } from "@/lib/use-toast-error";

export default function ButtonCampaignAction({ action, id, disabledReason, children }) {
	const [isPending, startTransition] = useTransition();
	const toastError = useToastError();

	function run() {
		startTransition(async () => {
			const result = await action(id);
			if (result?.error) toastError(result);
		});
	}

	const button = (
		<Button variant="outline" onClick={run} disabled={isPending || Boolean(disabledReason)}>
			{children}
		</Button>
	);
	if (!disabledReason) return button;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span tabIndex={0} className="rounded-lg">
					{button}
				</span>
			</TooltipTrigger>
			<TooltipContent>{disabledReason}</TooltipContent>
		</Tooltip>
	);
}
