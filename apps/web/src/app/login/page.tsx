import Link from "next/link";

import { AuthClient } from "./AuthClient";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="authPage">
      <nav className="nav" aria-label="Account navigation">
        <Link className="brand brandDark" href="/">
          nutrition<span>/ledger</span>
        </Link>
        <Link className="textLink" href="/foods">
          Browse foods
        </Link>
      </nav>
      <AuthClient />
    </main>
  );
}
