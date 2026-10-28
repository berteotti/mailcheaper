"use client";

import { useEffect, useRef } from "react";
import { useContactSelection } from "@/lib/use-contact-selection";

// One contact's box in the list, or with ids, the header's for every contact on the page.
export default function CheckboxContact({ id, ids = [id], label }) {
	const { selected, select } = useContactSelection();
	const ref = useRef(null);
	const count = ids.filter((each) => selected.has(each)).length;
	const isChecked = count > 0 && count === ids.length;

	useEffect(() => {
		ref.current.indeterminate = count > 0 && !isChecked;
	}, [count, isChecked]);

	return (
		<input
			ref={ref}
			type="checkbox"
			checked={isChecked}
			onChange={(event) => select(ids, event.target.checked)}
			aria-label={label}
			className="size-4 shrink-0 cursor-pointer align-middle accent-foreground"
		/>
	);
}
