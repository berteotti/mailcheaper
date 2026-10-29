// What an email came to, the furthest of delivered, opened and clicked, or what stopped it, for a campaign's
// recipients. undelivered: it went out but its inbox never took it, after a soft bounce or a drop, whose error stays on
// the email. sent: on its way, or tried again later.
export const EMAIL_OUTCOMES = ["complained", "bounced", "clicked", "opened", "delivered", "undelivered", "sent", "waiting", "unsent"];

export function getEmailOutcome(email) {
	if (email.complainedAt || email.status === "complained") return "complained";
	if (email.bouncedAt || email.status === "bounced") return "bounced";
	if (email.clickedAt) return "clicked";
	if (email.openedAt) return "opened";
	if (email.deliveredAt || email.status === "delivered") return "delivered";
	if (email.sentAt && email.error) return "undelivered";
	if (email.sentAt || email.status === "sent") return "sent";
	return ["held", "queued"].includes(email.status) ? "waiting" : "unsent";
}
