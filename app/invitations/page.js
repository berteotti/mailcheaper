import Link from "next/link";
import { redirect } from "next/navigation";
import { startOwnOrganization } from "@/app/invitations/actions";
import { signOut } from "@/app/signin/actions";
import ButtonSignout from "@/components/ButtonSignout";
import CardInvitation from "@/components/CardInvitation";
import LogoWordmark from "@/components/LogoWordmark";
import { Button } from "@/components/ui/button";
import { getCurrentAccount } from "@/lib/auth";
import { newsreader } from "@/lib/fonts";
import { INVITATIONS_PATH, canLeave, findInvitationsFor } from "@/lib/organizations";
import { cn } from "@/lib/utils";

export const metadata = { title: "Invitations" };

// Where an invitation's email leads, and where the dashboard sends someone invited who isn't in an organization yet
// (requireAccount in lib/auth.js). A person belongs to one organization, so joining another means leaving theirs.
export default async function InvitationsPage() {
	const current = await getCurrentAccount();
	if (!current) redirect(`/signin?next=${INVITATIONS_PATH}`);
	const { user, organization, member } = current;
	const invitations = await findInvitationsFor(user.email);
	if (invitations.length === 0) redirect("/");
	const canJoin = !member || (await canLeave(member));

	return (
		<main className={cn(newsreader.variable, "flex min-h-dvh flex-col px-5 py-5 sm:px-8 sm:py-6 lg:px-12")}>
			<header className="flex h-9 items-center">
				<LogoWordmark />
			</header>
			<div className="flex flex-1 items-center justify-center py-12">
				<div className="w-full max-w-[26rem] animate-enter">
					<h1 className="font-display text-[2.5rem] leading-[1.05] font-[480] tracking-[-0.03em] text-balance">
						{invitations.length === 1 ? `Join ${invitations[0].organizationName}` : "You're invited"}
					</h1>
					<p className="mt-3 text-[15px] leading-6 text-pretty text-muted-foreground">
						{getIntro({ organization, canJoin })}
					</p>
					<div className="mt-8 flex flex-col gap-3">
						{invitations.map((invitation) => (
							<CardInvitation
								key={String(invitation._id)}
								id={String(invitation._id)}
								organizationName={invitation.organizationName}
								inviter={invitation.inviterName?.trim() || invitation.inviterEmail || "Someone"}
								role={invitation.role}
								leaving={organization ? { id: String(organization._id), name: organization.name } : null}
								canJoin={canJoin}
							/>
						))}
					</div>
					{!organization && (
						<form action={startOwnOrganization} className="mt-4">
							<Button type="submit" variant="ghost" className="w-full text-muted-foreground">
								Start an organization of my own instead
							</Button>
						</form>
					)}
					{organization && !canJoin && (
						<Button asChild variant="outline" className="mt-4 w-full">
							<Link href="/organization">Go to {organization.name}</Link>
						</Button>
					)}
					<form action={signOut} className="mt-8 flex items-center justify-between gap-3 border-t border-border/60 pt-4 text-sm">
						<span className="min-w-0 truncate text-muted-foreground">{user.email}</span>
						<ButtonSignout className="shrink-0">Sign out</ButtonSignout>
					</form>
				</div>
			</div>
		</main>
	);
}

function getIntro({ organization, canJoin }) {
	if (!organization) return "Join to work on its newsletters with the others in it.";
	if (!canJoin) return `You're the only owner of ${organization.name}. Make someone else an owner there, or delete it, before you join.`;
	return `You're in ${organization.name}. Joining means leaving it: its newsletters, contacts and campaigns stay with it, and the apps you connected disconnect.`;
}
