import { handleRestPreflight, handleRestRequest } from "@/lib/api/rest";

// Every /api/v1 endpoint: each maps to one action of lib/actions (see lib/api/rest.js).
async function handle(request, { params }) {
	const { path } = await params;
	return handleRestRequest(request, path);
}

export async function OPTIONS(request, { params }) {
	const { path } = await params;
	return handleRestPreflight(request, path);
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST };
