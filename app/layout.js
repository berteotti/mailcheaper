import { Geist, Geist_Mono } from "next/font/google";
import ProviderTheme from "@/components/ProviderTheme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APP_NAME } from "@/lib/config";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// The icon files in app/ apply wherever a page sets no icons; archive pages set the newsletter's logo.
// favicon.ico sits in public/ because Next links app/favicon.ico on every page, archive pages included.
export const metadata = {
	title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
	robots: { index: false, follow: false },
};

// Where browsers support it (Chrome on Android), the on-screen keyboard shrinks the page instead of covering it, so a
// dialog's actions stay above the keyboard.
export const viewport = { interactiveWidget: "resizes-content" };

export default function RootLayout({ children }) {
	return (
		<html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable}`}>
			<body className="min-h-dvh bg-background text-foreground">
				<ProviderTheme>
					<TooltipProvider delayDuration={200}>{children}</TooltipProvider>
					<Toaster position="bottom-right" />
				</ProviderTheme>
			</body>
		</html>
	);
}
