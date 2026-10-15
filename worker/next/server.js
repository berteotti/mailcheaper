// The jobs Worker's next/server (alchemy.run.ts aliases it). Shared modules import it for route handlers and
// after(); a job has no response to finish first, so after() runs the work now.
export function after(task) {
	return Promise.resolve()
		.then(() => (typeof task === "function" ? task() : task))
		.catch((error) => console.error("[jobs] after() failed:", error?.message));
}

export class NextResponse extends Response {
	static json(body, init) {
		return Response.json(body, init);
	}

	static redirect(url, status = 307) {
		return Response.redirect(String(url), status);
	}
}
