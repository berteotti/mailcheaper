import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

// TableCampaigns while it loads: same columns, rows of the same height.
export default function SkeletonCampaigns({ rows = 8, hasActions = false }) {
	return (
		<div aria-hidden="true" className="overflow-hidden rounded-xl shadow-border">
			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead className="pl-4">Subject</TableHead>
						<TableHead>Status</TableHead>
						<TableHead className="hidden text-right md:table-cell">Recipients</TableHead>
						<TableHead className="hidden text-right md:table-cell">Opens</TableHead>
						<TableHead className="hidden text-right md:table-cell">Clicks</TableHead>
						<TableHead className={cn("hidden text-right sm:table-cell", !hasActions && "pr-4")}>Date</TableHead>
						{hasActions && <TableHead className="w-12 pr-2" />}
					</TableRow>
				</TableHeader>
				<TableBody>
					{Array.from({ length: rows }, (_, index) => (
						<TableRow key={index} className="hover:bg-transparent">
							<TableCell className="w-full max-w-0 py-3 pl-4 sm:w-1/2">
								<div className="flex min-w-0 items-center gap-3.5">
									<Skeleton className="h-10 w-16 shrink-0" />
									<div className="min-w-0 flex-1">
										<Skeleton className="h-3.5" style={{ width: `${SUBJECT_WIDTHS[index % SUBJECT_WIDTHS.length]}%` }} />
									</div>
								</div>
							</TableCell>
							<TableCell>
								<Skeleton className="h-6 w-14 rounded-full" />
							</TableCell>
							{["w-12", "w-10", "w-9"].map((width) => (
								<TableCell key={width} className="hidden md:table-cell">
									<Skeleton className={cn("ml-auto h-3", width)} />
								</TableCell>
							))}
							<TableCell className={cn("hidden sm:table-cell", !hasActions && "pr-4")}>
								<Skeleton className="ml-auto h-3 w-20" />
							</TableCell>
							{hasActions && (
								<TableCell className="pr-2">
									<span className="block size-7" />
								</TableCell>
							)}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

const SUBJECT_WIDTHS = [72, 54, 64, 48, 80, 58, 68, 44];
