import { cn } from "@/lib/utils";

export default function BadgeMethod({ method, className }) {
	return (
		<span
			className={cn(
				"inline-flex h-5 shrink-0 items-center rounded-md px-1.5 font-mono text-[10.5px] font-semibold tracking-wider",
				METHOD_TONES[method],
				className
			)}
		>
			{method}
		</span>
	);
}

const METHOD_TONES = {
	GET: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	POST: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
	PATCH: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
	DELETE: "bg-red-500/10 text-red-700 dark:text-red-400",
};
