import "server-only";
import { getPathParams } from "@/lib/actions/define-action";
import { ERRORS } from "@/lib/actions/errors";
import { ACTIONS, ACTION_GROUPS } from "@/lib/actions/registry";
import { API_BASE_PATH } from "@/lib/api/rest";
import { GROUP_DESCRIPTIONS, toJsonSchema } from "@/lib/docs/reference";

const ERROR_RESPONSE = { $ref: "#/components/responses/Error" };

function toOperation(action) {
	const input = toJsonSchema(action.input, "input");
	const pathParams = getPathParams(action.http.path);
	const required = new Set(input.required ?? []);
	const fields = Object.entries(input.properties ?? {}).filter(([name]) => !pathParams.includes(name));
	const isQuery = ["GET", "DELETE"].includes(action.http.method);
	const output = { "application/json": { schema: toJsonSchema(action.output, "output") } };
	const statuses = typeof action.http.status === "function" ? [200, 201] : [action.http.status];

	return {
		operationId: action.name,
		summary: action.title,
		description: action.description,
		tags: [action.group],
		"x-mcp-tool": action.name,
		"x-key-levels": action.permission === "signups" ? ["full", "signups"] : ["full"],
		"x-mcp-annotations": {
			readOnlyHint: action.readOnly,
			destructiveHint: action.destructive,
			idempotentHint: action.idempotent,
			openWorldHint: action.openWorld,
		},
		parameters: [
			...pathParams.map((name) => ({
				name,
				in: "path",
				required: true,
				description: input.properties[name]?.description,
				schema: input.properties[name],
			})),
			...(isQuery
				? fields.map(([name, schema]) => ({ name, in: "query", required: required.has(name), description: schema.description, schema }))
				: []),
		],
		...(!isQuery &&
			fields.length > 0 && {
				requestBody: {
					required: fields.some(([name]) => required.has(name)),
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: Object.fromEntries(fields),
								required: fields.map(([name]) => name).filter((name) => required.has(name)),
							},
							...(Object.keys(action.example).length > 0 && { example: action.example }),
						},
					},
				},
			}),
		responses: {
			...Object.fromEntries(statuses.map((status) => [status, { description: status === 201 ? "Created" : "OK", content: output }])),
			default: ERROR_RESPONSE,
		},
	};
}

// OpenAPI 3.1 from the actions' zod schemas: JSON Schema 2020-12, which 3.1 uses as is.
export function getOpenApiDocument(appUrl) {
	const paths = {};
	for (const action of ACTIONS) {
		paths[action.http.path] ??= {};
		paths[action.http.path][action.http.method.toLowerCase()] = toOperation(action);
	}
	return {
		openapi: "3.1.0",
		info: {
			title: "MailCheap API",
			version: "1.0.0",
			description:
				"Everything a MailCheap customer does in the dashboard, over HTTP. Each operation is also a tool of the MCP server at /mcp, named after its operationId. Errors answer { error: { code, message } }.",
		},
		servers: [{ url: `${appUrl}${API_BASE_PATH}` }],
		security: [{ apiKey: [] }],
		tags: ACTION_GROUPS.map((name) => ({ name, description: GROUP_DESCRIPTIONS[name] })),
		paths,
		components: {
			securitySchemes: {
				apiKey: {
					type: "http",
					scheme: "bearer",
					description: "An API key from the dashboard's API keys page: Authorization: Bearer mc_…",
				},
			},
			schemas: {
				Error: {
					type: "object",
					properties: {
						error: {
							type: "object",
							properties: {
								code: { type: "string", enum: Object.keys(ERRORS) },
								message: { type: "string" },
							},
							required: ["code", "message"],
						},
					},
					required: ["error"],
				},
			},
			responses: {
				Error: {
					description: Object.entries(ERRORS)
						.map(([code, { status, description }]) => `${status} ${code}: ${description}`)
						.join("\n"),
					content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
				},
			},
		},
	};
}
