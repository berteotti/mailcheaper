import { createContext, use } from "react";

export const PaywallContext = createContext(null);

// { hasPlan, open(reason) } in the dashboard (components/ProviderPaywall.jsx), null elsewhere.
export function usePaywall() {
	return use(PaywallContext);
}
