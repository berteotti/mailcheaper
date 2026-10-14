import { Check } from "lucide-react";

// Saved, next to a form's Save button for a moment: it fades out, so it never stands for changes made after.
// Each save needs a new savedAt to show it again.
export default function StatusSaved({ savedAt }) {
	return (
		<span aria-live="polite" className="text-xs text-muted-foreground">
			{savedAt && (
				<span key={savedAt} className="flex items-center gap-1.5 animate-saved">
					<Check className="size-3.5 animate-icon-in" />
					Saved
				</span>
			)}
		</span>
	);
}
