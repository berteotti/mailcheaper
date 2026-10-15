import "server-only";
import { ERROR_CODES, getBlockedMessage, hasActiveSubscription, isBlocked, isDeletionPending } from "@/lib/account-state";
import { canKeyUse } from "@/lib/actions/define-action";
import { ERRORS, actionError, formatIssues } from "@/lib/actions/errors";
import { getAction } from "@/lib/actions/registry";
import { getKeyLevel } from "@/lib/api-keys";
import { getRateLimitOverrides } from "@/lib/config";
import { formatWindow } from "@/lib/format";
import { isRateLimited } from "@/lib/rate-limit";

// The action's limit, or the one RATE_LIMITS sets for it, in the action's window.
export function getActionRateLimit(action) {
	if (!action.rateLimit) return null;
	return { ...action.rateLimit, limit: getRateLimitOverrides().get(action.name) ?? action.rateLimit.limit };
}

// Each API key and connected app counts on its own and against its account, which the dashboard's calls count
// against too (limitDashboard): an account gets an action's limit once, however many keys and apps it has.
function getRateLimits({ action, account, input, via, apiKey, connection }) {
	const rateLimit = getActionRateLimit(action);
	if (!rateLimit) return {};
	const perAccount = { name: `account-${action.name}`, ...rateLimit, key: String(account._id) };
	const caller = apiKey ? String(apiKey._id) : connection && `oauth-${connection.id}`;
	if (caller) return { perCaller: { name: `api-${action.name}`, ...rateLimit, key: caller }, perAccount };
	if (via !== "dashboard") return {};
	const { limitDashboard } = action;
	const counts = typeof limitDashboard === "function" ? limitDashboard(input ?? {}) : limitDashboard;
	return counts ? { perAccount } : {};
}

// "Send a test email" -> "You can send a test email 30 times an hour. Try again later."
function getDashboardLimitMessage(action) {
	const { title } = action;
	const rateLimit = getActionRateLimit(action);
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
	const { perCaller, perAccount } = getRateLimits({ action, account, input, via, apiKey, connection });
	if (perCaller && (await isRateLimited(perCaller))) throw actionError("rate_limited", `Too many ${name} calls, try again later`);
	if (perAccount && (await isRateLimited(perAccount))) {
		throw actionError("rate_limited", via === "dashboard" ? getDashboardLimitMessage(action) : `Too many ${name} calls on this account, try again later`);
	}
	const schema = via === "dashboard" && action.dashboardInput ? action.input.extend(action.dashboardInput.shape) : action.input;
	const parsed = schema.safeParse(input ?? {});
	if (!parsed.success) throw actionError("validation_failed", formatIssues(parsed.error.issues));

	try {
		return await action.handler({ account, input: parsed.data, via, user, apiKey, connection });
	} catch (error) {
		// Workers' logs show a bare stack for some errors, like AWS errors the SDK doesn't model: name them.
		if (!Object.hasOwn(ERRORS, error?.code ?? "")) {
			const status = error?.$metadata ? ` (HTTP ${error.$metadata.httpStatusCode}, request ${error.$metadata.requestId})` : "";
			console.error(`[actions] ${name} failed: ${error?.name}: ${error?.message}${status}`, error);
		}
		throw error;
	}
}
