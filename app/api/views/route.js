import { execute } from "@/lib/db";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { isObjectIdString } from "@/lib/validation";

const BOT_PATTERN = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python|axios|go-http/i;
const RATE_LIMIT = { name: "views", limit: 30, window: "10 m" };

function noContent() {
	return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

// Archive pages send one beacon per issue per browser and day; this only counts the ones from people.
// Only a published issue can be counted, whatever its account.
export async function POST(request) {
	const userAgent = request.headers.get("user-agent") ?? "";
	const { id } = await request.json().catch(() => ({}));
	if (!isObjectIdString(id) || !userAgent || BOT_PATTERN.test(userAgent)) return noContent();
	if (await isRateLimited({ ...RATE_LIMIT, key: getClientIp(request.headers) })) return noContent();

	// By the issue's unique id: views count whatever the account.
	await execute(`UPDATE campaigns SET webViews = webViews + 1, updatedAt = ?
		WHERE _id = lower(?) AND archiveSlug IS NOT NULL AND status IN ('sending', 'paused', 'sent')`, [Date.now(), id]);
	return noContent();
}
