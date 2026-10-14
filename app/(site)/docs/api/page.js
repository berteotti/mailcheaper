import CardEndpoint from "@/components/CardEndpoint";
import HeaderDocs from "@/components/HeaderDocs";
import { API_BASE_PATH } from "@/lib/api/rest";
import { getAppUrl } from "@/lib/config";
import { getDocsPageMetadata } from "@/lib/docs/llms";
import { getEndpointGroups } from "@/lib/docs/reference";

// Rendered when asked: APP_URL is set where the Worker runs, not where it's built, so a build-time render would
// carry the wrong address.
export const dynamic = "force-dynamic";

export const metadata = getDocsPageMetadata("/docs/api");

export default function ApiReferencePage() {
	const appUrl = getAppUrl();

	return (
		<>
			<HeaderDocs kicker="Reference" title="API reference">
				Base URL <code className="font-mono text-[15px] text-foreground">{`${appUrl}${API_BASE_PATH}`}</code>. Bodies are JSON; GET and
				DELETE take their parameters in the query string. Each endpoint is also the MCP tool named under it. The same reference as{" "}
				<a href={`${API_BASE_PATH}/openapi.json`} className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4">
					OpenAPI 3.1
				</a>
				.
			</HeaderDocs>

			<div className="flex flex-col gap-16">
				{getEndpointGroups(appUrl).map(({ group, slug, description, endpoints }) => (
					<section key={slug} id={slug} className="scroll-mt-20">
						<div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-3">
							<h2 className="text-2xl font-semibold tracking-tight">{group}</h2>
							<p className="text-sm text-muted-foreground">{description}</p>
						</div>
						{endpoints.map((endpoint) => (
							<CardEndpoint key={endpoint.name} endpoint={endpoint} />
						))}
					</section>
				))}
			</div>
		</>
	);
}
