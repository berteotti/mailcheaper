import { useCallback, useSyncExternalStore } from "react";

// Whether the screen matches a media query. False on the server, which can't tell.
export function useMediaQuery(query) {
	const subscribe = useCallback(
		(onChange) => {
			const media = window.matchMedia(query);
			media.addEventListener("change", onChange);
			return () => media.removeEventListener("change", onChange);
		},
		[query]
	);
	return useSyncExternalStore(
		subscribe,
		() => window.matchMedia(query).matches,
		() => false
	);
}
