// Next.js ends a server action or page with a thrown error; tests catch it to read where it went.
export class RedirectError extends Error {
	constructor(url) {
		super(`NEXT_REDIRECT ${url}`);
		this.url = url;
	}
}

export class NotFoundError extends Error {
	constructor() {
		super("NEXT_NOT_FOUND");
	}
}

export function redirect(url) {
	throw new RedirectError(url);
}

export function notFound() {
	throw new NotFoundError();
}
