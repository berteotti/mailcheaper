import { newsreader } from "@/lib/fonts";
import { cn } from "@/lib/utils";

// Sign-in and the newsletter setup: what to fill in on the left and, on large screens with an aside, what it's
// for on the right, on a quieter panel. --panel is the panel's color, for fades over its edges.
export default function LayoutSplit({ aside, children }) {
	return (
		<main className={cn(newsreader.variable, "grid min-h-dvh", aside && "lg:grid-cols-2")}>
			<div className="flex min-w-0 flex-col px-5 py-5 sm:px-8 sm:py-6 lg:px-12">{children}</div>
			{aside && (
				<aside
					aria-hidden="true"
					className="relative hidden overflow-hidden border-l border-border/60 bg-(--panel) [--panel:color-mix(in_oklab,var(--muted)_70%,var(--background))] lg:block"
				>
					{aside}
				</aside>
			)}
		</main>
	);
}
