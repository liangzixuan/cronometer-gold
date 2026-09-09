import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE } from "../../lib/private-api";
import { ActivityClient } from "./ActivityClient";

export const dynamic = "force-dynamic";

interface ActivityPageProps {
  readonly searchParams: Promise<{ readonly date?: string | readonly string[] }>;
}

export default async function ActivityPage({ searchParams }: ActivityPageProps) {
  const cookieStore = await cookies();
  if (!cookieStore.has(SESSION_COOKIE)) redirect("/login");
  const { date } = await searchParams;
  return (
    <main className="shell">
      <ActivityClient {...(typeof date === "string" ? { initialDate: date } : {})} />
    </main>
  );
}
