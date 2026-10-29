import LayoutDashboard from "@/components/LayoutDashboard";
import { isAdmin, requireAccount } from "@/lib/auth";

// The account, organization and billing pages only need a sign-in, and skip the newsletter setup: plan links on the
// public pages lead to billing.
export default async function AccountLayout({ children }) {
	const { user, account, organization } = await requireAccount();

	return (
		<LayoutDashboard user={user} account={account} organization={organization} isAdmin={isAdmin(user)}>
			{children}
		</LayoutDashboard>
	);
}
