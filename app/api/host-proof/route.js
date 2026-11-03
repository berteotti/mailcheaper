import { getHostProof } from "@/lib/host-proof";

export const dynamic = "force-dynamic";

// Checked by a domain check on the host it was asked for (lib/host-check.js): the answer shows the host reaches this server.
export function GET(request) {
	return new Response(getHostProof(new URL(request.url).hostname), {
		headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
	});
}
