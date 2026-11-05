// Calendar days as the browser's local dates at midnight, and as the YYYY-MM-DD keys that forms, the API and date
// fields take.
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const KEY_DAYS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

export function startOfDay(date) {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function startOfMonth(date) {
	return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addDays(date, count) {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

// The first day of the month count months away.
export function addMonths(date, count) {
	return new Date(date.getFullYear(), date.getMonth() + count, 1);
}

export function isSameMonth(day, month) {
	return day.getFullYear() === month.getFullYear() && day.getMonth() === month.getMonth();
}

// "2026-10-21" for a local day.
export function toDayKey(date) {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

// The local day a key names, or null for anything else, like 2026-02-30.
export function fromDayKey(key) {
	const match = DAY_KEY.exec(typeof key === "string" ? key : "");
	if (!match) return null;
	const [year, month, day] = match.slice(1).map(Number);
	const date = new Date(year, month - 1, day);
	return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

// The day, or the nearest one between min and max (either can be null).
export function clampDay(day, min, max) {
	if (min && day < min) return min;
	if (max && day > max) return max;
	return day;
}

export function clampMonth(month, min, max) {
	return startOfMonth(clampDay(month, min && startOfMonth(min), max && startOfMonth(max)));
}

// Where a key pressed on a calendar's day goes: a day or a week with the arrows, the week's ends with Home and End, a
// month with Page Up and Page Down (a year with Shift), to the same date or the month's last. null for other keys.
export function moveDay(day, { key, shiftKey = false }, { min = null, max = null } = {}) {
	let next = null;
	if (KEY_DAYS[key]) next = addDays(day, KEY_DAYS[key]);
	else if (key === "Home") next = addDays(day, -day.getDay());
	else if (key === "End") next = addDays(day, 6 - day.getDay());
	else if (key === "PageUp" || key === "PageDown") {
		const month = addMonths(day, (key === "PageUp" ? -1 : 1) * (shiftKey ? 12 : 1));
		const lastDate = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
		next = new Date(month.getFullYear(), month.getMonth(), Math.min(day.getDate(), lastDate));
	}
	return next && clampDay(next, min, max);
}
