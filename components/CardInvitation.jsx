"use client";

import { useActionState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { decline, joinOrganization } from "@/app/invitations/actions";
import { Button } from "@/components/ui/button";

// One invitation: join, or decline. leaving: the organization joining takes the person out of, if they're in one.
export default function CardInvitation({ id, organizationName, inviter, role, leaving, canJoin }) {
	const [state, action, isJoining] = useActionState(joinOrganization, null);
	const [isDeclining, startDeclining] = useTransition();

	return (
		<form action={action} className="flex flex-col gap-3 rounded-xl p-4 shadow-border">
			<input type="hidden" name="invitationId" value={id} />
			{leaving && <input type="hidden" name="leave" value={leaving.id} />}
			<p className="text-sm text-pretty">
				<span className="font-medium">{inviter}</span> invited you to join <span className="font-medium">{organizationName}</span> as{" "}
				{role === "owner" ? "an owner" : "a member"}.
			</p>
			{state?.error && (
				<p role="alert" className="text-sm text-pretty text-destructive">
					{state.error}
				</p>
			)}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" disabled={isDeclining || isJoining} onClick={() => startDeclining(() => decline(id))}>
					{isDeclining ? <Loader2 className="animate-spin" /> : "Decline"}
				</Button>
				<Button type="submit" disabled={!canJoin || isJoining || isDeclining} className="min-w-20">
					{isJoining ? <Loader2 className="animate-spin" /> : leaving ? `Leave ${leaving.name} and join` : "Join"}
				</Button>
			</div>
		</form>
	);
}
