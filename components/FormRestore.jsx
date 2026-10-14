"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { restoreDeletedAccount } from "@/app/restore/actions";
import { Button } from "@/components/ui/button";

export default function FormRestore() {
	const [state, action, isPending] = useActionState(restoreDeletedAccount, null);

	return (
		<form action={action} className="mt-8 flex flex-col gap-3">
			<Button type="submit" size="lg" disabled={isPending} className="h-11">
				{isPending ? <Loader2 className="animate-spin" /> : "Restore account"}
			</Button>
			{state?.error && (
				<p role="alert" className="text-sm text-pretty text-destructive">
					{state.error}
				</p>
			)}
			<p className="text-xs text-pretty text-muted-foreground">Your API keys and connected apps stay off. Create new ones once it&apos;s back.</p>
		</form>
	);
}
