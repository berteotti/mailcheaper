import { getBindings } from "./db.js";
import { getInternalToken } from "./internal-token.js";

export const REVALIDATE_PURPOSE = "revalidate";

// Pages are cached by the app Worker; work that runs in the jobs Worker asks it to refresh them.
export async function requestRevalidation({ campaignId, archive = false }) {
	const { APP } = await getBindings();
	if (!APP) return;
	try {
		const response = await APP.fetch("https://app.internal/api/internal/revalidate", {
			method: "POST",
			headers: { authorization: `Bearer ${getInternalToken(REVALIDATE_PURPOSE)}`, "content-type": "application/json" },
			body: JSON.stringify({ campaignId, archive }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
	} catch (error) {
		// Pages revalidate on their own within the hour; a failed refresh never fails the job.
		console.error("[jobs] Revalidation failed:", error?.message);
	}
}
