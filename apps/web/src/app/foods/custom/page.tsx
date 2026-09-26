import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "../../../lib/private-api";
import { CustomFoodsClient } from "./CustomFoodsClient";

export const dynamic = "force-dynamic";

export default async function CustomFoodsPage() {
  const cookieStore = await cookies();
  if (!cookieStore.has(SESSION_COOKIE)) redirect("/login");
  return (
    <main className="shell">
      <CustomFoodsClient />
    </main>
  );
}
