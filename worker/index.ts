import handler from "vinext/server/fetch-handler";
import { SECURITY_HEADERS } from "../next.config.mjs";

// Hosted here and bound into the jobs Worker, which depends on this one (alchemy.run.ts).
export { RateLimiter, SesPacer } from "./durable-objects.js";

function isLocalHost(hostname: string) {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

const app = {
	async fetch(request: Request, env: unknown, ctx: unknown) {
		// Sessions and signed links only work over https (the session cookie is Secure), so plain http is
		// redirected, apart from local development.
		const url = new URL(request.url);
		if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
			url.protocol = "https:";
			return Response.redirect(url.toString(), 301);
		}
		const result = await handler.fetch(request, env, ctx);
		const response = new Response(result.body, result);
		for (const { key, value } of SECURITY_HEADERS) response.headers.set(key, value);
		return response;
	},
};

export default app;
export const env = {};
