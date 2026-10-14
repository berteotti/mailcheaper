"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { Ban, CircleOff, Gauge, Gift, Hourglass, Loader2, MoreHorizontal, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { blockAccountAction, endFreePlan, giveFreePlan, saveLimits, setSpread, unblockAccountAction } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCompact, formatNumber } from "@/lib/format";
import { PLANS } from "@/lib/plans";

// freePlan: { plan, until } while the account has a free plan running. blockedBy: who blocked it, while it's blocked.
export default function MenuAccount({
	accountId,
	email,
	blockedBy,
	blockReason,
	providerName,
	hasLimits,
	canSpread,
	isSpreading,
	canGiveFreePlan,
	freePlan,
	overrides,
	planLimits,
}) {
	const [dialog, setDialog] = useState(null);
	const [isPending, startTransition] = useTransition();

	function toggleSpread() {
		startTransition(async () => {
			const result = await setSpread(accountId, !isSpreading);
			if (result?.error) toast.error(result.error);
			else toast.success(isSpreading ? "Sends go out at full speed" : "Warm-up started: campaigns go out over hours for 30 days");
		});
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon-sm" aria-label="Actions" disabled={isPending}>
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-56">
					{hasLimits && (
						<DropdownMenuItem onSelect={() => setDialog("limits")}>
							<Gauge />
							Change limits
						</DropdownMenuItem>
					)}
					{canSpread && (
						<DropdownMenuItem onSelect={toggleSpread}>
							<Hourglass />
							{isSpreading ? "End warm-up" : "Start warm-up again"}
						</DropdownMenuItem>
					)}
					{canGiveFreePlan && (
						<DropdownMenuItem onSelect={() => setDialog("free-plan")}>
							<Gift />
							{freePlan ? "Change free plan" : "Give a free plan"}
						</DropdownMenuItem>
					)}
					{canGiveFreePlan && freePlan && (
						<DropdownMenuItem variant="destructive" onSelect={() => setDialog("end-free-plan")}>
							<CircleOff />
							End free plan
						</DropdownMenuItem>
					)}
					{blockedBy ? (
						<DropdownMenuItem onSelect={() => setDialog("unblock")}>
							<ShieldCheck />
							Unblock account
						</DropdownMenuItem>
					) : (
						<DropdownMenuItem variant="destructive" onSelect={() => setDialog("block")}>
							<Ban />
							Block account
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={dialog !== null} onOpenChange={(isOpen) => !isOpen && setDialog(null)}>
				<DialogContent className={dialog === "free-plan" ? "sm:max-w-md" : "sm:max-w-sm"}>
					{dialog === "free-plan" && <FormFreePlan accountId={accountId} email={email} freePlan={freePlan} onDone={() => setDialog(null)} />}
					{dialog === "end-free-plan" && <FormEndFreePlan accountId={accountId} email={email} onDone={() => setDialog(null)} />}
					{dialog === "block" && <FormBlock accountId={accountId} email={email} providerName={providerName} onDone={() => setDialog(null)} />}
					{dialog === "unblock" && (
						<FormUnblock accountId={accountId} email={email} blockedBy={blockedBy} blockReason={blockReason} onDone={() => setDialog(null)} />
					)}
					{dialog === "limits" && (
						<FormLimits accountId={accountId} overrides={overrides} planLimits={planLimits} onDone={() => setDialog(null)} />
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}

function FormBlock({ accountId, email, providerName, onDone }) {
	const [reason, setReason] = useState("");
	const [isPending, startTransition] = useTransition();

	function block(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await blockAccountAction(accountId, reason);
			if (result?.error) return toast.error(result.error);
			toast.success("Account blocked");
			onDone();
		});
	}

	return (
		<form onSubmit={block} className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>Block account?</DialogTitle>
				<DialogDescription>
					{email ?? "This account"} sends nothing until you unblock it, welcome emails included, and can only read, pause and
					cancel. Its {providerName} tenant is suspended.
				</DialogDescription>
			</DialogHeader>
			<Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason, shown to them" maxLength={200} />
			<DialogFooter>
				<DialogClose asChild>
					<Button variant="outline">Cancel</Button>
				</DialogClose>
				<Button type="submit" variant="destructive" disabled={isPending} className="min-w-20">
					{isPending ? <Loader2 className="animate-spin" /> : "Block"}
				</Button>
			</DialogFooter>
		</form>
	);
}

function FormUnblock({ accountId, email, blockedBy, blockReason, onDone }) {
	const [isPending, startTransition] = useTransition();

	function unblock(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await unblockAccountAction(accountId);
			if (result?.error) return toast.error(result.error);
			toast.success("Account unblocked");
			onDone();
		});
	}

	return (
		<form onSubmit={unblock} className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>Unblock account?</DialogTitle>
				<DialogDescription>
					{email ?? "This account"} can send again. Its paused campaigns stay paused until its owner resumes them.
				</DialogDescription>
			</DialogHeader>
			<p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-pretty">
				{blockedBy}
				{blockReason && `: ${blockReason}`}
			</p>
			<DialogFooter>
				<DialogClose asChild>
					<Button variant="outline">Cancel</Button>
				</DialogClose>
				<Button type="submit" disabled={isPending} className="min-w-24">
					{isPending ? <Loader2 className="animate-spin" /> : "Unblock"}
				</Button>
			</DialogFooter>
		</form>
	);
}

function FormLimits({ accountId, overrides, planLimits, onDone }) {
	const [state, action, isPending] = useActionState(saveLimits, null);

	useEffect(() => {
		if (!state?.ok) return;
		toast.success("Limits saved");
		onDone();
	}, [state, onDone]);

	return (
		<form action={action} className="flex flex-col gap-4">
			<input type="hidden" name="accountId" value={accountId} />
			<DialogHeader>
				<DialogTitle>Change limits</DialogTitle>
				<DialogDescription>Leave a field empty to use the plan&apos;s number.</DialogDescription>
			</DialogHeader>
			<FieldLimit label="Emails a month" name="emailsPerMonth" value={overrides.emailsPerMonth} planValue={planLimits?.emailsPerMonth} />
			<FieldLimit label="Subscribers" name="subscribers" value={overrides.subscribers} planValue={planLimits?.subscribers} />
			{state?.error && <p className="text-sm text-destructive">{state.error}</p>}
			<DialogFooter>
				<DialogClose asChild>
					<Button variant="outline">Cancel</Button>
				</DialogClose>
				<Button type="submit" disabled={isPending} className="min-w-20">
					{isPending ? <Loader2 className="animate-spin" /> : "Save"}
				</Button>
			</DialogFooter>
		</form>
	);
}

function FormFreePlan({ accountId, email, freePlan, onDone }) {
	const [state, action, isPending] = useActionState(giveFreePlan, null);

	useEffect(() => {
		if (!state?.ok) return;
		toast.success(freePlan ? "Free plan changed" : "Free plan given");
		onDone();
	}, [state, freePlan, onDone]);

	return (
		<form action={action} className="flex flex-col gap-4">
			<input type="hidden" name="accountId" value={accountId} />
			<DialogHeader>
				<DialogTitle>{freePlan ? "Change free plan" : "Give a free plan"}</DialogTitle>
				<DialogDescription>
					{email ?? "This account"} gets the plan&apos;s emails and subscribers without paying. A paid plan takes over while
					there&apos;s one.
				</DialogDescription>
			</DialogHeader>
			<fieldset className="grid gap-2">
				<legend className="sr-only">Plan</legend>
				{PLANS.map((plan) => (
					<label
						key={plan.id}
						className="flex items-center gap-3 rounded-lg px-3 py-2.5 shadow-border transition-[box-shadow,background-color] duration-150 hover:shadow-border-hover has-checked:bg-muted/60 has-checked:shadow-border-hover"
					>
						<input
							type="radio"
							name="plan"
							value={plan.id}
							defaultChecked={plan.id === freePlan?.plan}
							required
							className="size-4 shrink-0 accent-foreground"
						/>
						<span className="text-sm font-medium">{plan.name}</span>
						<span className="ml-auto text-xs text-muted-foreground tabular-nums">
							{formatCompact(plan.emailsPerMonth)} emails · {formatCompact(plan.subscribers)} subscribers
						</span>
					</label>
				))}
			</fieldset>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`free-plan-until-${accountId}`}>
					Ends on <span className="font-normal text-muted-foreground">(optional)</span>
				</Label>
				<Input
					id={`free-plan-until-${accountId}`}
					type="date"
					name="until"
					min={getTomorrow()}
					defaultValue={freePlan?.until?.slice(0, 10) ?? ""}
					className="tabular-nums"
				/>
				<p className="text-xs text-muted-foreground">Without a date, it has no end.</p>
			</div>
			{state?.error && <p className="text-sm text-destructive">{state.error}</p>}
			<DialogFooter>
				<DialogClose asChild>
					<Button variant="outline">Cancel</Button>
				</DialogClose>
				<Button type="submit" disabled={isPending} className="min-w-24">
					{isPending ? <Loader2 className="animate-spin" /> : freePlan ? "Save" : "Give plan"}
				</Button>
			</DialogFooter>
		</form>
	);
}

