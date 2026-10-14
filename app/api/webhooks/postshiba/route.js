import { handlePostshibaRequest } from "@/lib/postshiba-webhook";

// Deliveries, bounces, spam reports, unsubscribes and drops from every account's PostShiba tenant.
export function POST(request) {
	return handlePostshibaRequest(request);
}
