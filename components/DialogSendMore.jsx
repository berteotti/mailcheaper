"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { sendCampaignToMore } from "@/app/(app)/campaigns/actions";
import InputAudienceLimit, { countRecipients } from "@/components/InputAudienceLimit";
import ListCleanupPreview from "@/components/ListCleanupPreview";
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
import { summarizePreview } from "@/lib/cleanup";
import { formatCount, formatNumber } from "@/lib/format";
import { useToastError } from "@/lib/use-toast-error";
import { useCleanupPreview } from "@/lib/use-cleanup-preview";

export default function DialogSendMore({ campaignId, sentCount, remainingCount, emailsLeft, isCleanupEnabled }) {
	const router = useRouter();
	const toastError = useToastError();
	const [isOpen, setIsOpen] = useState(false);
	const [more, setMore] = useState("");
	const [isSending, startSending] = useTransition();
	const { preview, isCounting, loadPreview } = useCleanupPreview(campaignId);
	const moreNumber = Number.parseInt(more, 10);
	// The step reaches the top (sent so far + more) of the audience, like the send itself.
	const summary = preview?.enabled ? summarizePreview(preview, moreNumber > 0 ? sentCount + moreNumber : undefined) : null;
	const remaining = preview?.enabled ? Math.max(0, preview.issue - sentCount) : remainingCount;
	const recipients = countRecipients(more, remaining);
	const emails = recipients + (summary?.lastChance ?? 0);
	const isOverPlan = emailsLeft !== null && emails > emailsLeft;

	function changeOpen(nextIsOpen) {
		if (nextIsOpen && isCleanupEnabled) loadPreview();
		setIsOpen(nextIsOpen);
	}

	function send() {
		startSending(async () => {
			const result = await sendCampaignToMore(campaignId, { additional: Number.parseInt(more, 10) || undefined });
			if (result?.error) return toastError(result);
			setIsOpen(false);
			setMore("");
			toast.success("Next step started");
			router.refresh();
		});
	}

	return (
		<Dialog open={isOpen} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button>
					<Send data-icon="inline-start" />
					Send to more
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle className="tabular-nums">Send to {formatCount(recipients, "more contact")}?</DialogTitle>
					<DialogDescription className="tabular-nums">
						{formatNumber(sentCount)} got it so far. The next most engaged contacts get it now, and nobody receives it
						twice.
					</DialogDescription>
				</DialogHeader>
				<InputAudienceLimit label="How many more" value={more} onChange={setMore} audienceCount={remaining} />
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
