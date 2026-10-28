import { createContext, use } from "react";

export const ContactSelectionContext = createContext(null);

// { selected, select(ids, isSelected), clear() } in the contacts list (components/ProviderContactSelection.jsx).
export function useContactSelection() {
	return use(ContactSelectionContext);
}
