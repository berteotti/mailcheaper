// What mail apps in dark mode read an email's dark colors under (lib/render-email.js darkModeStyles).
export const DARK_MODE_QUERY = "@media (prefers-color-scheme: dark)";

// The email as a mail app in mode shows it, for previews: its dark colors always apply, or never. One already set to a
// mode stays in it.
export function withEmailMode(html, mode) {
	return html.replaceAll(DARK_MODE_QUERY, mode === "dark" ? "@media all" : "@media not all");
}
