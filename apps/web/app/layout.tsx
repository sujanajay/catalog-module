import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/Toast";
import UserMenu from "@/components/UserMenu";
import { ViewerPreviewProvider } from "@/components/ViewerPreview";
import { SessionEndedToast } from "@/lib/fetch";
import { currentUser } from "@/lib/user";
import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Catalog images",
  description: "Opptra marketplace catalog images",
};

// Every page shows who is signed in, read from the IAP JWT on each request, so nothing is ever
// prerendered at build time (headers() alone would also opt out; this makes it explicit).
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  // IAP signs everyone in before a request reaches the app, so the 401/403 this can throw is
  // normally unreachable.
  const user = await currentUser();
  return (
    <html lang="en" className={fontVariables}>
      <body>
        <ToastProvider>
          <ViewerPreviewProvider>
            <header className="top">
              <div className="in">
                <Link className="logo" href="/catalog">
                  Opptra
                </Link>
                <nav className="nav" aria-label="Main">
                  <Link className="on" href="/catalog">
                    Catalog images
                  </Link>
                </nav>
                <UserMenu email={user.email} role={user.role} />
              </div>
            </header>
            {children}
            <SessionEndedToast />
          </ViewerPreviewProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
