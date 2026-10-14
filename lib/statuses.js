export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "paused", "sent", "canceled"];
export const CONTACT_STATUSES = ["active", "pending", "unsubscribed", "bounced", "complained", "dormant"];
// held: a first send's contacts past its first slice (lib/first-send.js). sending/ambiguous: claimed before the
// provider call, and a call that never answered (never resent; reconciled from provider events).
export const MESSAGE_STATUSES = ["held", "queued", "sending", "ambiguous", "sent", "delivered", "bounced", "complained", "failed", "suppressed"];
