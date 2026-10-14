import { Newsreader } from "next/font/google";

// Headlines on the public pages, sign-in and setup only, and no italic: with its optical sizes each style
// weighs about 130 KB. Its variable goes on the page's outer element, where font-display reads it.
export const newsreader = Newsreader({ variable: "--font-newsreader", subsets: ["latin"], axes: ["opsz"] });
