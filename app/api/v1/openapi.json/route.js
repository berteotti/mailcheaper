import { getAppUrl } from "@/lib/config";
import { getOpenApiDocument } from "@/lib/docs/openapi";

// Rendered when asked: APP_URL is set where the Worker runs, not where it's built, so a build-time render would
// carry the wrong address.
export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(getOpenApiDocument(getAppUrl()), { headers: { "access-control-allow-origin": "*" } });
}
