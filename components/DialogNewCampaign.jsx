"use client";

import { useState, useTransition } from "react";
import { ChevronLeft, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { createCampaign, duplicateCampaign } from "@/app/(app)/campaigns/actions";
import { DotStatus, statusLabel } from "@/components/BadgeStatus";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatDate, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

const BLANK = "blank";
const PAGE = "h-[4.25rem] w-[3.25rem] rounded-[5px] bg-background shadow-border";

// New, once the newsletter has campaigns: a blank draft, or a copy of one of them as a new draft. children: the button
// that opens it. campaigns: { id, subject, status, at, thumbnail }, newest first, each thumbnail rendered on
// the server.
export default function DialogNewCampaign({ newsletterId, campaigns, children }) {
	const [isOpen, setIsOpen] = useState(false);
	const [step, setStep] = useState("choose");
	const [pendingId, setPendingId] = useState(null);
	const [isPending, startTransition] = useTransition();

	// Set as it opens rather than as it closes, so the step fading out keeps its content.
	function changeOpen(next) {
		if (next) setStep("choose");
		setIsOpen(next);
	}

	function start(id) {
		setPendingId(id);
		startTransition(async () => {
			const result = id === BLANK ? await createCampaign(newsletterId) : await duplicateCampaign(id);
			if (result?.error) toast.error(result.error);
		});
	}

	const isStarting = (id) => isPending && pendingId === id;

	return (
		<Dialog open={isOpen} onOpenChange={changeOpen}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent aria-describedby={undefined} className="sm:max-w-md">
				{step === "copy" ? (
					<div className="grid gap-3 animate-fade-in">
						<DialogHeader className="flex-row items-center gap-1">
							<Button variant="ghost" size="icon-sm" aria-label="Back" onClick={() => setStep("back")} className="-ml-1.5">
								<ChevronLeft />
							</Button>
							<DialogTitle>Copy a campaign</DialogTitle>
						</DialogHeader>
						<ul className="-mx-2 max-h-[min(22rem,55dvh)] overflow-y-auto overscroll-contain [scrollbar-width:thin]">
							{campaigns.map((campaign, index) => (
								<li key={campaign.id}>
									<OptionCampaign
										campaign={campaign}
										autoFocus={index === 0}
										isStarting={isStarting(campaign.id)}
										isDimmed={isPending && !isStarting(campaign.id)}
										isDisabled={isPending}
										onPick={() => start(campaign.id)}
									/>
								</li>
							))}
						</ul>
					</div>
				) : (
					<div className={cn("grid gap-4", step === "back" && "animate-fade-in")}>
						<DialogHeader>
							<DialogTitle>New campaign</DialogTitle>
						</DialogHeader>
						<div className="grid grid-cols-2 gap-2">
							<TileStart title="Blank" isStarting={isStarting(BLANK)} isDisabled={isPending} onPick={() => start(BLANK)}>
								<span className={cn(PAGE, "grid place-items-center transition-[translate] duration-200 ease-out group-hover:-translate-y-0.5")}>
									<Plus className="size-4 text-muted-foreground transition-colors duration-150 group-hover:text-foreground" />
								</span>
							</TileStart>
							<TileStart
								title="Copy a campaign"
								autoFocus={step === "back"}
								isDimmed={isPending}
								isDisabled={isPending}
								onPick={() => setStep("copy")}
							>
								<span className="relative h-[4.25rem] w-[3.25rem]">
									<span
										className={cn(
											PAGE,
											"absolute inset-0 -translate-x-1.5 -rotate-6 transition-[translate,rotate] duration-200 ease-out group-hover:-translate-x-2.5 group-hover:-rotate-10"
										)}
									/>
									<span
										className={cn(
											PAGE,
											"absolute inset-0 flex flex-col gap-1 p-1.5 transition-[translate,rotate] duration-200 ease-out group-hover:-translate-y-0.5 group-hover:rotate-2"
										)}
									>
										<span className="mb-0.5 h-3.5 rounded-[2px] bg-foreground/10" />
										<span className="h-1 rounded-full bg-foreground/15" />
										<span className="h-1 w-4/5 rounded-full bg-foreground/15" />
										<span className="h-1 w-3/5 rounded-full bg-foreground/15" />
									</span>
								</span>
							</TileStart>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function TileStart({ title, autoFocus = false, isStarting = false, isDimmed = false, isDisabled, onPick, children }) {
	return (
		<button
			type="button"
			autoFocus={autoFocus}
			disabled={isDisabled}
			aria-busy={isStarting || undefined}
			onClick={onPick}
			className={cn(
				"group flex flex-col gap-2.5 rounded-xl p-1.5 pb-3 outline-none shadow-border transition-[box-shadow,scale,opacity] duration-150 ease-out hover:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.98] disabled:pointer-events-none",
				isDimmed && "opacity-50"
			)}
		>
			<span aria-hidden="true" className="grid aspect-[4/3] place-items-center rounded-md bg-muted/60">
				{children}
			</span>
			<span className="flex items-center justify-center gap-1.5 text-sm font-medium">
				{title}
				{isStarting && <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />}
			</span>
		</button>
	);
}

function OptionCampaign({ campaign, autoFocus, isStarting, isDimmed, isDisabled, onPick }) {
	const { subject, status, at, thumbnail } = campaign;

	return (
		<button
			type="button"
			autoFocus={autoFocus}
			disabled={isDisabled}
			aria-busy={isStarting || undefined}
			onClick={onPick}
			className={cn(
				"flex w-full items-center gap-3 rounded-lg p-2 text-left outline-none transition-[background-color,opacity] duration-150 hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset disabled:pointer-events-none",
				isDimmed && "opacity-50"
			)}
		>
			{thumbnail}
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm font-medium">{subject || "Untitled"}</span>
				<span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
					<DotStatus status={status} />
					<span className="truncate">
						{statusLabel(status)}
						{at && ` · ${status === "draft" ? formatRelative(at) : formatDate(at)}`}
					</span>
				</span>
			</span>
			{isStarting && <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin text-muted-foreground" />}
		</button>
	);
}
