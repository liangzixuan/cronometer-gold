"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { useState } from "react";

import { requestPasswordRecovery } from "../../lib/password-recovery";

const ACCEPTED_MESSAGE =
  "If an eligible account can receive recovery email, check your inbox for the newest link.";

export function PasswordRecoveryRequestClient() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [message, setMessage] = useState(
    "Enter your account email. The response never reveals whether an account exists.",
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(false);
    setMessage("Requesting a recovery email…");
    try {
      const outcome = await requestPasswordRecovery(email);
      if (outcome.kind === "rejected") {
        setError(true);
        setMessage(outcome.problem.message);
        return;
      }
      setEmail("");
      setMessage(ACCEPTED_MESSAGE);
    } catch {
      setError(true);
      setMessage("Password recovery is temporarily unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="authCard recoveryCard" aria-labelledby="recovery-request-title">
      <p className="kicker">Account recovery</p>
      <h1 id="recovery-request-title">Reset your password.</h1>
      <form onSubmit={submit}>
        <label htmlFor="recovery-email">Email</label>
        <input
          autoComplete="email"
          id="recovery-email"
          inputMode="email"
          maxLength={254}
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />
        <button className="authSubmit" disabled={busy} type="submit">
          {busy ? "Please wait…" : "Send recovery email"}
        </button>
      </form>
      <p className={error ? "authStatus authStatus--error" : "authStatus"} role="status">
        {message}
      </p>
      <div className="recoveryActions">
        <Link className="textLink" href="/login">
          Return to sign in
        </Link>
      </div>
      <p className="privacyCopy">
        No account status is disclosed. Use only the newest link, and enter the new password on the
        reset page rather than in email.
      </p>
    </section>
  );
}
