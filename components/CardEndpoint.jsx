import { Link2 } from "lucide-react";
import BadgeMethod from "@/components/BadgeMethod";
import BlockCode from "@/components/BlockCode";
import { cn } from "@/lib/utils";

// One endpoint as a spec sheet: what it does and takes on the left, a request to copy on the right.
export default function CardEndpoint({ endpoint }) {
	const hints = HINTS.filter(({ key }) => endpoint.hints[key]);

	return (
		<article id={endpoint.slug} className="scroll-mt-20 border-t border-border/60 py-10 first:border-t-0 first:pt-2">
			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] xl:gap-10">
				<div className="min-w-0">
					<a href={`#${endpoint.slug}`} className="group mb-3 flex w-fit items-center gap-2">
						<h3 className="text-lg font-semibold tracking-tight">{endpoint.title}</h3>
						<Link2 className="size-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
					</a>
					<div className="mb-4 flex flex-wrap items-center gap-2">
						<BadgeMethod method={endpoint.method} />
						<code className="font-mono text-[13px] break-all">
							{endpoint.path.split(/(\{[a-zA-Z]+\})/).map((part, index) =>
								part.startsWith("{") ? (
									<span key={index} className="text-sky-700 dark:text-sky-400">
										{part}
									</span>
								) : (
									part
								)
							)}
						</code>
					</div>
					<p className="text-[15px] leading-7 text-pretty text-foreground/80">{endpoint.description}</p>
					<div className="mt-4 flex flex-wrap gap-1.5 text-xs">
						<Chip label="MCP tool">
							<code className="font-mono">{endpoint.name}</code>
						</Chip>
						<Chip label="Key">{endpoint.level}</Chip>
						{hints.map(({ key, label, tone }) => (
							<Chip key={key} tone={tone}>
								{label}
							</Chip>
						))}
					</div>
					{endpoint.parameters.length > 0 && <TableParameters parameters={endpoint.parameters} />}
				</div>
				<BlockCode code={endpoint.curl} title="Request" className="self-start xl:sticky xl:top-20" />
			</div>
		</article>
	);
}

function Chip({ label, tone, children }) {
	return (
		<span
			className={cn(
				"inline-flex h-6 items-center gap-1.5 rounded-full px-2.5",
				tone === "danger" ? "bg-red-500/10 text-red-700 dark:text-red-400" : "bg-muted text-muted-foreground"
			)}
		>
			{tone === "danger" && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
			{label && <span className="opacity-70">{label}</span>}
			<span className={cn(label && "text-foreground")}>{children}</span>
		</span>
	);
}

function TableParameters({ parameters }) {
	return (
		<div className="mt-6 overflow-hidden rounded-xl shadow-border">
			<table className="w-full text-left text-sm">
				<thead>
					<tr className="border-b border-border/60 text-xs text-muted-foreground">
						<th className="py-2 pl-3.5 font-normal">Parameter</th>
						<th className="hidden py-2 pr-3.5 font-normal sm:table-cell">Description</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-border/60">
					{parameters.map((parameter) => (
						<tr key={`${parameter.in}-${parameter.name}`} className="align-top">
							<td className="py-2.5 pr-3 pl-3.5 sm:w-2/5">
								<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
									<code className={cn("font-mono text-[13px] break-all", parameter.name.includes(".") && "text-foreground/70")}>
										{parameter.name}
									</code>
									{parameter.required && <span className="text-[11px] text-amber-700 dark:text-amber-400">required</span>}
								</div>
								<p className="mt-0.5 font-mono text-[11px] break-words text-muted-foreground">
									{parameter.in} · {parameter.type}
								</p>
								{parameter.description && (
									<p className="mt-1.5 text-[13px] leading-5 text-pretty text-muted-foreground sm:hidden">{parameter.description}</p>
								)}
							</td>
							<td className="hidden py-2.5 pr-3.5 text-[13px] leading-5 text-pretty text-muted-foreground sm:table-cell">
								{parameter.description}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

const HINTS = [
	{ key: "readOnly", label: "Read-only" },
	{ key: "destructive", label: "Can't be undone", tone: "danger" },
	{ key: "idempotent", label: "Safe to repeat" },
	{ key: "openWorld", label: "Reaches outside MailCheap" },
];
