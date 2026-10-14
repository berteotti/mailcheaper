import AvatarUser from "@/components/AvatarUser";
import IconBrand from "@/components/IconBrand";
import { cn } from "@/lib/utils";

// The setup's right side: the newsletter's first issue in a Gmail inbox and opened, filled in as the form is,
// from the user's picture (image). activeField marks what the current question changes.
export default function PreviewNewsletter({ name, description, fromName, image, address, activeField }) {
	const title = name || "Your newsletter";
	const sender = fromName || name || "Your name";

	return (
		<div className="absolute inset-0 flex flex-col justify-center px-12 xl:px-20">
			<p className="text-sm font-medium text-muted-foreground">Your first issue, as readers get it</p>
			<div className="mt-5 w-full max-w-[34rem]">
				<div className="overflow-hidden rounded-2xl bg-card shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_24px_48px_-28px_rgb(0_0_0/0.25)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.07)]">
					<p className="flex items-center justify-between border-b border-border/60 px-4 py-2.5 text-[12px] font-medium">
						<span className="flex items-center gap-2">
							<IconBrand brand="gmail" className="size-6" />
							Inbox
						</span>
						<span className="text-muted-foreground tabular-nums">3</span>
					</p>
					<ul className="divide-y divide-border/60">
						<li className="flex items-start gap-3 px-4 py-3.5">
							<AvatarUser name={sender} image={image} size={36} />
							<div className="min-w-0 flex-1">
								<p className="flex items-baseline justify-between gap-3">
									<Mark isActive={activeField === "fromName"} isEmpty={!fromName && !name} className="truncate text-[13px] font-semibold">
										{sender}
									</Mark>
									<span className="shrink-0 text-[11px] text-muted-foreground">9:00 AM</span>
								</p>
								<p className="truncate text-[13px] font-medium">
									The first issue of{" "}
									<Mark isActive={activeField === "name"} isEmpty={!name}>
										{title}
									</Mark>
								</p>
								<p className="truncate text-[12px] text-muted-foreground">
									<Mark isActive={activeField === "description"} isEmpty={!description}>
										{description || "What it's about, in one line"}
									</Mark>
								</p>
							</div>
						</li>
						{[0.62, 0.48].map((width) => (
							<li key={width} className="flex items-center gap-3 px-4 py-3.5 opacity-60">
								<span className="size-9 shrink-0 rounded-full bg-muted" />
								<span className="flex flex-1 flex-col gap-2">
									<span style={{ width: `${width * 60}%` }} className="h-2 rounded-full bg-muted" />
									<span style={{ width: `${width * 100}%` }} className="h-2 rounded-full bg-muted" />
								</span>
							</li>
						))}
					</ul>
				</div>

				<article className="relative -mt-3 ml-10 rounded-2xl bg-card p-6 shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_32px_64px_-28px_rgb(0_0_0/0.3)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_32px_64px_-28px_rgb(0_0_0/0.9)]">
					<div className="flex items-center gap-3 border-b border-border/60 pb-4">
						<AvatarUser name={sender} image={image} size={32} />
						<div className="min-w-0 text-[12px] leading-5">
							<Mark isActive={activeField === "fromName"} isEmpty={!fromName && !name} className="block truncate font-medium">
								{sender}
							</Mark>
							<span className="block truncate text-muted-foreground">{address}</span>
						</div>
					</div>
					<h2 className="mt-5 font-display text-[1.9rem] leading-[1.1] font-[480] tracking-[-0.025em] text-balance">
						<Mark isActive={activeField === "name"} isEmpty={!name}>
							{title}
						</Mark>
					</h2>
					<p className="mt-2 text-[14px] leading-6 text-pretty text-muted-foreground">
						<Mark isActive={activeField === "description"} isEmpty={!description}>
							{description || "What it's about, in one line"}
						</Mark>
					</p>
					<div className="mt-5 flex flex-col gap-2.5">
						{[1, 0.94, 0.72].map((width) => (
							<span key={width} style={{ width: `${width * 100}%` }} className="h-2 rounded-full bg-muted" />
						))}
					</div>
					<p className="mt-6 text-[11px] text-muted-foreground">
						Unsubscribe · <Mark isEmpty={!name}>{title}</Mark>
					</p>
				</article>
			</div>
		</div>
	);
}

function Mark({ isActive, isEmpty, className, children }) {
	return (
		<span
			className={cn(
				"rounded-[4px] box-decoration-clone transition-[background-color,box-shadow,color] duration-200",
				isActive && "bg-foreground/[0.06] shadow-[0_0_0_3px_color-mix(in_oklab,var(--foreground)_6%,transparent)]",
				isEmpty && "text-muted-foreground/70",
				className
			)}
		>
			{children}
		</span>
	);
}
