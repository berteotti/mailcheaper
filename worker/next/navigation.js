// The jobs Worker's next/navigation (alchemy.run.ts aliases it): only pages and server actions redirect, so in a
// job these mean a bug, and they throw like Next.js does.
export function redirect(url) {
	throw Object.assign(new Error(`NEXT_REDIRECT ${url}`), { digest: `NEXT_REDIRECT;replace;${url}` });
}

export function notFound() {
	throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
}
