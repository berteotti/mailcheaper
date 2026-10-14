// Sends are paced per lane by lib/send-rate.js (one SesPacer Durable Object per lane); SES's region lives here.
export { waitForSendSlot } from "./send-rate.js";

export function getSesRegion() {
	return process.env.SES_REGION || process.env.AWS_REGION || "us-east-1";
}
