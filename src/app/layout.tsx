import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { logger } from "@/shared/logger";

// Self-hosted (latin subset, from Fontsource 5.3.0; OFL licenses in
// ./fonts). next/font/google downloaded them at build time, and a failed
// download broke CI builds; now the build needs no network for fonts and
// visitors' browsers never call Google.

const inter = localFont({
  src: "./fonts/inter-latin-opsz-wght.woff2", // variable: opsz + wght
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

const intelOneMono = localFont({
  src: [
    { path: "./fonts/intel-one-mono-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/intel-one-mono-latin-500-normal.woff2", weight: "500" },
  ],
  variable: "--font-intel-mono",
  display: "swap",
  // next/font has no metrics to build an adjusted fallback for this font,
  // so use plain system monospace instead.
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
});

const syne = localFont({
  src: "./fonts/syne-latin-800-normal.woff2",
  variable: "--font-syne",
  weight: "800",
  display: "swap",
});

export const metadata: Metadata = {
  title: "codedriven · AI Codebase Auditor",
  description:
    "An AI Senior developer that understands your codebase - health reports, issues, and chat grounded in your real code.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Set by the proxy on every page request (CSP, TD-34): next-themes puts it
  // on the inline script that applies the theme before paint.
  const requestHeaders = await headers();
  const nonce = requestHeaders.get("x-nonce") ?? undefined;
  // TEMPORARY (TD-34 diagnosis, remove before merge): which CSP headers the
  // render receives on Vercel. Policies only, no secrets.
  logger.info("csp.render_headers", {
    xNonce: Boolean(nonce),
    csp: requestHeaders.get("content-security-policy")?.slice(0, 60) ?? null,
    cspReportOnly: requestHeaders.get("content-security-policy-report-only")?.slice(0, 60) ?? null,
    overrides: requestHeaders.get("x-middleware-override-headers")?.slice(0, 200) ?? null,
  });

  return (
    <>
      <html
        className={`${inter.variable} ${intelOneMono.variable} ${syne.variable}`}
        lang="en"
        suppressHydrationWarning
      >
        <head />
        <body>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
            nonce={nonce}
          >
            {children}
            <Toaster />
          </ThemeProvider>
        </body>
      </html>
    </>
  );
}
