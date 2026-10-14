import { redirect } from "next/navigation";
import FormOnboarding from "@/components/FormOnboarding";
import { SiteAnalytics } from "@/components/SiteExtensions";
import { requireAccount } from "@/lib/auth";
import { getSharedDomain } from "@/lib/config";
import { LIST_SIZES, LIST_SOURCES, needsOnboarding } from "@/lib/onboarding";

export const metadata = { title: "Set up your newsletter" };

// Where the dashboard sends an account without a newsletter (app/(app)/layout.js).
export default async function WelcomePage() {
	const { user, account } = await requireAccount();
	if (!(await needsOnboarding(account))) redirect("/");
	const name = String(user.name ?? "").trim();

	return (
		<>
			<FormOnboarding
				defaultFromName={name.includes("@") ? "" : name}
				image={user.image || null}
				sharedDomain={getSharedDomain()}
				listSizes={LIST_SIZES}
				listSources={LIST_SOURCES}
			/>
			{SiteAnalytics && <SiteAnalytics goal="onboarding_started" />}
		</>
	);
}
