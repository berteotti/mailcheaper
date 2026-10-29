"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { leaveOrganization } from "@/app/(account)/organization/actions";
import { Button } from "@/components/ui/button";

export default function ButtonLeaveOrganization({ name, isDisabled }) {
	const [isPending, startTransition] = useTransition();

	function leave() {
		if (!window.confirm(`Leave ${name}? You're signed out, and the apps you connected disconnect. Its newsletters stay with it.`)) return;
		startTransition(async () => {
			const result = await leaveOrganization();
			if (result?.error) toast.error(result.error);
		});
	}

	return (
		<Button type="button" variant="outline" onClick={leave} disabled={isDisabled || isPending} className="min-w-20">
			{isPending ? <Loader2 className="animate-spin" /> : "Leave"}
		</Button>
	);
}
