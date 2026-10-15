import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, idInput, toIso } from "@/lib/actions/shared";
import { notifyActivity } from "@/lib/alerts";
import { API_KEY_LEVELS } from "@/lib/api-key-tokens";
import { generateApiKey, getKeyLevel, listApiKeys } from "@/lib/api-keys";
import { getAppUrl } from "@/lib/config";
import { getOne, getValue } from "@/lib/db";
import { insertRow, updateRows } from "@/lib/records";
import { isObjectIdString } from "@/lib/validation";

const GROUP = "API keys";
// Each key has requests a minute of its own (lib/api/rest.js), and keys can create keys.
export const MAX_ACTIVE_API_KEYS = 20;

const ApiKeySchema = z.object({
	id: z.string(),
	name: z.string(),
	prefix: z.string().describe("The key's first characters, to tell keys apart"),
	level: z.enum(API_KEY_LEVELS).describe("full: everything. signups: only add_contact."),
	createdAt: dateOutput,
	lastUsedAt: dateOutput,
	revokedAt: dateOutput,
	isCurrent: z.boolean().describe("The key making this request"),
});

function toApiKey(apiKey, currentKey) {
	return {
		id: String(apiKey._id),
		name: apiKey.name,
		prefix: apiKey.prefix,
		level: getKeyLevel(apiKey),
		createdAt: toIso(apiKey.createdAt),
		lastUsedAt: toIso(apiKey.lastUsedAt),
		revokedAt: toIso(apiKey.revokedAt),
		isCurrent: Boolean(currentKey) && String(currentKey._id) === String(apiKey._id),
	};
}

export const apiKeyActions = [
	defineAction({
		name: "list_api_keys",
		tryWithoutPlan: true,
		title: "List API keys",
		group: GROUP,
		description: "Lists the account's API keys, revoked ones included, with their level and when they were last used. Keys themselves are never shown again.",
		http: { method: "GET", path: "/api-keys" },
		readOnly: true,
		output: z.object({ apiKeys: z.array(ApiKeySchema) }),
		handler: async ({ account, apiKey }) => ({ apiKeys: (await listApiKeys(account)).map((key) => toApiKey(key, apiKey)) }),
	}),
	defineAction({
		name: "create_api_key",
		title: "Create an API key",
		group: GROUP,
		description: `Creates an API key and returns it once; only its hash is stored. full can do everything a full key can, including creating more keys; signups can only add contacts, for keys that end up in website code. An account has up to ${MAX_ACTIVE_API_KEYS} active keys: one more answers conflict until one is revoked.`,
		http: { method: "POST", path: "/api-keys", status: 201 },
		rateLimit: { limit: 10, window: "1 h" },
		example: { name: "Website signups", level: "signups" },
		input: z.object({
			name: z.string().trim().min(1).max(60).describe("What the key is for, e.g. Website signups"),
			level: z.enum(API_KEY_LEVELS).describe("full or signups"),
		}),
		output: z.object({ apiKey: ApiKeySchema, key: z.string().describe("The key. Store it now: it isn't shown again.") }),
		handler: async ({ account, apiKey, input }) => {
			if ((await getValue("SELECT count(*) FROM api_keys WHERE accountId = ? AND revokedAt IS NULL", [account._id])) >= MAX_ACTIVE_API_KEYS) {
				throw actionError("conflict", `An account has up to ${MAX_ACTIVE_API_KEYS} active API keys. Revoke one to create another.`);
			}
			const { key, prefix, hash } = generateApiKey();
			const created = await insertRow("api_keys", { accountId: account._id, name: input.name, level: input.level, prefix, hash });
			await notifyActivity([`API key created: ${input.name} (${input.level})`, `${getAppUrl()}/api-keys`], { accountId: account._id });
			return { apiKey: toApiKey(created, apiKey), key };
		},
	}),
	defineAction({
		name: "revoke_api_key",
		tryWithoutPlan: true,
		title: "Revoke an API key",
		group: GROUP,
		description: "Revokes an API key for good: requests with it answer unauthorized from now on. A key can revoke itself.",
		http: { method: "DELETE", path: "/api-keys/{id}" },
		destructive: true,
		idempotent: true,
		whileBlocked: true,
		input: z.object({ id: idInput("API key") }),
		output: z.object({ id: z.string(), revoked: z.literal(true) }),
		handler: async ({ account, input }) => {
			const existing = isObjectIdString(input.id) ? await getOne("SELECT _id FROM api_keys WHERE accountId = ? AND _id = ?", [account._id, input.id]) : null;
			if (!existing) throw actionError("not_found", "Key not found");
			await updateRows("api_keys", { where: "accountId = ? AND _id = ? AND revokedAt IS NULL", params: [account._id, existing._id] }, { set: { revokedAt: new Date() } });
			return { id: String(existing._id), revoked: true };
		},
	}),
];
