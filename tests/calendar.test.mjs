import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CalendarMonth from "../components/CalendarMonth.jsx";
import InputDate from "../components/InputDate.jsx";
import { fromDayKey, moveDay, toDayKey } from "../lib/calendar.js";

// The overview's custom range picks its days on MailCheap's calendar, which takes and gives YYYY-MM-DD keys.

test("a day key names one real day, and comes back the same", () => {
	assert.equal(toDayKey(fromDayKey("1991-04-12")), "1991-04-12");
	assert.equal(toDayKey(fromDayKey("2028-02-29")), "2028-02-29");
	assert.equal(toDayKey(new Date(2026, 9, 21, 23, 59)), "2026-10-21", "the local day, whatever the time");
	for (const key of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-1-5", "10/21/2026", "2026-10-21T00:00:00Z", "", null, undefined]) {
		assert.equal(fromDayKey(key), null, String(key));
	}
});

test("the keyboard moves through a calendar by days, weeks and months, never past the days it can pick", () => {
	const at = (key, press, range) => toDayKey(moveDay(fromDayKey(key), press, range));
	assert.equal(at("2026-10-31", { key: "ArrowRight" }), "2026-11-01");
	assert.equal(at("2026-10-01", { key: "ArrowUp" }), "2026-09-24");
	assert.equal(at("2026-10-21", { key: "Home" }), "2026-10-18", "the week's Sunday");
	assert.equal(at("2026-10-21", { key: "End" }), "2026-10-24");
	assert.equal(at("2027-01-31", { key: "PageDown" }), "2027-02-28", "the month's last day when it's shorter");
	assert.equal(at("2028-02-29", { key: "PageUp", shiftKey: true }), "2027-02-28", "a year with Shift");

	const range = { min: fromDayKey("2026-10-22"), max: fromDayKey("2026-11-05") };
	assert.equal(at("2026-10-23", { key: "ArrowUp" }, range), "2026-10-22");
	assert.equal(at("2026-11-01", { key: "PageDown" }, range), "2026-11-05");
	assert.equal(moveDay(fromDayKey("2026-10-21"), { key: "Enter" }), null, "Enter picks the day, it doesn't move");
});

test("the calendar opens on the day picked, marks it, and can't pick or reach the days out of range", () => {
	const html = renderToStaticMarkup(
		createElement(CalendarMonth, { selected: fromDayKey("2030-05-15"), min: fromDayKey("2030-05-10"), max: fromDayKey("2030-06-20"), onSelect() {} })
	);
	const day = (key) => new RegExp(`<button type="button" data-day="${key}"[^>]*>`).exec(html)?.[0] ?? "";

	assert.match(html, />May<\/span>/);
	assert.match(html, />2030<\/span>/);
	assert.match(day("2030-05-09"), /disabled=""/);
	assert.doesNotMatch(day("2030-05-10"), /disabled=""/);
	assert.match(day("2030-05-15"), /tabindex="0"/);
	assert.match(day("2030-05-15"), /aria-label="Wednesday, May 15, 2030, selected"/);
	assert.equal(html.match(/data-day="[\d-]+" tabindex="0"/g)?.length, 1, "one day for Tab, the arrows move it");
	assert.match(day("2030-04-30"), /disabled=""/, "April's last days fill the first week, out of range");
	assert.match(day("2030-06-01"), /tabindex="-1"/, "June's first days fill the last weeks");
	assert.doesNotMatch(day("2030-06-01"), /disabled=""|selected/);

	assert.match(html, /aria-label="Previous month" disabled=""/, "May is the first month with a day to pick");
	assert.match(html, /aria-label="Next month">/);
	assert.match(html, /disabled="">Today<\/button>/, "today is out of range");
	assert.equal(html.match(/role="row"/g)?.length, 7, "the weekdays and six weeks, whatever the month");
});

test("a date field shows its day, or asks for one", () => {
	const html = renderToStaticMarkup(createElement(InputDate, { value: "2026-10-21", onChange() {} }));
	assert.match(html, /role="combobox"/);
	assert.match(html, />Oct 21, 2026<\/span>/);
	assert.match(renderToStaticMarkup(createElement(InputDate, { value: "", onChange() {} })), />Pick a date<\/span>/);
});
