"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Globe, KeyRound, LayoutGrid, Send, Settings, Shield, Users } from "lucide-react";
import { cn } from "@/lib/utils";

// The open newsletter's pages, then the account's, which every newsletter shares.
export default function NavLinks({ isAdmin, onNavigate }) {
	const pathname = usePathname();
	const groups = [NEWSLETTER_ITEMS, [...ACCOUNT_ITEMS, ...(isAdmin ? [ADMIN_ITEM] : [])]];

	return (
		<nav className="flex flex-col gap-3">
			{groups.map((items, index) => (
				<ul key={index} className="flex flex-col gap-0.5 not-first:border-t not-first:border-border/60 not-first:pt-3">
					{items.map(({ href, label, icon: Icon }) => {
						const isActive = href === "/" ? pathname === href : pathname.startsWith(href);
						return (
							<li key={href}>
								<Link
									href={href}
									onClick={onNavigate}
									aria-current={isActive ? "page" : undefined}
									className={cn(
										"flex h-9 items-center gap-2.5 rounded-lg pr-3 pl-2.5 text-sm font-medium transition-colors duration-150",
										isActive
											? "bg-muted text-foreground"
											: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
									)}
								>
									<Icon className="size-4" />
									{label}
								</Link>
							</li>
						);
					})}
				</ul>
			))}
		</nav>
	);
}

const NEWSLETTER_ITEMS = [
	{ href: "/", label: "Overview", icon: LayoutGrid },
	{ href: "/campaigns", label: "Campaigns", icon: Send },
	{ href: "/contacts", label: "Contacts", icon: Users },
	{ href: "/newsletters", label: "Settings", icon: Settings },
];

const ACCOUNT_ITEMS = [
	{ href: "/domains", label: "Domains", icon: Globe },
	{ href: "/api-keys", label: "API keys", icon: KeyRound },
];

const ADMIN_ITEM = { href: "/admin", label: "Admin", icon: Shield };
