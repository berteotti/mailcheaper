"use client";

import { useId, useState } from "react";
import { CalendarDays } from "lucide-react";
import CalendarMonth from "@/components/CalendarMonth";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fromDayKey, toDayKey } from "@/lib/calendar";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// A date field that opens a calendar. value, min and max are YYYY-MM-DD keys, "" for none, and onChange gets the day
// picked as one. The rest goes on the field, like the id its label points to.
export default function InputDate({ value, onChange, min, max, placeholder = "Pick a date", className, ...props }) {
	const calendarId = useId();
	const [isOpen, setIsOpen] = useState(false);
	const day = fromDayKey(value);

	function pick(picked) {
		onChange(toDayKey(picked));
		setIsOpen(false);
	}

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen} modal>
			<PopoverTrigger asChild>
				<button
					type="button"
					role="combobox"
					aria-expanded={isOpen}
					aria-controls={isOpen ? calendarId : undefined}
					className={cn(
						"flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 text-left text-base whitespace-nowrap transition-[color,background-color,border-color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[state=open]:border-ring data-[state=open]:ring-3 data-[state=open]:ring-ring/50 md:text-sm dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
						className
					)}
					{...props}
				>
					<CalendarDays aria-hidden="true" />
					<span className={cn("truncate tabular-nums", !day && "text-muted-foreground")}>{day ? formatDate(day) : placeholder}</span>
				</button>
			</PopoverTrigger>
			<PopoverContent id={calendarId} align="start" aria-label="Pick a date" className="w-82 max-w-[calc(100vw-1rem)] p-3">
				<CalendarMonth selected={day} min={fromDayKey(min)} max={fromDayKey(max)} onSelect={pick} autoFocus />
			</PopoverContent>
		</Popover>
	);
}
