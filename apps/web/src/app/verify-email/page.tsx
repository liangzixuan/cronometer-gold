import type { Metadata } from "next";

import { EmailVerificationClient } from "./EmailVerificationClient";

export const metadata: Metadata = { referrer: "no-referrer" };

export default function VerifyEmailPage() {
  return (
    <main className="authPage">
      <EmailVerificationClient />
    </main>
  );
}
