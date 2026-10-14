"use client";

import { useTransition } from "react";
import Link from "next/link";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { createCampaign } from "@/app/(app)/campaigns/actions";
import { Button } from "@/components/ui/button";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";

// A new draft in the open newsletter.
export default function ButtonNewCampaign({ newsletterId, label = "New", size }) {
	const [isPending, startTransition] = useTransition();

	if (!newsletterId) {
		return (
			<Button asChild size={size}>
				<Link href={ADD_NEWSLETTER_PATH}>
					<Plus data-icon="inline-start" />
					{label}
				</Link>
			</Button>
		);
	}

	function create() {
		startTransition(async () => {
			const result = await createCampaign(newsletterId);
			if (result?.error) toast.error(result.error);
		});
	}

	return (
		<Button size={size} disabled={isPending} onClick={create}>
			{isPending ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Plus data-icon="inline-start" />}
			{label}
		</Button>
	);
}
