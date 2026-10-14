"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { sendCampaign } from "@/app/(app)/campaigns/actions";
import InputAudienceLimit, { countRecipients } from "@/components/InputAudienceLimit";
import ListCleanupPreview from "@/components/ListCleanupPreview";
import NoticeFirstSend from "@/components/NoticeFirstSend";
import NoticeWarmup from "@/components/NoticeWarmup";
import TextPlanLimit from "@/components/TextPlanLimit";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { summarizePreview } from "@/lib/cleanup";
import { FIRST_SEND } from "@/lib/first-send";
import { formatCount, formatSendTime } from "@/lib/format";
import { useToastError } from "@/lib/use-toast-error";
import { useCleanupPreview } from "@/lib/use-cleanup-preview";

export default function DialogSendCampaign({
	campaignId,
	audienceCount,
	emailsLeft,
	scheduledAt,
	isCleanupEnabled,
	warmup,
	newContacts = 0,
	blockingMessage,
	onBeforeSend,
}) {
	const router = useRouter();
	const toastError = useToastError();
	const [isOpen, setIsOpen] = useState(false);
	const [limit, setLimit] = useState("");
	const [isSending, startSending] = useTransition();
	const { preview, isCounting, loadPreview } = useCleanupPreview(campaignId);
	// With the list cleanup on, cold contacts get the last-chance email instead and don't count.
	const summary = preview?.enabled ? summarizePreview(preview, Number.parseInt(limit, 10)) : null;
	const issueAudience = preview?.enabled ? preview.issue : audienceCount;
	const recipients = summary ? summary.issue : countRecipients(limit, audienceCount);
	const emails = recipients + (summary?.lastChance ?? 0);
	const isOverPlan = emailsLeft !== null && emails > emailsLeft;

	function changeOpen(nextIsOpen) {
		if (nextIsOpen && isCleanupEnabled) loadPreview();
		setIsOpen(nextIsOpen);
	}

	function send() {
		startSending(async () => {
			if (!(await onBeforeSend())) return;
			const result = await sendCampaign(campaignId, { audienceLimit: Number.parseInt(limit, 10) || undefined });
			if (result?.error) return toastError(result);
			setIsOpen(false);
			toast.success("Sending started");
			router.refresh();
		});
	}

	if (blockingMessage) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<span tabIndex={0} className="rounded-lg">
						<Button disabled>
							<Send data-icon="inline-start" />
							Send
						</Button>
					</span>
				</TooltipTrigger>
				<TooltipContent>{blockingMessage}</TooltipContent>
			</Tooltip>
		);
	}

	return (
		<Dialog open={isOpen} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button>
					<Send data-icon="inline-start" />
					Send
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle className="tabular-nums">Send to {formatCount(recipients, "contact")}?</DialogTitle>
					<DialogDescription>
						{scheduledAt
							? `It goes out now instead of ${formatSendTime(scheduledAt)}.`
							: "Most engaged contacts receive it first."}
						{recipients < issueAudience && " Send it to more later from its page."}
					</DialogDescription>
				</DialogHeader>
				{warmup && <NoticeWarmup warmup={warmup} />}
				{newContacts > FIRST_SEND.minSlice && <NoticeFirstSend count={newContacts} />}
				<InputAudienceLimit value={limit} onChange={setLimit} audienceCount={issueAudience} />
				{isCleanupEnabled && <ListCleanupPreview summary={summary} isCounting={isCounting} error={preview?.error} />}
				{isOverPlan && <TextPlanLimit emailsLeft={emailsLeft} />}
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="outline">Cancel</Button>
					</DialogClose>
					<Button onClick={send} disabled={isSending || emails === 0 || isOverPlan} className="min-w-20">
						{isSending ? <Loader2 className="animate-spin" /> : "Send"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
