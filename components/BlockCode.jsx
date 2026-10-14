import ButtonCopy from "@/components/ButtonCopy";
import { cn } from "@/lib/utils";

export default function BlockCode({ code, title, className }) {
	return (
		<figure className={cn("min-w-0 overflow-hidden rounded-xl bg-card shadow-border", className)}>
			<figcaption className="flex h-9 items-center justify-between gap-3 border-b border-border/60 pr-1.5 pl-3.5">
				<span className="truncate font-mono text-[11px] tracking-wide text-muted-foreground">{title}</span>
				<ButtonCopy value={code} label="Copy" />
			</figcaption>
			<pre className="overflow-x-auto p-3.5 font-mono text-[12.5px] leading-[1.7] text-foreground/85">
				<code>{code}</code>
			</pre>
		</figure>
	);
}
