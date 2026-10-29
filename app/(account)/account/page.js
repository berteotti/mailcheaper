import Link from "next/link";
import { Lock } from "lucide-react";
import AvatarUser from "@/components/AvatarUser";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import FormProfile from "@/components/FormProfile";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import { Button } from "@/components/ui/button";
import { hasGoogleSignIn } from "@/lib/accounts";
import { requireAccount } from "@/lib/auth";
import { MAX_NAME_LENGTH } from "@/lib/profile";

export const metadata = { title: "Account" };

const ROLE_LABELS = { owner: "Owner", member: "Member" };

// The signed-in person: their name, photo and email. What concerns the whole organization is on its page.
export default async function AccountPage() {
	const { user, organization, member } = await requireAccount();
	const hasGoogle = await hasGoogleSignIn(user.id);

	return (
		<LayoutNarrow>
			<HeaderPage title="Account" icon={<AvatarUser name={user.name} email={user.email} image={user.image} size={32} />} />
			<div className="flex flex-col gap-4">
				<FormProfile name={user.name ?? ""} image={user.image ?? ""} maxNameLength={MAX_NAME_LENGTH} />
				<CardSettings title="Email" stagger={1}>
					<RowSettings label="Address" hint={hasGoogle ? "You sign in with Google or with a code sent here." : "You sign in with a code sent here."}>
						<span className="flex h-9 items-center justify-between gap-3 rounded-lg bg-muted/60 px-2.5 text-sm">
							<span className="truncate">{user.email}</span>
							<Lock aria-label="Can't be changed" className="size-3.5 shrink-0 text-muted-foreground" />
						</span>
					</RowSettings>
				</CardSettings>
				<CardSettings
					title="Organization"
					stagger={2}
					action={
						<Button asChild variant="outline" size="sm">
							<Link href="/organization">Manage</Link>
						</Button>
					}
				>
					<RowSettings label="Name" hint="Its people, billing and deleting it are on its page.">
						<span className="flex h-9 items-center gap-2.5 text-sm">
							<span className="truncate font-medium">{organization.name}</span>
							<span className="shrink-0 text-muted-foreground">{ROLE_LABELS[member.role]}</span>
						</span>
					</RowSettings>
				</CardSettings>
			</div>
		</LayoutNarrow>
	);
}
