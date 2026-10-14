import { Skeleton } from "@/components/ui/skeleton";

// As tall as the add domain form, so the page doesn't move when it streams in.
export default function SkeletonDomains() {
	return <Skeleton className="h-[385px] rounded-xl sm:h-[265px]" />;
}
