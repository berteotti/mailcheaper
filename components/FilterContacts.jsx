"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";

export default function FilterContacts() {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const [query, setQuery] = useState(searchParams.get("q") ?? "");
	const [isPending, startTransition] = useTransition();
	const timeout = useRef(null);

	function search(value) {
		const params = new URLSearchParams(searchParams);
		if (value) params.set("q", value);
		else params.delete("q");
		params.delete("page");
		startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
	}

	function onQueryChange(event) {
		const value = event.target.value;
		setQuery(value);
		clearTimeout(timeout.current);
		timeout.current = setTimeout(() => search(value.trim()), 300);
	}

	useEffect(() => () => clearTimeout(timeout.current), []);

	return (
		<div className="relative">
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
	);
}
