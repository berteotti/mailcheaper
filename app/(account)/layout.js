import LayoutDashboard from "@/components/LayoutDashboard";
import { isAdmin, requireAccount } from "@/lib/auth";

// The account page and billing only need a sign-in, and skip the newsletter setup: plan links on the public pages
// lead to billing.
export default async function AccountLayout({ children }) {
	const { user, account } = await requireAccount();

	return (
		<LayoutDashboard user={user} account={account} isAdmin={isAdmin(user)}>
			{children}
		</LayoutDashboard>
	);
}
