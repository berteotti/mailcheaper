import Link from "next/link";
import { ArrowUpRight, Building2, CreditCard, Send } from "lucide-react";
import { openBillingPortal } from "@/app/(account)/billing/actions";
import { cancelInvite } from "@/app/(account)/organization/actions";
import AvatarUser from "@/components/AvatarUser";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonLeaveOrganization from "@/components/ButtonLeaveOrganization";
import ButtonRevoke from "@/components/ButtonRevoke";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import { getPlanDetails } from "@/components/CardSubscription";
import DialogDeleteOrganization from "@/components/DialogDeleteOrganization";
import DialogInviteMember from "@/components/DialogInviteMember";
import FormOrganization from "@/components/FormOrganization";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import MenuMember from "@/components/MenuMember";
import RowBlocker from "@/components/RowBlocker";
import { Button } from "@/components/ui/button";
import { DELETION_GRACE_DAYS, getDeletionBlockers } from "@/lib/account-deletion";
import { getAccountStatus, hasActiveSubscription } from "@/lib/account-state";
import { requireAccount } from "@/lib/auth";
import { isCloud } from "@/lib/config";
import { formatDate } from "@/lib/format";
import { INVITATION_DAYS, MAX_ORGANIZATION_NAME_LENGTH, canLeave, isOwner, listInvitations, listMembers } from "@/lib/organizations";
import { getAccountPlan } from "@/lib/plans";

export const metadata = { title: "Organization" };

const ROLE_LABELS = { owner: "Owner", member: "Member" };

// Who's in the organization and what concerns all of it: its name, its people, billing, and deleting it.
export default async function OrganizationPage() {
	const { user, account, organization, member } = await requireAccount();
	const isOwnerHere = isOwner(member);
	const [members, invitations, blockers, canLeaveNow] = await Promise.all([
		listMembers(organization._id),
		isOwnerHere ? listInvitations(organization._id) : [],
		isOwnerHere ? getDeletionBlockers(account) : null,
		canLeave(member),
	]);

	return (
		<LayoutNarrow>
			<HeaderPage
				title={organization.name}
				icon={
					<span className="grid size-8 place-items-center rounded-full bg-muted">
						<Building2 className="size-4 text-muted-foreground" />
					</span>
				}
			/>
			<div className="flex flex-col gap-4">
				<FormOrganization name={organization.name} maxNameLength={MAX_ORGANIZATION_NAME_LENGTH} canEdit={isOwnerHere} />
				<CardSettings
					title="People"
					stagger={1}
					action={isOwnerHere && <DialogInviteMember organizationName={organization.name} invitationDays={INVITATION_DAYS} />}
				>
					{members.map((person) => {
						const isSelf = String(person._id) === String(member._id);
						return (
							<div key={String(person._id)} className="flex items-center gap-3 px-4 py-2.5">
								<AvatarUser name={person.name} email={person.email} image={person.image} size={32} />
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="truncate text-sm font-medium">
										{person.name?.trim() || person.email}
										{isSelf && <span className="font-normal text-muted-foreground"> (you)</span>}
									</span>
									{person.name?.trim() && <span className="truncate text-xs text-muted-foreground">{person.email}</span>}
								</span>
								<span className="shrink-0 text-sm text-muted-foreground">{ROLE_LABELS[person.role]}</span>
								{isOwnerHere && (
									<MenuMember id={String(person._id)} name={person.name?.trim() || person.email} role={person.role} isSelf={isSelf} />
								)}
							</div>
						);
					})}
					{invitations.map((invitation) => (
						<div key={String(invitation._id)} className="flex items-center gap-3 px-4 py-2.5">
							<AvatarUser email={invitation.email} size={32} className="opacity-50" />
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate text-sm">{invitation.email}</span>
								<span className="truncate text-xs text-muted-foreground">Invited until {formatDate(invitation.expiresAt)}</span>
							</span>
							<span className="shrink-0 text-sm text-muted-foreground">{ROLE_LABELS[invitation.role]}</span>
							<ButtonRevoke
								id={String(invitation._id)}
								revoke={cancelInvite}
								label="Cancel"
								confirmMessage={`Cancel the invitation to ${invitation.email}?`}
								successMessage="Invitation canceled"
							/>
						</div>
					))}
				</CardSettings>
				{isCloud() && <CardBilling account={account} canPay={isOwnerHere} />}
				<CardSettings title="Leave" stagger={3}>
					<RowSettings
						label={organization.name}
						hint={canLeaveNow ? "Its newsletters stay with it. Your next sign-in starts an organization of your own." : "You're its only owner: make someone else an owner first, or delete it."}
					>
						<span className="flex justify-end">
							<ButtonLeaveOrganization name={organization.name} isDisabled={!canLeaveNow} />
						</span>
					</RowSettings>
				</CardSettings>
				{isOwnerHere && <CardDelete name={organization.name} email={user.email} blockers={blockers} cancelAt={account.cancelAt} />}
			</div>
		</LayoutNarrow>
	);
}

