import "server-only";
import { getHostProof, HOST_PROOF_PATH } from "@/lib/host-proof";

const TIMEOUT_MS = 5000;

// Whether https://<host> answers with this server's proof: its DNS, certificate and routing all lead here. A CNAME
// alone doesn't show it. On Cloudflare, a DNS-only CNAME to the app's custom domain in the same zone resolves to the
// Worker's placeholder address, and a CNAME from anywhere else reaches Cloudflare before anything answers for the host.
export async function isServedHere(host) {
	try {
		const response = await fetch(`https://${host}${HOST_PROOF_PATH}`, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
		return response.ok && (await response.text()) === getHostProof(host);
	} catch {
		return false;
	}
}
