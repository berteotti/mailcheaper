import { formatRate, judgeRates } from "./rate-levels.js";

// Contacts this account never emailed go out in steps: a slice first, then a check of its bounces and
// complaints 3 hours after it, then the rest. A bought or scraped list shows itself in the slice, before it costs
// the sending reputation every other customer shares.
export const FIRST_SEND = { share: 0.05, minSlice: 200, maxSlice: 2000, waitMinutes: 180, recheckMinutes: 10 };

// Every never-mailed contact goes at once when there are no more than the smallest slice.
export function getFirstSendSlice(neverMailed) {
	const slice = Math.min(FIRST_SEND.maxSlice, Math.max(FIRST_SEND.minSlice, Math.round(neverMailed * FIRST_SEND.share)));
	return neverMailed > slice ? slice : null;
}

// The slice's rates over its sent emails, at a campaign's levels (lib/rate-levels.js): { level, reason } or null.
// block: the account is blocked with reason. pause: the rest of the campaign waits for its owner.
export function getFirstSendProblem({ sent = 0, bounced = 0, complained = 0 }) {
	const judged = judgeRates({ sent, bounced, complained });
	if (!judged) return null;
	const rate = `${judged.metric} rate of ${formatRate(judged.rate)} (limit ${formatRate(judged.limit)})`;
	return { level: judged.level, reason: `The first ${sent} new contacts had a ${rate}` };
}
