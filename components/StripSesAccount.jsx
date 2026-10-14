import { TriangleAlert } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import { formatCompact, formatNumber } from "@/lib/format";
import { getSesAccount } from "@/lib/ses";

// The platform's SES account: shared by every customer until each has its own tenant.
export default async function StripSesAccount() {
	const account = await getSesAccount();

	if (account.error) {
		return (
			<p className="flex items-center gap-3 rounded-xl px-4 py-4 text-sm text-muted-foreground shadow-border animate-fade-in">
				<TriangleAlert className="size-4 shrink-0 text-amber-500" />
				<span className="truncate">SES unreachable: {account.error}</span>
			</p>
		);
	}

	const accountLabel = account.productionAccess
		? "Production"
		: account.reviewStatus === "PENDING"
			? "Sandbox, in review"
			: "Sandbox";
	const quotaUsed = account.max24HourSend ? Math.min(account.sentLast24Hours / account.max24HourSend, 1) : 0;
	const items = [
		{
			label: "SES account",
			value: <BadgeStatus status={account.productionAccess ? "active" : "sandbox"} label={accountLabel} />,
		},
		{ label: "Health", value: <BadgeStatus status={account.enforcementStatus} /> },
		{
			label: "Daily quota",
			value: (
				<span className="flex w-full flex-col gap-1.5">
					{formatNumber(account.sentLast24Hours)} / {formatCompact(account.max24HourSend)}
					<span className="h-1 w-full max-w-32 overflow-hidden rounded-full bg-muted">
						<span
							className="block h-full rounded-full bg-foreground/70"
							style={{ width: `${Math.max(quotaUsed * 100, quotaUsed > 0 ? 2 : 0)}%` }}
						/>
					</span>
				</span>
			),
		},
		{ label: "Max rate", value: `${formatNumber(account.maxSendRate)}/s` },
	];

	return (
		<div className="overflow-hidden rounded-xl bg-card shadow-border animate-fade-in">
			<dl className="grid grid-cols-2 gap-px bg-border/60 lg:grid-cols-4">
				{items.map(({ label, value }) => (
					<div key={label} className="flex min-h-[66px] flex-col items-start justify-center gap-1.5 bg-card px-4 py-3">
						<dt className="text-xs text-muted-foreground">{label}</dt>
						<dd className="w-full text-sm font-medium tabular-nums">{value}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}
