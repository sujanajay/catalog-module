// Fonts from spec 01 "Global frame": headings in Spectral, body in Raleway. Loaded with next/font so
// they are self-hosted at build time (no request to Google from the browser). The root layout puts
// `fontVariables` on <html>; globals.css reads --font-spectral and --font-raleway.
import { Raleway, Spectral } from "next/font/google";

const spectral = Spectral({
  subsets: ["latin"],
  weight: ["300", "600", "700"],
  display: "swap",
  variable: "--font-spectral",
});

const raleway = Raleway({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-raleway",
});

export const fontVariables = `${spectral.variable} ${raleway.variable}`;
