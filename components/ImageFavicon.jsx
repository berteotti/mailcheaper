import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";

export default function ImageFavicon({ domain, size = 16, className }) {
	if (!domain) return null;
	return (
		<Globe aria-hidden="true" size={size} className={cn("shrink-0 text-muted-foreground", className)} />
	);
}
