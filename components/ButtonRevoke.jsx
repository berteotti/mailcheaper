"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

// Revokes an API key, disconnects an app or cancels an invitation, after a confirmation. revoke: the server action,
// given the id.
export default function ButtonRevoke({ id, revoke, confirmMessage, successMessage, label = "Revoke" }) {
	const [isPending, startTransition] = useTransition();

	function onClick() {
		if (!window.confirm(confirmMessage)) return;
		startTransition(async () => {
			const result = await revoke(id);
			if (result?.error) toast.error(result.error);
			else toast.success(successMessage);
		});
	}

	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={onClick}
			disabled={isPending}
			className="text-muted-foreground hover:text-destructive"
		>
			{isPending ? <Loader2 className="animate-spin" /> : label}
		</Button>
	);
}
