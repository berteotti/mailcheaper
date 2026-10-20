"use client";

import { useTransition } from "react";
import { Languages, MoreHorizontal, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";
import { setContactLanguage, setContactStatus } from "@/app/(app)/contacts/actions";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LANGUAGES, getLanguageName } from "@/lib/languages";

const LANGUAGE_OPTIONS = Object.entries(LANGUAGES).sort(([, a], [, b]) => a.localeCompare(b));
// Longer than any language code, so it can't be one.
const NEWSLETTER_LANGUAGE = "newsletter";

export default function MenuContact({ id, status, language, newsletterLanguage }) {
	const [isPending, startTransition] = useTransition();
	const canChangeStatus = ["active", "dormant"].includes(status);

	function update(nextStatus) {
		startTransition(async () => {
			const result = await setContactStatus(id, nextStatus);
			if (result?.error) toast.error(result.error);
		});
	}

	function changeLanguage(value) {
		startTransition(async () => {
			const result = await setContactLanguage(id, value === NEWSLETTER_LANGUAGE ? null : value);
			if (result?.error) toast.error(result.error);
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
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<Languages />
						Language
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="max-h-80 overflow-y-auto">
						<DropdownMenuRadioGroup value={language ?? NEWSLETTER_LANGUAGE} onValueChange={changeLanguage}>
							<DropdownMenuRadioItem value={NEWSLETTER_LANGUAGE}>
								Newsletter&apos;s ({getLanguageName(newsletterLanguage)})
							</DropdownMenuRadioItem>
							<DropdownMenuSeparator />
							{LANGUAGE_OPTIONS.map(([code, name]) => (
								<DropdownMenuRadioItem key={code} value={code}>
									{name}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				{canChangeStatus && <DropdownMenuSeparator />}
				{status === "dormant" && (
					<DropdownMenuItem onSelect={() => update("active")}>
						<UserCheck />
						Reactivate
					</DropdownMenuItem>
				)}
				{canChangeStatus && (
					<DropdownMenuItem variant="destructive" onSelect={() => update("unsubscribed")}>
						<UserX />
						Unsubscribe
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
