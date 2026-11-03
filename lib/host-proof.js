import crypto from "node:crypto";
import { getAppSecret } from "./config.js";

// What a host answers at HOST_PROOF_PATH when its requests reach this server: a signature of the host that only this
// server's secret makes, so a host pointed at another MailCheap, or at nothing, doesn't pass (lib/host-check.js).
export const HOST_PROOF_PATH = "/api/host-proof";

function getProofKey() {
	return Buffer.from(crypto.hkdfSync("sha256", getAppSecret(), "", "mailcheap-host-proof-v1", 32));
}

export function getHostProof(host) {
	const hostname = String(host ?? "")
		.toLowerCase()
		.split(":")[0];
	return crypto.createHmac("sha256", getProofKey()).update(hostname).digest("base64url");
}
