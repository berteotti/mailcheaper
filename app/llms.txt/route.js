import { getAppUrl } from "@/lib/config";
import { getLlmsIndex } from "@/lib/docs/llms";

// Rendered when asked: APP_URL is set where the Worker runs, not where it's built, so a build-time render would
// carry the wrong address.
export const dynamic = "force-dynamic";

export function GET() {
	return new Response(getLlmsIndex(getAppUrl()), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
