// Fonts (UX design system section 8.2, decision U1): English headings in Spectral (identity); body and interface text in
// IBM Plex Sans, with its designed sibling IBM Plex Sans Arabic for Arabic, so the two languages read as one family
// (both under the SIL Open Font License). Loaded with next/font, so they are self-hosted at build time (no request to
// Google from the browser). The root layout puts `fontVariables` on <html>; globals.css reads the variables.
import { IBM_Plex_Sans, IBM_Plex_Sans_Arabic, Spectral } from "next/font/google";

const spectral = Spectral({
  subsets: ["latin"],
  weight: ["300", "600", "700"],
  display: "swap",
  variable: "--font-spectral",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-plex-sans",
});

// Arabic glyphs only. Not preloaded: the browser fetches it only when a page shows Arabic (its unicode-range), which
// today's English interface does only in content previews.
const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic"],
  weight: ["400", "500", "600"],
  display: "swap",
  preload: false,
  variable: "--font-plex-arabic",
});

export const fontVariables = `${spectral.variable} ${plexSans.variable} ${plexArabic.variable}`;
