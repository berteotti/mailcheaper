import FormAddNewsletter from "@/components/FormAddNewsletter";
import MenuNewsletter from "@/components/MenuNewsletter";
import { isAdmin } from "@/lib/auth";
import { getSharedDomain } from "@/lib/config";
import { getNewsletterLimit, isAtNewsletterLimit, toNewsletterOption } from "@/lib/newsletters";
import { findAccountDomains } from "@/lib/sender";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

// The newsletter menu, under the logo in the sidebar and in the phone's top bar.
export default async function NavNewsletter({ isCompact }) {
	// The signed-in user owns the account.
	const { user, account, newsletters, selected, savedId } = await getSelectedNewsletter();
	const sharedDomain = getSharedDomain();
	const isAtLimit = isAtNewsletterLimit(newsletters.length, getNewsletterLimit({ isAdmin: isAdmin(user) }));
	const domains = isAtLimit || sharedDomain ? [] : await findAccountDomains(account._id);

	return (
		<MenuNewsletter
			newsletters={newsletters.map(toNewsletterOption)}
			selectedId={selected ? String(selected._id) : null}
			savedId={savedId}
			isCompact={isCompact}
			isAtLimit={isAtLimit}
			addForm={
				<FormAddNewsletter
					sharedDomain={sharedDomain}
					domains={domains.map(({ domain }) => domain)}
					startsFrom={selected && (selected.fromName || selected.postalAddress) ? selected.name : null}
					isAtLimit={isAtLimit}
				/>
			}
		/>
	);
}
