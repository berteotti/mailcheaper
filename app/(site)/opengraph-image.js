import { ImageResponse } from "next/og";
import geistRegularUrl from "@/assets/fonts/Geist-Regular.ttf?inline";
import geistSemiBoldUrl from "@/assets/fonts/Geist-SemiBold.ttf?inline";
import { LOGO_FACETS, LOGO_SHADE, LOGO_VIEWBOX } from "@/components/LogoMailcheap";
import { getAppHost } from "@/lib/config";

// Rendered when asked: APP_URL is set where the Worker runs, not where it's built, so a build-time render would
// carry the wrong address.
export const dynamic = "force-dynamic";

// The docs' card on every server: what they cover and the server's own address. MailCheap Cloud's marketing pages
// have their own card.
export const alt = "MailCheap docs: the REST API and the MCP server";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const COLORS = { site: "#fafafa", ink: "#0a0a0a", muted: "#6b6b6b" };
// Bundled into the Worker as data URLs: a deployed Worker has no project checkout to read files from.
const fromDataUrl = (url) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
const [geistRegular, geistSemiBold] = [fromDataUrl(geistRegularUrl), fromDataUrl(geistSemiBoldUrl)];

function Logo() {
	return (
		<svg width="48" height="48" viewBox={LOGO_VIEWBOX}>
			<path d={LOGO_FACETS.upper} fill={COLORS.ink} />
			<path d={LOGO_FACETS.lower} fill={COLORS.ink} fillOpacity={LOGO_SHADE} />
		</svg>
	);
}

export default async function Image() {
	return new ImageResponse(
		<div
			style={{
				display: "flex",
				width: "100%",
				height: "100%",
				backgroundColor: COLORS.site,
				backgroundImage: "radial-gradient(circle at 1px 1px, rgba(10,10,10,0.09) 1.5px, transparent 0)",
				backgroundSize: "28px 28px",
				fontFamily: "Geist",
				color: COLORS.ink,
			}}
		>
			<div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 1056, height: "100%", padding: "64px 0 60px 72px" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 16 }}>
					<Logo />
					<span style={{ fontSize: 32, fontWeight: 600, letterSpacing: -1 }}>MailCheap</span>
				</div>
				<div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
					<span style={{ fontSize: 64, fontWeight: 600, lineHeight: 1.06, letterSpacing: -2.4 }}>Everything the dashboard does, from code or an AI agent</span>
					<span style={{ fontSize: 30, lineHeight: 1.35, color: COLORS.muted }}>The REST API and the MCP server, documented.</span>
				</div>
				<span style={{ fontSize: 24, color: COLORS.muted }}>{getAppHost()}</span>
			</div>
		</div>,
		{
			...size,
			fonts: [
				{ name: "Geist", data: geistRegular, weight: 400, style: "normal" },
				{ name: "Geist", data: geistSemiBold, weight: 600, style: "normal" },
			],
		}
	);
}
