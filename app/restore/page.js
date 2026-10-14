import { redirect } from "next/navigation";
import { signOut } from "@/app/signin/actions";
import ButtonSignout from "@/components/ButtonSignout";
import FormRestore from "@/components/FormRestore";
import LogoWordmark from "@/components/LogoWordmark";
import { isDeletionPending } from "@/lib/account-state";
import { getCurrentAccount } from "@/lib/auth";
import { newsreader } from "@/lib/fonts";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata = { title: "Restore your account" };

// Where signing in leads while the account waits to be deleted (requireAccount in lib/auth.js), until its purge starts.
export default async function RestorePage() {
	const current = await getCurrentAccount();
	if (!current) redirect("/signin");
	const { user, account } = current;
	if (!isDeletionPending(account)) redirect("/");
	const canRestore = !account.deletion.purgeStartedAt;

	return (
		<main className={cn(newsreader.variable, "flex min-h-dvh flex-col px-5 py-5 sm:px-8 sm:py-6 lg:px-12")}>
			<header className="flex h-9 items-center">
				<LogoWordmark />
			</header>
			<div className="flex flex-1 items-center justify-center py-12">
				<div className="w-full max-w-[24rem] animate-enter">
					<h1 className="font-display text-[2.5rem] leading-[1.05] font-[480] tracking-[-0.03em] text-balance">
						{canRestore ? "Your account is set to be deleted" : "Your account is being deleted"}
					</h1>
					<p className="mt-3 text-[15px] leading-6 text-pretty text-muted-foreground">
						{canRestore
							? `On ${formatDate(account.deletion.purgeAt)}, its newsletters, contacts, campaigns and images are deleted for good. Restore it to keep them.`
							: "Its newsletters, contacts, campaigns and images are being deleted for good, so it can't be restored."}
					</p>
					{canRestore && <FormRestore />}
					<form action={signOut} className="mt-8 flex items-center justify-between gap-3 border-t border-border/60 pt-4 text-sm">
						<span className="min-w-0 truncate text-muted-foreground">{user.email}</span>
						<ButtonSignout className="shrink-0">Sign out</ButtonSignout>
					</form>
				</div>
			</div>
		</main>
	);
}
