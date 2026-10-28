"use client";

import { useMemo, useState } from "react";
import { ContactSelectionContext } from "@/lib/use-contact-selection";

// The contacts ticked in the list, kept from page to page. The page keys it by its filters, which start it over.
export default function ProviderContactSelection({ children }) {
	const [selected, setSelected] = useState(() => new Set());
	const value = useMemo(
		() => ({
			selected,
			select: (ids, isSelected) =>
				setSelected((current) => {
					const next = new Set(current);
					for (const id of ids) {
						if (isSelected) next.add(id);
						else next.delete(id);
					}
					return next;
				}),
			clear: () => setSelected(new Set()),
		}),
		[selected]
	);

	return <ContactSelectionContext value={value}>{children}</ContactSelectionContext>;
}
