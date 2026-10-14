import Link from "next/link";
import { signOut } from "@/app/signin/actions";
import ButtonSignout from "@/components/ButtonSignout";
import ButtonThemeToggle from "@/components/ButtonThemeToggle";
import LogoWordmark from "@/components/LogoWordmark";
import { Button } from "@/components/ui/button";
import { SiteAnalytics } from "@/components/SiteExtensions";
import { requireAdmin } from "@/lib/auth";

export const metadata = { title: "Admin" };

// Only ADMIN_EMAILS get here; everyone else gets a 404. The page and the actions check again.
export default async function AdminLayout({ children }) {
	const admin = await requireAdmin();

	return (
		<div className="flex min-h-dvh flex-col">
			<header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-md">
				<div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4 md:px-10">
					<LogoWordmark href="/admin">
						<span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Admin</span>
					</LogoWordmark>
					<div className="flex min-w-0 items-center gap-1">
						<span className="mr-2 hidden truncate text-xs text-muted-foreground sm:block">{admin.email}</span>
						<Button asChild variant="ghost" size="sm">
							<Link href="/">Dashboard</Link>
						</Button>
						<div className="hidden sm:flex">
							<ButtonThemeToggle />
						</div>
						<form action={signOut}>
							<ButtonSignout />
						</form>
					</div>
				</div>
			</header>
			<main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-10 md:py-10">{children}</main>
			{SiteAnalytics && <SiteAnalytics />}
		</div>
	);
}
