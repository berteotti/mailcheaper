import "server-only";
import { ERROR_CODES, getBlockedMessage, hasActiveSubscription, isBlocked, isDeletionPending } from "@/lib/account-state";
import { canKeyUse } from "@/lib/actions/define-action";
import { ERRORS, actionError, formatIssues } from "@/lib/actions/errors";
import { getAction } from "@/lib/actions/registry";
import { getKeyLevel } from "@/lib/api-keys";
import { formatWindow } from "@/lib/format";
import { isRateLimited } from "@/lib/rate-limit";

// API keys and connected apps count on their own; the dashboard counts per account (limitDashboard).
function getRateLimit({ action, account, input, via, apiKey, connection }) {
	if (!action.rateLimit) return null;
	const limit = { name: `api-${action.name}`, ...action.rateLimit };
	if (apiKey) return { ...limit, key: String(apiKey._id) };
	if (connection) return { ...limit, key: `oauth-${connection.id}` };
	if (via !== "dashboard") return null;
	const { limitDashboard } = action;
	const counts = typeof limitDashboard === "function" ? limitDashboard(input ?? {}) : limitDashboard;
	return counts ? { ...limit, name: `dashboard-${action.name}`, key: String(account._id) } : null;
}

// "Send a test email" -> "You can send a test email 30 times an hour. Try again later."
function getDashboardLimitMessage({ title, rateLimit }) {
	return `You can ${title[0].toLowerCase()}${title.slice(1)} ${rateLimit.limit} times ${formatWindow(rateLimit.window)}. Try again later.`;
}

// The one way in for the dashboard (via "dashboard", a signed-in user), the REST API ("api") and MCP
// ("mcp"), with an API key or, on MCP, an app connected with OAuth (connection, full access, with its user).
// Same permission, plan, rate limit and input checks for all of them. Throws errors with a code from
// lib/actions/errors.js.
export async function runAction(name, { account, input = {}, via, user = null, apiKey = null, connection = null }) {
	const action = getAction(name);
	if (!action) throw actionError("not_found", `There's no ${name} action`);
	if (isDeletionPending(account)) throw actionError("unauthorized", "This account is being deleted");
	if (apiKey && !canKeyUse(getKeyLevel(apiKey), action)) {
		throw actionError("forbidden", `This key can only add contacts: ${name} needs a full access key`);
	}
	if (isBlocked(account) && !action.whileBlocked) throw actionError(ERROR_CODES.accountBlocked, getBlockedMessage(account));
	const isTrial = via === "dashboard" && action.tryWithoutPlan;
	if (action.requiresPlan && !isTrial && !hasActiveSubscription(account)) {
		throw actionError(ERROR_CODES.subscriptionRequired, "The account has no active plan");
	}
	const limit = getRateLimit({ action, account, input, via, apiKey, connection });
	if (limit && (await isRateLimited(limit))) {
		throw actionError("rate_limited", via === "dashboard" ? getDashboardLimitMessage(action) : `Too many ${name} calls, try again later`);
	}
	const schema = via === "dashboard" && action.dashboardInput ? action.input.extend(action.dashboardInput.shape) : action.input;
	const parsed = schema.safeParse(input ?? {});
	if (!parsed.success) throw actionError("validation_failed", formatIssues(parsed.error.issues));

	try {
		return await action.handler({ account, input: parsed.data, via, user, apiKey, connection });
	} catch (error) {
		if (!Object.hasOwn(ERRORS, error?.code ?? "")) console.error(`[actions] ${name} failed:`, error);
		throw error;
	}
}
