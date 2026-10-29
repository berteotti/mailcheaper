"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { updateOrganization } from "@/app/(account)/organization/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import StatusSaved from "@/components/StatusSaved";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// The organization's name, which invitations and the consent page show. Owners change it.
export default function FormOrganization({ name, maxNameLength, canEdit }) {
	const [state, action, isPending] = useActionState(save, null);

	return (
		<form action={action}>
			<CardSettings title="Organization">
				<RowSettings label="Name" isLabel>
					<Input name="name" defaultValue={name} maxLength={maxNameLength} placeholder="Acme" required readOnly={!canEdit} />
				</RowSettings>
				{canEdit && (
					<div className="flex items-center justify-end gap-3 px-4 py-3">
						{state?.error && (
							<p role="alert" className="mr-auto text-sm text-pretty text-destructive">
								{state.error}
							</p>
						)}
						<StatusSaved savedAt={isPending ? null : state?.savedAt} />
						<Button type="submit" disabled={isPending} className="min-w-20">
							{isPending ? <Loader2 className="animate-spin" /> : "Save"}
						</Button>
					</div>
				)}
			</CardSettings>
		</form>
	);
}

async function save(previous, formData) {
	const result = await updateOrganization(previous, formData);
	return result?.ok ? { ...result, savedAt: Date.now() } : result;
}
