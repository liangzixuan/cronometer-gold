import type { Metadata } from "next";
import { headers } from "next/headers";
import Script from "next/script";
import type { ReactNode } from "react";

import { EMAIL_VERIFICATION_BOOTSTRAP_SCRIPT } from "../lib/email-verification";
import { PASSWORD_RECOVERY_BOOTSTRAP_SCRIPT } from "../lib/password-recovery";
import "./styles.css";

// Per-request CSP nonces require request-time rendering so every Next script receives the nonce.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nutrition Tracker",
  description: "Provenance-first nutrition tracking",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en">
      <body>
        {children}
        <Script
          id="email-verification-fragment-bootstrap"
          nonce={nonce}
          strategy="beforeInteractive"
        >
          {EMAIL_VERIFICATION_BOOTSTRAP_SCRIPT}
        </Script>
        <Script
          id="password-recovery-fragment-bootstrap"
          nonce={nonce}
          strategy="beforeInteractive"
        >
          {PASSWORD_RECOVERY_BOOTSTRAP_SCRIPT}
        </Script>
      </body>
    </html>
  );
}
