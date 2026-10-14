import HeaderPage from "@/components/HeaderPage";
import SkeletonDomains from "@/components/SkeletonDomains";

export default function Loading() {
	return (
		<>
			<HeaderPage title="Domains" />
			<SkeletonDomains />
		</>
	);
}
