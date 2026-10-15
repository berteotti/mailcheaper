import { requestRevalidation } from "../../lib/app-revalidation.js";

// The jobs Worker's next/cache (alchemy.run.ts aliases it). Pages are cached by the app Worker, so a refresh asked
// for here goes to it through the APP service binding; the app refreshes the archive pages.
export function revalidatePath() {
	return requestRevalidation({ archive: true });
}

export function revalidateTag() {
	return requestRevalidation({ archive: true });
}

export function unstable_cache(run) {
	return run;
}
