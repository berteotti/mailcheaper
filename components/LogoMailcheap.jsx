import { cn } from "@/lib/utils";

// A paper plane in two facets. The share images draw the same shapes, so they import these.
export const LOGO_VIEWBOX = "11 9 45 45";
export const LOGO_FACETS = { upper: "M13 31 52 14 31 37Z", lower: "M31 37 52 14 41.5 50Z" };
export const LOGO_SHADE = 0.35;

export default function LogoMailcheap({ className }) {
	return (
		<svg viewBox={LOGO_VIEWBOX} aria-hidden="true" className={cn("size-6 shrink-0 text-foreground", className)}>
			<path d={LOGO_FACETS.upper} fill="currentColor" />
			<path d={LOGO_FACETS.lower} fill="currentColor" fillOpacity={LOGO_SHADE} />
		</svg>
	);
}
