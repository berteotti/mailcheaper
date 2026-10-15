import { revalidatePath } from "next/cache";
import { REVALIDATE_PURPOSE } from "@/lib/app-revalidation";
import { revalidateArchive } from "@/lib/archive-data";
import { isInternalToken } from "@/lib/internal-token";
import { isObjectIdString } from "@/lib/validation";

export const dynamic = "force-dynamic";

// Called by the jobs Worker through its service binding after a scheduled send starts.
export async function POST(request) {
	const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
	if (!isInternalToken(REVALIDATE_PURPOSE, token)) return Response.json({ error: "Unauthorized" }, { status: 401 });

	const body = await request.json().catch(() => null);
	revalidatePath("/campaigns");
	if (isObjectIdString(String(body?.campaignId ?? ""))) revalidatePath(`/campaigns/${body.campaignId}`);
	if (body?.archive) revalidateArchive();
	return Response.json({ ok: true });
}
