// What a failed send means for MailCheap, whatever the provider said. lib/sending-rules.js turns each into
// an action: retry the batch later, skip the address, pause the campaign or fail the one email.
export const SEND_OUTCOMES = {
	// The provider's capacity or request budget is used up for now: nothing was sent.
	throttled: "throttled",
	// The provider didn't answer or couldn't take it, and nothing was sent.
	unavailable: "unavailable",
	// The provider won't mail this address for the account (a bounce, complaint or unsubscribe it recorded).
	suppressed: "suppressed",
	// The from domain isn't verified, or is paused, at the provider.
	domainUnverified: "domain_unverified",
	// The provider paused the account's tenant. With hold set, its abuse team did, and the account is blocked too.
	tenantPaused: "tenant_paused",
	// The provider hasn't approved production sending yet.
	approvalPending: "approval_pending",
	// MailCheap's own setup at the provider is wrong: a key, a cluster or a credential.
	misconfigured: "misconfigured",
	// This one email can't go.
	failed: "failed",
	// The provider never answered a send it may have taken: it's never sent again, and its events settle it.
	// Such errors also carry ambiguous: true, as do PostShiba's "may have gone out" failures.
	unanswered: "unanswered",
};

export function providerError(outcome, message, fields = {}) {
	return Object.assign(new Error(message), { name: "ProviderError", outcome, ...fields });
}
