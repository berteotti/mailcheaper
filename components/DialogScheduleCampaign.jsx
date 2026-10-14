"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { scheduleCampaign, unscheduleCampaign } from "@/app/(app)/campaigns/actions";
import InputAudienceLimit, { countRecipients } from "@/components/InputAudienceLimit";
import PickerSendTime from "@/components/PickerSendTime";
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
import NoticeFirstSend from "@/components/NoticeFirstSend";
import NoticeWarmup from "@/components/NoticeWarmup";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FIRST_SEND } from "@/lib/first-send";
import { formatCount, formatSendTime } from "@/lib/format";
import { getScheduleProblem, getScheduleSuggestions } from "@/lib/schedule";
import { useToastError } from "@/lib/use-toast-error";
import { useIsClient } from "@/lib/use-is-client";

const FALLBACK_MINUTES = 9 * 60;

export default function DialogScheduleCampaign({
	campaignId,
	scheduledAt,
	audienceLimit,
	audienceCount,
	history,
	taken,
	isCleanupEnabled,
	warmup,
	newContacts = 0,
	blockingMessage,
	onBeforeSchedule,
}) {
	const router = useRouter();
	const toastError = useToastError();
	const isClient = useIsClient();
	const [isOpen, setIsOpen] = useState(false);
	const [value, setValue] = useState(null);
	const [suggestions, setSuggestions] = useState([]);
	const [limit, setLimit] = useState(audienceLimit ? String(audienceLimit) : "");
	const [isSaving, startSaving] = useTransition();
	const recipients = countRecipients(limit, audienceCount);
	const problem = value && (getScheduleProblem(value) ?? blockingMessage);

	// Suggestions depend on the current time, so they're worked out each time the dialog opens.
	function changeOpen(nextIsOpen) {
		if (nextIsOpen) {
			const nextSuggestions = getScheduleSuggestions({ history, taken });
			const suggested = nextSuggestions.find(({ isLastIssue }) => isLastIssue) ?? nextSuggestions[0];
			setSuggestions(nextSuggestions);
			setValue(scheduledAt ? new Date(scheduledAt) : (suggested?.at ?? tomorrowAt(FALLBACK_MINUTES)));
		}
		setIsOpen(nextIsOpen);
	}

	function schedule() {
		startSaving(async () => {
			if (!(await onBeforeSchedule())) return;
			const result = await scheduleCampaign(campaignId, {
				scheduledAt: value.toISOString(),
				audienceLimit: Number.parseInt(limit, 10) || undefined,
			});
			if (result?.error) return toastError(result);
			setIsOpen(false);
			toast.success(`Scheduled for ${formatSendTime(value)}`);
			router.refresh();
		});
	}

	function unschedule() {
		startSaving(async () => {
			const result = await unscheduleCampaign(campaignId);
			if (result?.error) return toast.error(result.error);
			setIsOpen(false);
			toast.success("Unscheduled, it's a draft again");
			router.refresh();
		});
	}

	if (blockingMessage && !scheduledAt) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<span tabIndex={0} className="rounded-lg">
						<Button variant="outline" disabled>
							<CalendarClock data-icon="inline-start" />
							Schedule
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
				<Button variant="outline" className="tabular-nums">
					<CalendarClock data-icon="inline-start" />
					{scheduledAt ? (isClient ? formatSendTime(scheduledAt) : "Scheduled") : "Schedule"}
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{scheduledAt ? "Change the schedule" : "Schedule"}</DialogTitle>
					<DialogDescription className="tabular-nums">
						Goes out to {formatCount(recipients, "contact")}. You can keep editing until then.
						{isCleanupEnabled && " The list cleanup runs when it goes out, so cold contacts get the last-chance email instead."}
					</DialogDescription>
				</DialogHeader>
				{warmup && <NoticeWarmup warmup={warmup} />}
				{newContacts > FIRST_SEND.minSlice && <NoticeFirstSend count={newContacts} />}
				{value && (
					<>
						<PickerSendTime value={value} onChange={setValue} suggestions={suggestions} history={history} />
						<SummarySendTime value={value} problem={problem} />
						<InputAudienceLimit value={limit} onChange={setLimit} audienceCount={audienceCount} />
					</>
				)}
				<DialogFooter className="sm:items-center">
					{scheduledAt && (
						<Button variant="ghost" onClick={unschedule} disabled={isSaving} className="sm:mr-auto">
							Unschedule
						</Button>
					)}
					<DialogClose asChild>
						<Button variant="outline">Cancel</Button>
					</DialogClose>
					<Button onClick={schedule} disabled={isSaving || Boolean(problem) || recipients === 0} className="min-w-24">
						{isSaving ? <Loader2 className="animate-spin" /> : "Schedule"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function SummarySendTime({ value, problem }) {
	if (problem) return <p className="text-sm text-destructive">{problem}</p>;

	const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
		.formatToParts(value)
		.find(({ type }) => type === "timeZoneName")?.value;

	return (
		<p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm tabular-nums">
			<span className="font-medium">{formatSendTime(value)}</span>{" "}
			<span className="text-muted-foreground">{zone}</span>
		</p>
	);
}

function tomorrowAt(minutes) {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, Math.floor(minutes / 60), minutes % 60);
}
