import type { Metadata } from "next";

import { PasswordRecoveryClient } from "./PasswordRecoveryClient";

export const metadata: Metadata = { referrer: "no-referrer" };

export default function ResetPasswordPage() {
  return (
    <main className="authPage">
      <PasswordRecoveryClient />
    </main>
  );
}
