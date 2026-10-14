"use client";

import { useActionState, useState } from "react";
import { Loader2 } from "lucide-react";
import { answerConsentRequest } from "@/app/oauth/consent/actions";
import { Button } from "@/components/ui/button";

export default function FormConsent({ oauthQuery }) {
	const [state, action, isPending] = useActionState(answerConsentRequest, null);
	const [decision, setDecision] = useState(null);

	return (
		<form action={action} className="flex flex-col gap-3">
			<input type="hidden" name="oauth_query" value={oauthQuery} />
			{state?.error && (
				<p role="alert" className="text-center text-sm text-pretty text-destructive">
					{state.error}
				</p>
			)}
			<div className="grid grid-cols-2 gap-2">
				<Button type="submit" name="decision" value="deny" variant="outline" size="lg" disabled={isPending} onClick={() => setDecision("deny")}>
					{isPending && decision === "deny" ? <Loader2 className="animate-spin" /> : "Cancel"}
				</Button>
				<Button type="submit" name="decision" value="allow" size="lg" disabled={isPending} onClick={() => setDecision("allow")}>
					{isPending && decision === "allow" ? <Loader2 className="animate-spin" /> : "Allow"}
				</Button>
			</div>
		</form>
	);
}
