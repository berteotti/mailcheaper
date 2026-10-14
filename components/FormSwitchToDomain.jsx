"use client";

import { useActionState, useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { switchToDomainAction } from "@/app/(app)/domains/actions";
import { Button } from "@/components/ui/button";

export default function FormSwitchToDomain({ newsletterId, newsletterName, domainId, domain, defaultLocalPart }) {
	const id = useId();
	const [localPart, setLocalPart] = useState(defaultLocalPart);
	const [, action, isPending] = useActionState(async (previous, formData) => {
		const result = await switchToDomainAction(previous, formData);
		if (result?.error) toast.error(result.error);
		else toast.success(`${newsletterName} sends from ${result.fromEmail}`);
		return result;
	}, null);

	return (
		<form
			action={action}
			className="flex flex-col gap-3 border-t border-border/60 bg-muted/40 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
		>
			<input type="hidden" name="newsletterId" value={newsletterId} />
			<input type="hidden" name="domainId" value={domainId} />
			<div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
				<label htmlFor={`${id}-local`} className="shrink-0 text-muted-foreground">
					Send <span className="font-medium text-foreground">{newsletterName}</span> from
				</label>
				<label className="flex h-9 max-w-full min-w-0 cursor-text items-center rounded-lg border border-input bg-background px-2.5 font-mono text-base transition-[border-color,box-shadow] duration-150 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 sm:h-8 sm:text-[13px] dark:bg-input/30">
					<input
						id={`${id}-local`}
						name="localPart"
						value={localPart}
						required
						style={{ width: `${Math.max(localPart.length, 2)}ch` }}
						placeholder="hi"
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						className="max-w-40 min-w-0 bg-transparent outline-none placeholder:text-muted-foreground"
						onChange={(event) => setLocalPart(event.target.value.split("@")[0].trim())}
					/>
					<span className="truncate text-muted-foreground">@{domain}</span>
				</label>
			</div>
			<Button type="submit" disabled={isPending} className="sm:h-8 sm:min-w-32">
				{isPending ? <Loader2 className="animate-spin" /> : "Use this address"}
			</Button>
		</form>
	);
}
