"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/format";
import { getLanguageName } from "@/lib/languages";

// Longer than any language tag, so it can't be one.
const ALL_LANGUAGES = "all-languages";

// The search and, once contacts are in more than one, the language. languages: [{ language, contacts }].
export default function FilterContacts({ languages }) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const [query, setQuery] = useState(searchParams.get("q") ?? "");
	const language = searchParams.get("language");
	const [isPending, startTransition] = useTransition();
	const timeout = useRef(null);

	function filter(key, value) {
		const params = new URLSearchParams(searchParams);
		if (value) params.set(key, value);
		else params.delete(key);
		params.delete("page");
		startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
	}

	function onQueryChange(event) {
		const value = event.target.value;
		setQuery(value);
		clearTimeout(timeout.current);
		timeout.current = setTimeout(() => filter("q", value.trim()), 300);
	}

	useEffect(() => () => clearTimeout(timeout.current), []);

	const options = language && !languages.some((row) => row.language === language) ? [...languages, { language, contacts: 0 }] : languages;

	return (
		<div className="flex gap-2">
			<div className="relative min-w-0 flex-1">
				{isPending ? (
					<Loader2 className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
				) : (
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
				)}
				<Input
					type="search"
					value={query}
					onChange={onQueryChange}
					placeholder="Search by email"
					aria-label="Search by email"
					className="h-9 pl-8"
				/>
			</div>
			{(options.length > 1 || language) && (
				<Select value={language ?? ALL_LANGUAGES} onValueChange={(value) => filter("language", value === ALL_LANGUAGES ? null : value)}>
					<SelectTrigger className="h-9 w-36 shrink-0 sm:w-52" aria-label="Language">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ALL_LANGUAGES}>All languages</SelectItem>
						{options.map(({ language: tag, contacts }) => (
							<SelectItem key={tag} value={tag}>
								{getLanguageName(tag)}
								<span className="text-xs text-muted-foreground tabular-nums">{formatNumber(contacts)}</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
		</div>
	);
}
