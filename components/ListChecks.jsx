import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { cn } from "@/lib/utils";

// onReveal(check): goes to what a check in the content is about (EditorRich's reveal), for the content's warnings and
// its buttons' check. A check that isn't met says why under the pointer.
export default function ListChecks({ checks, onReveal }) {
	return (
		<ul className="grid gap-x-6 gap-y-2.5 rounded-xl bg-card p-4 shadow-border sm:grid-cols-2">
			{checks.map((check) => {
				const { id, label, isOk, isWarning, detail, message } = check;
				const Icon = isOk ? CircleCheck : isWarning ? CircleAlert : CircleX;
				const isRevealable = Boolean(onReveal) && !isOk && (check.field === "content" || id === "buttons");
				const content = (
					<>
						<Icon
							className={cn(
								"size-4 shrink-0",
								isOk ? "text-emerald-500" : isWarning ? "text-amber-500" : "text-red-500"
							)}
						/>
						<span className={cn("truncate", isOk && "text-muted-foreground")}>{label}</span>
						{detail && (
							<span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
								{detail}
							</span>
						)}
					</>
				);
				return (
					<li key={`${id}:${message ?? ""}`} title={isOk ? undefined : message} className="flex min-w-0 items-center gap-2 text-sm">
						{isRevealable ? (
							<button
								type="button"
								onClick={() => onReveal(check)}
								className="-m-1 flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left transition-colors duration-150 hover:bg-muted"
							>
								{content}
							</button>
						) : (
							content
						)}
					</li>
				);
			})}
		</ul>
	);
}