function FormEndFreePlan({ accountId, email, onDone }) {
	const [isPending, startTransition] = useTransition();

	function end(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await endFreePlan(accountId);
			if (result?.error) return toast.error(result.error);
			toast.success("Free plan ended");
			onDone();
		});
	}

	return (
		<form onSubmit={end} className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>End free plan?</DialogTitle>
				<DialogDescription>
					{email ?? "This account"} keeps its newsletters, contacts and campaigns, and stops sending unless it pays for a plan.
				</DialogDescription>
			</DialogHeader>
			<DialogFooter>
				<DialogClose asChild>
					<Button variant="outline">Cancel</Button>
				</DialogClose>
				<Button type="submit" variant="destructive" disabled={isPending} className="min-w-24">
					{isPending ? <Loader2 className="animate-spin" /> : "End plan"}
				</Button>
			</DialogFooter>
		</form>
	);
}

// The first day the date field takes: a free plan ends at midnight UTC of the day picked, and today's has passed.
function getTomorrow() {
	return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function FieldLimit({ label, name, value, planValue }) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={`limit-${name}`}>{label}</Label>
			<Input
				id={`limit-${name}`}
				name={name}
				inputMode="numeric"
				defaultValue={value ?? ""}
				placeholder={planValue === undefined ? "No plan" : `${formatNumber(planValue)} (plan)`}
				className="tabular-nums"
			/>
		</div>
	);
}
