import type { Metadata } from "next";
import Link from "next/link";

import { PasswordRecoveryRequestClient } from "./PasswordRecoveryRequestClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

export default function ForgotPasswordPage() {
  return (
    <main className="authPage">
      <nav className="nav" aria-label="Account navigation">
        <Link className="brand brandDark" href="/">
          nutrition<span>/ledger</span>
        </Link>
        <Link className="textLink" href="/login">
          Sign in
        </Link>
      </nav>
      <PasswordRecoveryRequestClient />
    </main>
  );
}
