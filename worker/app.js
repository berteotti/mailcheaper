import handler from "vinext/server/fetch-handler";
import { SECURITY_HEADERS } from "../next.config.mjs";

// Hosted here and bound into the jobs Worker, which depends on this one (alchemy.run.ts).
export { RateLimiter, SesPacer } from "./durable-objects.js";

const app = {
	async fetch(request, env, ctx) {
		const result = await handler.fetch(request, env, ctx);
		const response = new Response(result.body, result);
		for (const { key, value } of SECURITY_HEADERS) response.headers.set(key, value);
		return response;
	},
};

export default app;
export const env = {};
