import { ErasureStatusClient } from "./ErasureStatusClient";

export const dynamic = "force-dynamic";

export default function ErasureStatusPage() {
  return (
    <main className="shell">
      <ErasureStatusClient />
    </main>
  );
}
