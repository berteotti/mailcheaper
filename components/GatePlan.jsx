"use client";

import { usePaywall } from "@/lib/use-paywall";

// Without a plan, a click on a button or link inside, or a form sent from inside, opens the paywall instead.
// Typing in a field inside still works.
export default function GatePlan({ reason, children }) {
	const paywall = usePaywall();
	if (!paywall || paywall.hasPlan) return children;

	function intercept(event) {
		event.preventDefault();
		event.stopPropagation();
		paywall.open(reason);
	}

	return (
		<div
			className="contents"
			onClickCapture={(event) => event.target.closest("button, a, [role='button']") && intercept(event)}
			onSubmitCapture={intercept}
		>
			{children}
		</div>
	);
}
