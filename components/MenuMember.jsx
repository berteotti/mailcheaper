"use client";

import { useTransition } from "react";
import { MoreHorizontal, ShieldCheck, UserMinus, UserRound } from "lucide-react";
import { toast } from "sonner";
import { removeFromOrganization, setRole } from "@/app/(account)/organization/actions";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// An owner's actions on someone in the organization: the other role, and taking them out (not themselves: they leave).
export default function MenuMember({ id, name, role, isSelf }) {
	const [isPending, startTransition] = useTransition();
	const nextRole = role === "owner" ? "member" : "owner";

	function changeRole() {
		startTransition(async () => {
			const result = await setRole(id, nextRole);
			if (result?.error) toast.error(result.error);
			else toast.success(nextRole === "owner" ? `${name} is an owner` : `${name} is a member`);
		});
	}

	function remove() {
		if (!window.confirm(`Remove ${name}? They're signed out, and the apps they connected disconnect. API keys stay: revoke any they kept.`)) return;
		startTransition(async () => {
			const result = await removeFromOrganization(id);
			if (result?.error) toast.error(result.error);
			else toast.success(`${name} is out of the organization`);
		});
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon-sm" aria-label="Actions" disabled={isPending}>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={changeRole}>
					{nextRole === "owner" ? <ShieldCheck /> : <UserRound />}
					{nextRole === "owner" ? "Make owner" : "Make member"}
				</DropdownMenuItem>
				{!isSelf && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" onSelect={remove}>
							<UserMinus />
							Remove
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
