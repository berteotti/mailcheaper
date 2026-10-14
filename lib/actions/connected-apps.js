import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { dateOutput, idInput, toIso } from "@/lib/actions/shared";
import { listConnectedApps, revokeConnectedApp } from "@/lib/oauth";

const GROUP = "API keys";

const ConnectedAppSchema = z.object({
	id: z.string(),
	name: z.string().describe("The name the app gives itself"),
	host: z.string().nullable().describe("Where the app is: the host of its client ID URL or of its redirect URL"),
	createdAt: dateOutput,
	lastUsedAt: dateOutput,
	isCurrent: z.boolean().describe("The app making this request"),
});

function toConnectedApp(app, connection) {
	return {
		id: app.id,
		name: app.name,
		host: app.host,
		createdAt: toIso(app.createdAt),
		lastUsedAt: toIso(app.lastUsedAt),
		isCurrent: connection?.id === app.id,
	};
}

export const connectedAppActions = [
	defineAction({
		name: "list_connected_apps",
		tryWithoutPlan: true,
		title: "List connected apps",
		group: GROUP,
		description:
			"Lists the apps connected to the account with OAuth, such as ChatGPT, Claude and Grok Bot, with when they were connected and last used. Each one has full access, like a full access API key.",
		http: { method: "GET", path: "/connected-apps" },
		readOnly: true,
		output: z.object({ connectedApps: z.array(ConnectedAppSchema) }),
		handler: async ({ account, connection }) => ({
			connectedApps: (await listConnectedApps(account)).map((app) => toConnectedApp(app, connection)),
		}),
	}),
	defineAction({
		name: "revoke_connected_app",
		tryWithoutPlan: true,
		title: "Disconnect an app",
		group: GROUP,
		description:
			"Disconnects an app connected with OAuth: its tokens stop working at once, and it has to ask for access again to come back. An app can disconnect itself.",
		http: { method: "DELETE", path: "/connected-apps/{id}" },
		destructive: true,
		idempotent: true,
		whileBlocked: true,
		input: z.object({ id: idInput("connected app") }),
		output: z.object({ id: z.string(), revoked: z.literal(true) }),
		handler: async ({ account, input }) => ({ id: await revokeConnectedApp(account, input.id), revoked: true }),
	}),
];
