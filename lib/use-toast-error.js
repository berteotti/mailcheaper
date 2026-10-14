import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ERROR_CODES, isPlanLimitCode } from "@/lib/account-state";
import { usePaywall } from "@/lib/use-paywall";

// Plan errors come with a way out: no plan opens the paywall, a plan limit links to billing.
export function useToastError() {
	const router = useRouter();
	const paywall = usePaywall();
	return useCallback(
		(result) => {
			if (result?.code === ERROR_CODES.subscriptionRequired && paywall) return paywall.open();
			if (!isPlanLimitCode(result?.code)) return toast.error(result.error);
			return toast.error(result.error, { action: { label: "Upgrade", onClick: () => router.push("/billing") } });
		},
		[router, paywall]
	);
}
