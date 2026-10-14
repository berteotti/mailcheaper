import Link from "next/link";
import LogoMailcheap from "@/components/LogoMailcheap";
import { cn } from "@/lib/utils";

export default function LogoWordmark({ href, className, children }) {
	const Wordmark = href ? Link : "span";

	return (
		<Wordmark href={href} className={cn("flex items-center gap-2", className)}>
			<LogoMailcheap />
			<span className="text-[17px] font-semibold tracking-tight">MailCheap</span>
			{children}
		</Wordmark>
	);
}
