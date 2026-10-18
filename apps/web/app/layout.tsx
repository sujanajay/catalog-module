import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import SessionEndedToast from "@/components/SessionEndedToast";
import { ToastProvider } from "@/components/Toast";
import UserMenu from "@/components/UserMenu";
import { ViewerPreviewProvider } from "@/components/ViewerPreview";
import { HttpError } from "@/lib/errors";
import { currentUser, type CurrentUser } from "@/lib/user";
import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Catalog images",
  description: "Opptra marketplace catalog images",
};

// Every page shows who is signed in, read from the IAP JWT on each request, so nothing is ever
// prerendered at build time (headers() alone would also opt out; this makes it explicit).
export const dynamic = "force-dynamic";

/**
 * The signed-in person, or the sentence to show instead of the app. IAP signs everyone in before a
 * request reaches the app, so a refusal is normally unreachable (a misconfigured IAP_AUDIENCE, or a
 * verified identity outside the domain). Without this the person would get a blank HTTP 500: Next
 * hides error messages in production and the root layout has no error boundary above it.
 */
async function signedIn(): Promise<CurrentUser | { refused: string }> {
  try {
    return await currentUser();
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return { refused: err.message };
    throw err;
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await signedIn();
  if ("refused" in user) {
    return (
      <html lang="en" className={fontVariables}>
        <body>
          <main>
            <p role="alert">{user.refused}</p>
          </main>
        </body>
      </html>
    );
  }
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
