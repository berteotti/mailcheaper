import { SUPPORT_EMAIL } from "@/lib/config";
import { formatNumber } from "@/lib/format";
import { PLANS } from "@/lib/plans";
import { cn } from "@/lib/utils";

// Under the plans: sending more than the largest plan gets a price by email.
export default function TextContactUs({ className }) {
	return (
		<p className={cn("text-center text-sm text-muted-foreground", className)}>
			More than {formatNumber(PLANS.at(-1).emailsPerMonth)} emails?{" "}
			<a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium text-foreground underline underline-offset-4">
				Contact us
			</a>
		</p>
	);
}