function CardBilling({ account, canPay }) {
	const isActive = hasActiveSubscription(account);
	const details = isActive ? getPlanDetails(account) : [];

	return (
		<CardSettings
			title="Billing"
			stagger={2}
			action={
				<Button asChild variant="outline" size="sm">
					<Link href="/billing">{isActive || !canPay ? "See billing" : "Pick a plan"}</Link>
				</Button>
			}
		>
			<RowSettings label="Plan" hint={canPay ? null : "Only owners change the plan."}>
				<span className="flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-1">
					<span className="text-sm font-medium">{isActive ? (getAccountPlan(account)?.name ?? "Your plan") : "No plan"}</span>
					{(isActive || account.subscriptionStatus) && <BadgeStatus status={getAccountStatus(account)} />}
					{details.length > 0 && <span className="text-sm text-muted-foreground tabular-nums">{details.join(" · ")}</span>}
				</span>
			</RowSettings>
		</CardSettings>
	);
}

function CardDelete({ name, email, blockers, cancelAt }) {
	return (
		<CardSettings title="Delete organization" stagger={4} className="mt-6">
			<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
				It stops at once, for everyone in it. {DELETION_GRACE_DAYS} days later, its newsletters, contacts, campaigns and images are
				deleted for good, with its members&apos; sign-ins. An owner who signs in before then can restore it.
			</p>
			{blockers?.hasPlan && (
				<RowBlocker
					icon={CreditCard}
					title={cancelAt ? `Your plan ends on ${formatDate(cancelAt)}` : "Cancel your plan first"}
					text={
						cancelAt
							? "You can delete the organization once it has ended."
							: "Deleting the organization doesn't stop Stripe from billing it. Cancel it in the billing portal."
					}
				>
					<form action={openBillingPortal}>
						<Button type="submit" variant="outline" size="sm">
							Billing portal
							<ArrowUpRight data-icon="inline-end" className="opacity-60" />
						</Button>
					</form>
				</RowBlocker>
			)}
			{blockers?.campaigns.length > 0 && (
				<RowBlocker icon={Send} title="Stop your campaigns first" text="Pause the ones sending, and cancel the scheduled ones.">
					<ul className="flex flex-col gap-1">
						{blockers.campaigns.map((campaign) => (
							<li key={String(campaign._id)}>
								<Link
									href={`/campaigns/${campaign._id}`}
									className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 hover:bg-muted"
								>
									<span className="truncate">{campaign.subject || "Untitled"}</span>
									<BadgeStatus status={campaign.status} />
								</Link>
							</li>
						))}
					</ul>
				</RowBlocker>
			)}
			<div className="flex justify-end rounded-b-xl bg-destructive/[0.03] px-4 py-3 dark:bg-destructive/[0.06]">
				<DialogDeleteOrganization name={name} email={email} graceDays={DELETION_GRACE_DAYS} isDisabled={Boolean(blockers)} />
			</div>
		</CardSettings>
	);
}
