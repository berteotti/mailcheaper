import HeaderPage from "@/components/HeaderPage";
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

const STATUS_WIDTHS = ["w-14", "w-20", "w-20", "w-28", "w-22", "w-28", "w-22"];
const EMAIL_WIDTHS = [62, 48, 70, 54, 44, 66, 58, 50, 72, 46];

export default function Loading() {
	return (
		<>
			<HeaderPage title="Contacts">
				<Skeleton className="h-9 w-24 rounded-lg" />
			</HeaderPage>
			<div aria-hidden="true" className="flex flex-col gap-4">
				<Skeleton className="h-9 w-full rounded-lg" />
				<div className="-mx-1 flex gap-1 overflow-hidden px-1 pb-1">
					{STATUS_WIDTHS.map((width, index) => (
						<Skeleton key={index} className={cn("h-8 shrink-0 rounded-full first:bg-foreground/15", width)} />
					))}
				</div>
				<div className="overflow-hidden rounded-xl shadow-border">
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="pl-4">Email</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="hidden text-right lg:table-cell">Opens</TableHead>
								<TableHead className="hidden text-right lg:table-cell">Clicks</TableHead>
								<TableHead className="hidden text-right sm:table-cell">Added</TableHead>
								<TableHead className="w-12 pr-2" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{EMAIL_WIDTHS.map((width, index) => (
								<TableRow key={index} className="hover:bg-transparent">
									<TableCell className="w-full max-w-0 py-2.5 pl-4 sm:w-2/5">
										<span className="flex items-center gap-2.5">
											<Skeleton className="size-[26px] shrink-0 rounded-full" />
											<Skeleton className="h-3.5" style={{ width: `${width}%` }} />
										</span>
									</TableCell>
									<TableCell>
										<Skeleton className="h-6 w-16 rounded-full" />
									</TableCell>
									<TableCell className="hidden lg:table-cell">
										<Skeleton className="ml-auto h-3 w-8" />
									</TableCell>
									<TableCell className="hidden lg:table-cell">
										<Skeleton className="ml-auto h-3 w-6" />
									</TableCell>
									<TableCell className="hidden sm:table-cell">
										<Skeleton className="ml-auto h-3 w-20" />
									</TableCell>
									<TableCell className="pr-2">
										<span className="block size-7" />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</div>
		</>
	);
}
