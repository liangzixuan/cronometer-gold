import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE } from "../../lib/private-api";
import { ReportsClient } from "./ReportsClient";

export const dynamic = "force-dynamic";

interface ReportsPageProps {
  readonly searchParams: Promise<{
    readonly from?: string | readonly string[];
    readonly to?: string | readonly string[];
  }>;
}

export default async function ReportsPage({ searchParams }: ReportsPageProps) {
  const cookieStore = await cookies();
  if (!cookieStore.has(SESSION_COOKIE)) redirect("/login");
  const { from, to } = await searchParams;
  return (
    <main className="shell">
      <ReportsClient
        {...(typeof from === "string" ? { initialFrom: from } : {})}
        {...(typeof to === "string" ? { initialTo: to } : {})}
      />
    </main>
  );
}
