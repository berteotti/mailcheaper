"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { addDays, addMonths, clampMonth, isSameMonth, moveDay, startOfDay, startOfMonth, toDayKey } from "@/lib/calendar";
import { cn } from "@/lib/utils";

const WEEKS_SHOWN = 6;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// The years offered without a min or a max: back to any birthday, and ahead to any renewal.
const FIRST_YEAR = 1900;
const YEARS_AHEAD = 50;
const CAPTION_SELECT =
	"gap-1 border-transparent bg-transparent pr-1.5 pl-2 font-medium hover:bg-muted data-[state=open]:bg-muted dark:bg-transparent dark:hover:bg-muted/50 [&_svg]:size-3.5";

// A month to pick a day in, with its month and year to jump to, and Today. The keyboard moves by a day or a week (arrows),
// to the week's ends (Home, End) or by a month (Page Up, Page Down, a year with Shift). selected: the day picked, or
// null; min and max: the first and last days that can be picked, or null. Days are local dates at midnight.
export default function CalendarMonth({ selected = null, onSelect, min = null, max = null, autoFocus = false }) {
	const captionId = useId();
	const gridRef = useRef(null);
	const shouldFocusRef = useRef(autoFocus);
	const today = startOfDay(new Date());
	const todayKey = toDayKey(today);
	const [month, setMonth] = useState(() => clampMonth(startOfMonth(selected ?? today), min, max));
	const [focusedDay, setFocusedDay] = useState(null);
	const selectedKey = selected ? toDayKey(selected) : null;
	const [shownKey, setShownKey] = useState(selectedKey);
	const isPickable = (day) => (!min || day >= min) && (!max || day <= max);
	// The one day Tab stops on, which the keyboard moves.
	const tabbableDay = [focusedDay, selected, today, min].find((day) => day && isSameMonth(day, month) && isPickable(day)) ?? month;
	const tabbableKey = toDayKey(tabbableDay);

	// A day picked another way, like Today, shows its month.
	if (selectedKey !== shownKey) {
		setShownKey(selectedKey);
		if (selected && !isSameMonth(selected, month)) setMonth(clampMonth(startOfMonth(selected), min, max));
	}

	useEffect(() => {
		if (!shouldFocusRef.current) return;
		shouldFocusRef.current = false;
		gridRef.current?.querySelector(`[data-day="${tabbableKey}"]`)?.focus({ preventScroll: true });
	}, [tabbableKey]);

	function show(next) {
		setMonth(clampMonth(next, min, max));
	}

	function pick(day) {
		setFocusedDay(day);
		onSelect(day);
	}

	function selectToday() {
		setMonth(startOfMonth(today));
		pick(today);
	}

	function moveFocus(event) {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const day = moveDay(tabbableDay, event, { min, max });
		if (!day) return;
		event.preventDefault();
		if (toDayKey(day) === tabbableKey) return;
		shouldFocusRef.current = true;
		setFocusedDay(day);
		setMonth(startOfMonth(day));
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center">
					<Select value={String(month.getMonth())} onValueChange={(value) => value && show(new Date(month.getFullYear(), Number(value), 1))}>
						<SelectTrigger size="sm" aria-label="Month" className={CAPTION_SELECT}>
							<SelectValue>{MONTHS[month.getMonth()]}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{MONTHS.map((name, index) => (
								<SelectItem key={name} value={String(index)} disabled={!hasPickableDays(new Date(month.getFullYear(), index, 1), min, max)}>
									{name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select value={String(month.getFullYear())} onValueChange={(value) => value && show(new Date(Number(value), month.getMonth(), 1))}>
						<SelectTrigger size="sm" aria-label="Year" className={cn(CAPTION_SELECT, "tabular-nums")}>
							<SelectValue>{month.getFullYear()}</SelectValue>
						</SelectTrigger>
						<SelectContent position="popper" className="max-h-64">
							{getYears(month, min, max).map((year) => (
								<SelectItem key={year} value={String(year)} className="tabular-nums">
									{year}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex items-center gap-0.5">
					<Button variant="ghost" size="sm" onClick={selectToday} disabled={!isPickable(today)} className="text-muted-foreground">
						Today
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Previous month"
						onClick={() => show(addMonths(month, -1))}
						disabled={Boolean(min) && month <= min}
					>
						<ChevronLeft />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Next month"
						onClick={() => show(addMonths(month, 1))}
						disabled={Boolean(max) && addMonths(month, 1) > max}
					>
						<ChevronRight />
					</Button>
				</div>
			</div>
			<p id={captionId} aria-live="polite" className="sr-only">
				{MONTHS[month.getMonth()]} {month.getFullYear()}
			</p>
			<div ref={gridRef} role="grid" aria-labelledby={captionId} onKeyDown={moveFocus} className="flex flex-col gap-0.5">
				<div role="row" className="grid grid-cols-7">
					{WEEKDAYS.map((weekday) => (
						<span key={weekday} role="columnheader" aria-label={weekday} className="grid h-8 place-items-center text-xs text-muted-foreground">
							{weekday.slice(0, 2)}
						</span>
					))}
				</div>
				{getWeeks(month).map((week) => (
					<div key={week[0].getTime()} role="row" className="grid grid-cols-7">
						{week.map((day) => {
							const key = toDayKey(day);
							const isInMonth = isSameMonth(day, month);
							return (
								<div key={key} role="gridcell" aria-selected={isInMonth && key === selectedKey} className="grid h-9 place-items-center">
									<ButtonDay
										day={day}
										isOutside={!isInMonth}
										isToday={isInMonth && key === todayKey}
										isSelected={isInMonth && key === selectedKey}
										isDisabled={!isPickable(day)}
										isTabbable={key === tabbableKey}
										onSelect={() => pick(day)}
									/>
								</div>
							);
						})}
					</div>
				))}
			</div>
		</div>
	);
}

// A day of the month before or after (isOutside) fills the weeks, dimmed, and picking it shows its month.
function ButtonDay({ day, isOutside, isToday, isSelected, isDisabled, isTabbable, onSelect }) {
	const label = day.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
	return (
		<button
			type="button"
			data-day={toDayKey(day)}
			tabIndex={isTabbable ? 0 : -1}
			aria-current={isToday ? "date" : undefined}
			aria-label={`${isToday ? "Today, " : ""}${label}${isSelected ? ", selected" : ""}`}
			disabled={isDisabled}
			onClick={onSelect}
			className={cn(
				"grid size-9 place-items-center rounded-full text-sm tabular-nums outline-none transition-[background-color,color,box-shadow,scale] duration-150 ease-out focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.96] disabled:pointer-events-none disabled:text-muted-foreground/40",
				isSelected ? "bg-foreground font-medium text-background" : "hover:bg-muted",
				isOutside && "text-muted-foreground/70",
				isToday && !isSelected && "font-semibold shadow-border"
			)}
		>
			{day.getDate()}
		</button>
	);
}

// Six weeks from the Sunday the month starts in, so the calendar keeps its height from a month to the next.
function getWeeks(month) {
	const start = addDays(month, -month.getDay());
	return Array.from({ length: WEEKS_SHOWN }, (_, week) => Array.from({ length: 7 }, (_, weekday) => addDays(start, week * 7 + weekday)));
}

function getYears(month, min, max) {
	const first = Math.min(min?.getFullYear() ?? FIRST_YEAR, month.getFullYear());
	const last = Math.max(max?.getFullYear() ?? new Date().getFullYear() + YEARS_AHEAD, month.getFullYear());
	return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function hasPickableDays(month, min, max) {
	return (!min || addMonths(month, 1) > min) && (!max || month <= max);
}
