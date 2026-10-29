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

// Client components read the route while a test renders them on the server: the home page, no query.
export function usePathname() {
	return "/";
}

export function useSearchParams() {
	return new URLSearchParams();
}

export function useRouter() {
	return { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
}
