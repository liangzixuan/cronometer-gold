import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE } from "../../lib/private-api";
import { HydrationClient } from "./HydrationClient";

export const dynamic = "force-dynamic";

interface HydrationPageProps {
  readonly searchParams: Promise<{ readonly date?: string | readonly string[] }>;
}

export default async function HydrationPage({ searchParams }: HydrationPageProps) {
  const cookieStore = await cookies();
  if (!cookieStore.has(SESSION_COOKIE)) redirect("/login");
  const { date } = await searchParams;
  return (
    <main className="shell">
      <HydrationClient {...(typeof date === "string" ? { initialDate: date } : {})} />
    </main>
  );
}
