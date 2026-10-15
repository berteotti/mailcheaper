export const MESSAGE_STATS_FIELDS = {
	sent: "sentAt",
	delivered: "deliveredAt",
	opened: "openedAt",
	clicked: "clickedAt",
	bounced: "bouncedAt",
	complained: "complainedAt",
};

export const MESSAGE_STATS_SQL = Object.entries(MESSAGE_STATS_FIELDS)
	.map(([stat, field]) => `sum(${field} IS NOT NULL) AS ${stat}`).join(", ");
