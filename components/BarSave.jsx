"use client";

import { Loader2 } from "lucide-react";
import StatusSaved from "@/components/StatusSaved";
import { Button } from "@/components/ui/button";

// A form's save bar, its last child, like FormNewsletter's: Save and Discard once something changed, Saved for a
// moment after. The form's own submit saves.
export default function BarSave({ isDirty, isSaving, savedAt, onDiscard }) {
	return (
		<div
			data-save-bar
			className="sticky bottom-0 -mx-4 mt-6 -mb-6 flex h-(--save-bar-height) items-center justify-end gap-3 bg-background/80 px-4 backdrop-blur-md md:-mx-10 md:-mb-10 md:px-10"
		>
			<StatusSaved savedAt={isSaving || isDirty ? null : savedAt} />
			{isDirty && (
				<Button type="button" variant="ghost" disabled={isSaving} onClick={onDiscard}>
					Discard
				</Button>
			)}
			<Button type="submit" disabled={!isDirty || isSaving} className="min-w-20">
				{isSaving ? <Loader2 className="animate-spin" /> : "Save"}
			</Button>
		</div>
	);
}
