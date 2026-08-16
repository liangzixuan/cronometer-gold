import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE } from "../../lib/private-api";
import { DiaryClient } from "./DiaryClient";

// User-owned diary data is always rendered dynamically behind the host-only session guard.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const cookieStore = await cookies();
  if (!cookieStore.has(SESSION_COOKIE)) redirect("/login");

  return (
    <main className="shell">
      <DiaryClient />
    </main>
  );
}
