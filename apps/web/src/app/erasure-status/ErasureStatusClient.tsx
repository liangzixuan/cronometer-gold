"use client";

import { useCallback, useEffect, useState } from "react";

import type { AccountErasureJob } from "../../lib/retention";
import { parseErasureJob } from "../../lib/retention";

async function statusResponse(signal?: AbortSignal): Promise<AccountErasureJob> {
  const recovery = await fetch("/api/retention/account/erasure/recover", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!recovery.ok && recovery.status !== 204) {
    const value: unknown = await recovery.json().catch(() => null);
    const message =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).error === "string"
        ? String((value as Record<string, unknown>).error)
        : "The protected erasure replay is temporarily unavailable.";
    throw new Error(message);
  }
  const response = await fetch("/api/retention/account/erasure/status", {
    cache: "no-store",
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).error === "string"
        ? String((value as Record<string, unknown>).error)
        : "Account-erasure status is unavailable.";
    throw new Error(message);
  }
  return parseErasureJob(value);
}

export function ErasureStatusClient() {
  const [job, setJob] = useState<AccountErasureJob | null>(null);
  const [message, setMessage] = useState("Checking the protected erasure status…");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setBusy(true);
    try {
      const next = await statusResponse(signal);
      setJob(next);
      setMessage(
        next.status === "completed"
          ? "Account erasure completed. The one-purpose status capability has been removed."
          : next.status === "failed"
            ? "Account erasure needs support. The one-purpose status capability has been removed."
            : "This page can be reopened after the main account session is revoked.",
      );
    } catch (error) {
      if (!signal?.aborted) {
        setMessage(
          error instanceof Error ? error.message : "Account-erasure status is unavailable.",
        );
      }
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return (
    <section className="retentionSection privacyCenter" aria-labelledby="erasure-status-heading">
      <div className="sectionHeading">
        <div>
          <p className="kicker">Privacy Center</p>
          <h1 id="erasure-status-heading">Account erasure status</h1>
        </div>
      </div>
      <p aria-live="polite">{message}</p>
      {job ? (
        <div className="jobStatus">
          <strong>Status: {job.status}</strong>
          <small>Requested {new Date(job.requestedAt).toLocaleString()}</small>
          <small>Scheduled no earlier than {new Date(job.executeAfter).toLocaleString()}</small>
          <small>{job.consequences.join(" · ")}</small>
        </div>
      ) : null}
      {job && job.status !== "completed" && job.status !== "failed" ? (
        <button disabled={busy} onClick={() => void refresh()} type="button">
          {busy ? "Checking…" : "Refresh status"}
        </button>
      ) : null}
    </section>
  );
}
