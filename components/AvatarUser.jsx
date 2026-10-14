import Image from "next/image";
import { cn } from "@/lib/utils";

export default function AvatarUser({ name, email, image, size = 20, className }) {
	// Google's pictures are thumbnails already, and can fail to load when the request sends a referrer.
	if (image) {
		return (
			<Image
				src={image}
				alt=""
				width={size}
				height={size}
				unoptimized
				referrerPolicy="no-referrer"
				className={cn("shrink-0 rounded-full object-cover outline -outline-offset-1 outline-black/10 dark:outline-white/10", className)}
			/>
		);
	}

	return (
		<span
			aria-hidden="true"
			style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
			className={cn("grid shrink-0 place-items-center rounded-full bg-foreground font-semibold text-background", className)}
		>
			{(name?.trim() || email).charAt(0).toUpperCase()}
		</span>
	);
}
