import { ImageResponse } from "next/og";
import geistRegularUrl from "@/assets/fonts/Geist-Regular.ttf?inline";
import geistSemiBoldUrl from "@/assets/fonts/Geist-SemiBold.ttf?inline";
import { countReaders, getArchiveIssue, getArchiveNewsletter } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getIssueDate } from "@/lib/archive-issues";
import { SHARE_IMAGE_SIZE } from "@/lib/archive-seo";
import { formatDate, formatNumber } from "@/lib/format";
import { readLogo } from "@/lib/og-image";
import { getIssueBackground, getShareCardColors } from "@/lib/share-card";
import { THEME_MODES, resolveTheme } from "@/lib/themes";

// Bundled into the Worker as data URLs: a deployed Worker has no project checkout to read files from.
const fromDataUrl = (url) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
const [geistRegular, geistSemiBold] = [fromDataUrl(geistRegularUrl), fromDataUrl(geistSemiBoldUrl)];
const FONTS = [
	{ name: "Geist", data: geistRegular, weight: 400, style: "normal" },
	{ name: "Geist", data: geistSemiBold, weight: 600, style: "normal" },
];

// Share card for the archive home, and for issues that have no thumbnail of their own: in the mode the theme is made
// for, or ?m= another of its modes, which the website shows its readers in that mode.
export async function GET(request, { params }) {
	const { slug } = await params;
	const newsletter = await getArchiveNewsletter(slug);
	if (!newsletter) return new Response("Not found", { status: 404 });

	const { searchParams } = new URL(request.url);
	const postSlug = searchParams.get("p");
	const issue = postSlug ? await getArchiveIssue(newsletter, postSlug) : null;
	if (postSlug && !issue) return new Response("Not found", { status: 404 });

	const [logo, readers] = await Promise.all([readLogo(newsletter.imageUrl), countReaders(newsletter)]);
	const domain = new URL(getArchiveUrls(newsletter).siteIndex).host;
	const footer = issue ? formatDate(getIssueDate(issue)) : readers >= 100 ? `Join ${formatNumber(readers)} readers` : "";
	const theme = resolveTheme(newsletter.theme);
	const mode = THEME_MODES.includes(searchParams.get("m")) ? searchParams.get("m") : theme.mode;
	const colors = getShareCardColors(theme, mode);

	return new ImageResponse(
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				justifyContent: "space-between",
				padding: 72,
				backgroundColor: colors.background,
				...(issue && { backgroundImage: getIssueBackground(issue.archiveSlug, theme, mode) }),
				fontFamily: "Geist",
				color: colors.foreground,
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 20 }}>
				{logo && (
					// eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain <img>
					<img
						src={logo}
						width={issue ? 64 : 112}
						height={issue ? 64 : 112}
						style={{ borderRadius: issue ? 16 : 28, border: `1px solid ${colors.border}` }}
						alt=""
					/>
				)}
				{issue && <span style={{ fontSize: 32, fontWeight: 600 }}>{newsletter.name}</span>}
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 1000 }}>
				<span
					style={{
						fontSize: issue ? 64 : 88,
						fontWeight: 600,
						lineHeight: 1.08,
						letterSpacing: issue ? -2 : -3,
					}}
				>
					{issue ? issue.subject : newsletter.name}
				</span>
				{(issue ? issue.previewText : newsletter.description) && (
					<span style={{ fontSize: 32, lineHeight: 1.35, color: colors.muted }}>
						{issue ? issue.previewText : newsletter.description}
					</span>
				)}
			</div>

			<div style={{ display: "flex", justifyContent: "space-between", fontSize: 28, color: colors.muted }}>
				<span>{footer}</span>
				<span>{domain}</span>
			</div>
		</div>,
		{
			...SHARE_IMAGE_SIZE,
			fonts: FONTS,
			headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
		}
	);
}
