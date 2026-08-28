import type { Metadata } from "next";
import Link from "next/link";

import { SiteDocument } from "@/app/site-document";
import { SITE_NAME, SITE_URL } from "@/lib/seo";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: `Page not found - ${SITE_NAME}`,
  robots: { index: false, follow: false },
};

export default function GlobalNotFound() {
  return (
    <SiteDocument lang="en">
      <main className="flex min-h-screen items-center justify-center bg-night px-6 text-moon">
        <div className="max-w-md text-center">
          <p className="font-mono text-sm text-moon/55">404</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">Page not found</h1>
          <p className="mt-3 text-sm leading-6 text-moon/65">
            The page you requested is not part of the Y Space site.
          </p>
          <Link
            href="/"
            className="mt-7 inline-flex rounded-lg border border-moon/15 bg-moon/10 px-4 py-2 text-sm font-medium transition hover:bg-moon/15"
          >
            Return home
          </Link>
        </div>
      </main>
    </SiteDocument>
  );
}
