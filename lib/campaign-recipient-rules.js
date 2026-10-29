// Who a sent campaign went to, by what they did with it, among its emails that went out (lib/campaign-recipients.js).
// unopened: delivered, and neither opened, bounced nor marked as spam. undelivered: no delivery and no hard bounce, so
// still on its way or turned away by their inbox, like a full mailbox. unsubscribed: through this issue
// (messages.unsubscribedAt).
export const RECIPIENT_FILTERS = ["all", "opened", "clicked", "unopened", "undelivered", "bounced", "unsubscribed"];

// Each filter's condition on the campaign's emails.
export const RECIPIENT_MATCHES = {
	all: "1",
	opened: "openedAt IS NOT NULL",
	clicked: "clickedAt IS NOT NULL",
	unopened: "deliveredAt IS NOT NULL AND openedAt IS NULL AND bouncedAt IS NULL AND complainedAt IS NULL",
	undelivered: "deliveredAt IS NULL AND bouncedAt IS NULL",
	bounced: "bouncedAt IS NOT NULL",
	unsubscribed: "unsubscribedAt IS NOT NULL",
};

const countColumn = (filter) => `${filter}Recipients`;

// How many each filter picks among the emails that went out, a column per filter, in a SELECT over the campaign's emails.
export const RECIPIENT_COUNTS_SQL = RECIPIENT_FILTERS.map(
	(filter) => `sum(sentAt IS NOT NULL AND (${RECIPIENT_MATCHES[filter]})) AS ${countColumn(filter)}`
).join(", ");

export function readRecipientFilter(value) {
	return RECIPIENT_FILTERS.includes(value) ? value : "all";
}

// The counts of RECIPIENT_COUNTS_SQL, summed over its rows.
export function toRecipientCounts(rows) {
	return Object.fromEntries(
		RECIPIENT_FILTERS.map((filter) => [filter, rows.reduce((sum, row) => sum + (row?.[countColumn(filter)] ?? 0), 0)])
	);
}
