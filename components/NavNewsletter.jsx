import FormAddNewsletter from "@/components/FormAddNewsletter";
import MenuNewsletter from "@/components/MenuNewsletter";
import { getSharedDomain } from "@/lib/config";
import { MAX_NEWSLETTERS_PER_ACCOUNT, toNewsletterOption } from "@/lib/newsletters";
import { findAccountDomains } from "@/lib/sender";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

// The newsletter menu, under the logo in the sidebar and in the phone's top bar.
export default async function NavNewsletter({ isCompact }) {
	const { account, newsletters, selected, savedId } = await getSelectedNewsletter();
	const sharedDomain = getSharedDomain();
	const isAtLimit = newsletters.length >= MAX_NEWSLETTERS_PER_ACCOUNT;
	const domains = isAtLimit || sharedDomain ? [] : await findAccountDomains(account._id);

	return (
		<MenuNewsletter
			newsletters={newsletters.map(toNewsletterOption)}
			selectedId={selected ? String(selected._id) : null}
			savedId={savedId}
			isCompact={isCompact}
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
