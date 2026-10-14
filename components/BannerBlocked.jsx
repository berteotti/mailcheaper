import { Ban, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SUPPORT_EMAIL, isCloud } from "@/lib/config";

// Across the top of every dashboard page while the account is blocked (lib/account-blocks.js), instead of
// BannerPlan: why, and who unblocks it.
export default function BannerBlocked({ account }) {
	const reason = account.pauseReason?.trim().replace(/\.$/, "");
	const subject = encodeURIComponent("My MailCheap account is blocked");

	return (
		<div
			data-plan-bar
			data-blocked-bar
			role="status"
			className="sticky top-0 z-40 flex h-(--plan-bar-height) items-center justify-center gap-3 bg-red-600 px-3 text-white sm:gap-4 sm:px-4 dark:bg-red-700"
		>
			<Ban aria-hidden className="size-4 shrink-0" />
			<p className="line-clamp-2 min-w-0 text-[13px] leading-snug font-medium text-pretty md:truncate md:text-sm" title={reason}>
				Account blocked{reason && `: ${reason}`}
				<span className="hidden font-normal text-white/75 xl:inline"> · Nothing is sent until it&apos;s unblocked</span>
			</p>
			{isCloud() ? (
				<Button asChild size="sm" variant="secondary" className="shrink-0">
					<a href={`mailto:${SUPPORT_EMAIL}?subject=${subject}`}>
						<Mail data-icon="inline-start" />
						<span className="md:hidden">Contact us</span>
						<span className="hidden md:inline">{SUPPORT_EMAIL}</span>
					</a>
				</Button>
			) : (
				<span className="hidden shrink-0 text-[13px] text-white/75 sm:inline">An admin can unblock it</span>
			)}
		</div>
	);
}
