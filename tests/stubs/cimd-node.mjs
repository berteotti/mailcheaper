// Client metadata documents (and their key sets) that the authorization server fetches, served from memory:
// the real transport resolves the host and connects out, which no test does.
export const metadataDocuments = new Map();

export async function fetchClientMetadataResource(input, init) {
	const request = new Request(input, init);
	const document = metadataDocuments.get(request.url);
	if (!document) return new Response("Not found", { status: 404 });
	return Response.json(document, { headers: { "cache-control": "max-age=300" } });
}
