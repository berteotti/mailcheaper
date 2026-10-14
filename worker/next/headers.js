// The jobs Worker's next/headers (alchemy.run.ts aliases it): a job runs outside any request, as Next.js would
// say, so code that reads the request (activity logs) catches this and carries on.
function outsideRequest(name) {
	throw new Error(`\`${name}\` was called outside a request scope.`);
}

export async function headers() {
	outsideRequest("headers");
}

export async function cookies() {
	outsideRequest("cookies");
}
