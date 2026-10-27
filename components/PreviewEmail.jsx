"use client";

import { useEffect, useRef, useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import { fillMergeTags } from "@/lib/merge-tags";
import { cn } from "@/lib/utils";

// fit="fill" stretches to the parent's height (editor); fit="content" grows to the email (report).
export default function PreviewEmail({
	html,
	toolbar,
	sender,
	subject,
	previewText,
	fit = "fill",
	className,
}) {
	const [device, setDevice] = useState("desktop");
	const [contentHeight, setContentHeight] = useState(null);
	const frameRef = useRef(null);
	const isContentFit = fit === "content";

	useEffect(() => {
		if (!isContentFit) return;
		const frame = frameRef.current;
		// Measured after the width transition, since the email reflows at each width.
		const timeout = setTimeout(() => {
			const root = frame?.contentDocument?.documentElement;
			if (root) setContentHeight(root.scrollHeight);
		}, 350);
		return () => clearTimeout(timeout);
	}, [device, isContentFit]);

	return (
		<div className={cn("flex flex-col overflow-hidden rounded-xl bg-card shadow-border", className)}>
			<div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/60 pr-3 pl-2">
				<div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
					{DEVICES.map(({ id, label, icon: Icon }) => (
						<button
							key={id}
							type="button"
							aria-label={label}
							aria-pressed={device === id}
							onClick={() => {
								setDevice(id);
								if (isContentFit) setContentHeight(null);
							}}
							className={cn(
								"relative grid size-7 place-items-center rounded-md text-muted-foreground transition-[color,background-color,box-shadow] duration-150 after:absolute after:-inset-1 hover:text-foreground",
								device === id && "bg-background text-foreground shadow-border"
							)}
						>
							<Icon className="size-3.5" />
						</button>
					))}
				</div>
				{toolbar}
			</div>

			{sender && (
				<div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-3">
					<AvatarNewsletter newsletter={sender} size={40} className="rounded-full" />
					<div className="min-w-0 flex-1 text-sm">
						<p className="truncate">
							<span className="font-semibold">{sender.fromName || sender.name}</span>{" "}
							<span className="text-muted-foreground">&lt;{sender.fromEmail}&gt;</span>
						</p>
						<p className="truncate">
							<span className="font-medium">{fillMergeTags(subject) || "No subject"}</span>
							{previewText && <span className="text-muted-foreground"> — {fillMergeTags(previewText)}</span>}
						</p>
					</div>
				</div>
			)}

			<div className="flex min-h-0 flex-1 justify-center bg-muted/50 p-3 sm:p-5">
				<iframe
					ref={frameRef}
					title="Email preview"
					// Same origin lets the report read the email's height; without allow-scripts nothing in it runs.
					sandbox={isContentFit ? "allow-same-origin" : ""}
					srcDoc={html}
					onLoad={(event) => {
						if (!isContentFit) return;
						const root = event.currentTarget.contentDocument?.documentElement;
						if (root) setContentHeight(root.scrollHeight);
					}}
					style={isContentFit ? { height: contentHeight ?? 640 } : undefined}
					className={cn(
						"max-w-full rounded-lg bg-white shadow-border transition-[width] duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
						isContentFit ? "min-h-96" : "h-[640px] lg:h-full",
						device === "mobile" ? "w-[375px]" : "w-full max-w-[760px]"
					)}
				/>
			</div>
		</div>
	);
}

const DEVICES = [
	{ id: "desktop", label: "Desktop", icon: Monitor },
	{ id: "mobile", label: "Mobile", icon: Smartphone },
];
