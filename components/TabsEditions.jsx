"use client";

import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatNumber } from "@/lib/format";
import { getLanguageName } from "@/lib/languages";
import { cn } from "@/lib/utils";

// Longer than any language code, so it can't be one.
const NEWSLETTER_LANGUAGE = "newsletter";

// The campaign's languages, its own first, each with the contacts who get it: picking one edits it. The own one's
// menu changes its language, an edition's deletes it, and the last menu adds one. Both offer only the contacts'
// languages it has nothing in yet (addable). tabs: [{ key, language, contacts }], addable: [{ language, contacts }].
export default function TabsEditions({
	tabs,
	active,
	addable,
	ownLanguage,
	newsletterLanguage,
	isPending,
	onSelect,
	onAdd,
	onDelete,
	onChangeLanguage,
}) {
	return (
		<div className="flex min-w-0 items-center gap-1 overflow-x-auto py-2">
			{tabs.map(({ key, language, contacts }, index) => {
				const isActive = key === active;
				const isOwn = index === 0;
				return (
					<div
						key={key}
						className={cn(
							"flex h-7 shrink-0 items-center rounded-md text-sm transition-colors duration-150",
							isActive ? "bg-muted" : "text-muted-foreground hover:bg-muted/60"
						)}
					>
						<button type="button" aria-pressed={isActive} onClick={() => onSelect(key)} className={cn("h-full pl-2.5", isActive ? "pr-1" : "pr-2.5")}>
							{getLanguageName(language)}
							<span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{formatNumber(contacts)}</span>
						</button>
						{isActive && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button variant="ghost" size="icon-xs" aria-label={`${getLanguageName(language)} options`} disabled={isPending}>
										<ChevronDown />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
									{isOwn ? (
										<DropdownMenuRadioGroup
											value={ownLanguage ?? NEWSLETTER_LANGUAGE}
											onValueChange={(value) => onChangeLanguage(value === NEWSLETTER_LANGUAGE ? null : value)}
										>
											<DropdownMenuRadioItem value={NEWSLETTER_LANGUAGE}>
												Newsletter&apos;s ({getLanguageName(newsletterLanguage)})
											</DropdownMenuRadioItem>
											<DropdownMenuSeparator />
											{[language, ...addable.map((row) => row.language)].map((code) => (
												<DropdownMenuRadioItem key={code} value={code}>
													{getLanguageName(code)}
												</DropdownMenuRadioItem>
											))}
										</DropdownMenuRadioGroup>
									) : (
										<DropdownMenuItem variant="destructive" onSelect={() => onDelete(key)}>
											<Trash2 />
											Delete edition
										</DropdownMenuItem>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						)}
					</div>
				);
			})}
			{addable.length > 0 && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" disabled={isPending}>
							<Plus data-icon="inline-start" />
							Language
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
						<DropdownMenuLabel>Your contacts&apos; languages</DropdownMenuLabel>
						{addable.map(({ language, contacts }) => (
							<DropdownMenuItem key={language} onSelect={() => onAdd(language)}>
								{getLanguageName(language)}
								<span className="ml-auto text-xs text-muted-foreground tabular-nums">{formatNumber(contacts)}</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}
