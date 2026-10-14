"use client";

import { usePathname } from "next/navigation";

// The layout doesn't render again on navigation, so the path is read here: billing already lists the plans.
export default function ShellBannerPlan({ children }) {
	return usePathname() === "/billing" ? null : children;
}
