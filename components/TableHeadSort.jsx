import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

// A column heading that sorts the list by it. order: asc or desc while the list is sorted by it, else null. A column
// aligned to its end (align="end") has the arrow first, so the heading lines up with the numbers under it.
export default function TableHeadSort({ href, order, align = "start", className, children }) {
	const Icon = order === "asc" ? ArrowUp : order === "desc" ? ArrowDown : ChevronsUpDown;
	return (
		<TableHead className={className} aria-sort={order === "asc" ? "ascending" : order === "desc" ? "descending" : undefined}>
			<Link
				href={href}
				scroll={false}
				className={cn("group inline-flex items-center gap-1 rounded-sm", align === "end" && "flex-row-reverse")}
			>
				{children}
				<Icon
					aria-hidden
					className={cn(
						"size-3.5 transition-opacity duration-150",
						order ? "text-foreground" : "text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
					)}
				/>
			</Link>
		</TableHead>
	);
}
