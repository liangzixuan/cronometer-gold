"use client";

import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState } from "react";

import { parseSession } from "../../lib/diary";

type Mode = "login" | "register";

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "The account request could not be completed. Please try again.";
  }
  const message = (value as Record<string, unknown>).error;
  return typeof message === "string" && message.length <= 500
    ? message
    : "The account request could not be completed. Please try again.";
}

export function AuthClient() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [timeZone, setTimeZone] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Sign in to open your private diary.");
  const [error, setError] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(false);
    setMessage(mode === "login" ? "Signing in…" : "Creating your account…");
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          email: email.normalize("NFKC").trim(),
          password,
          ...(mode === "register"
            ? {
                timeZone: timeZone.trim(),
                ...(displayName.trim()
                  ? { displayName: displayName.normalize("NFKC").trim() }
                  : {}),
              }
            : {}),
        }),
        cache: "no-store",
      });
      const body = await responseBody(response);
      if (!response.ok) {
        setError(true);
        setMessage(errorMessage(body));
        return;
      }
      const session = parseSession(body);
      if (mode === "register" && !session.user.emailVerified) {
        setMessage("Account ready. Opening email verification…");
        router.replace("/verify-email");
      } else {
        setMessage("Account ready. Opening your diary…");
        router.replace("/dashboard");
      }
      router.refresh();
    } catch {
      setError(true);
      setMessage("The account service is unavailable. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    if (busy) return;
    setMode(next);
    setError(false);
    setMessage(
      next === "login"
        ? "Sign in to open your private diary."
        : "Create an account with a password of at least 12 characters.",
    );
  }

  return (
    <section className="authCard" aria-labelledby="auth-title">
      <p className="kicker">Private nutrition ledger</p>
      <h1 id="auth-title">{mode === "login" ? "Welcome back." : "Start your diary."}</h1>
      <fieldset className="authTabs">
        <legend className="srOnly">Account action</legend>
        <button
          aria-pressed={mode === "login"}
          disabled={busy}
          onClick={() => switchMode("login")}
          type="button"
        >
          Sign in
        </button>
        <button
          aria-pressed={mode === "register"}
          disabled={busy}
          onClick={() => switchMode("register")}
          type="button"
        >
          Create account
        </button>
      </fieldset>
      <form onSubmit={submit}>
        <label htmlFor="account-email">Email</label>
        <input
          autoComplete="email"
          id="account-email"
          inputMode="email"
          maxLength={254}
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />
        <label htmlFor="account-password">Password</label>
        <input
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          id="account-password"
          maxLength={128}
          minLength={12}
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
        {mode === "register" ? (
          <>
            <label htmlFor="account-display-name">Display name (optional)</label>
            <input
              autoComplete="name"
              id="account-display-name"
              maxLength={100}
              onChange={(event) => setDisplayName(event.target.value)}
              type="text"
              value={displayName}
            />
            <label htmlFor="account-time-zone">Diary time zone</label>
            <input
              aria-describedby="time-zone-help"
              autoComplete="off"
              id="account-time-zone"
              maxLength={63}
              onChange={(event) => setTimeZone(event.target.value)}
              required
              spellCheck={false}
              type="text"
              value={timeZone}
            />
            <small id="time-zone-help">
              IANA name, such as America/Chicago. This decides which local day receives an entry.
            </small>
          </>
        ) : null}
        <button className="authSubmit" disabled={busy} type="submit">
          {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
      <p className={error ? "authStatus authStatus--error" : "authStatus"} role="status">
        {message}
      </p>
      <p className="privacyCopy">
        Your bearer session stays in a Secure, HttpOnly cookie and is never exposed to page scripts.
      </p>
    </section>
  );
}
