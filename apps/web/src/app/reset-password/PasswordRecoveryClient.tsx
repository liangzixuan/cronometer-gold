"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  createPasswordRecoveryFragmentCoordinator,
  isValidNewPassword,
  type PasswordRecoverySubmissionCapability,
} from "../../lib/password-recovery";

export type RecoveryState =
  | "checking"
  | "expired"
  | "invalid"
  | "missing"
  | "rate_limited"
  | "ready"
  | "success"
  | "unavailable";

export function passwordRecoveryHeading(state: RecoveryState): string {
  switch (state) {
    case "checking":
      return "Checking your recovery link.";
    case "expired":
      return "Recovery link expired.";
    case "invalid":
      return "Recovery link invalid.";
    case "missing":
      return "Recovery link required.";
    case "rate_limited":
      return "Try again shortly.";
    case "ready":
      return "Choose a new password.";
    case "success":
      return "Password reset.";
    case "unavailable":
      return "Password reset interrupted.";
  }
}

export function PasswordRecoveryClient() {
  const capability = useRef<PasswordRecoverySubmissionCapability | null>(null);
  const confirmationInput = useRef<HTMLInputElement | null>(null);
  const coordinator = useRef<ReturnType<typeof createPasswordRecoveryFragmentCoordinator> | null>(
    null,
  );
  const heading = useRef<HTMLHeadingElement | null>(null);
  const mounted = useRef(true);
  const newPasswordInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [fieldErrorTarget, setFieldErrorTarget] = useState<"confirmation" | "password" | null>(
    null,
  );
  const [historySafe, setHistorySafe] = useState(false);
  const [message, setMessage] = useState("Checking your recovery link…");
  const [newPassword, setNewPassword] = useState("");
  const [recoveryState, setRecoveryState] = useState<RecoveryState>("checking");

  useLayoutEffect(() => {
    mounted.current = true;
    if (coordinator.current === null) {
      coordinator.current = createPasswordRecoveryFragmentCoordinator(window, (outcome) => {
        setHistorySafe(outcome.historySafe);
        setBusy(false);
        setConfirmation("");
        setFieldError("");
        setFieldErrorTarget(null);
        setNewPassword("");
        capability.current = outcome.kind === "ready" ? outcome.capability : null;
        switch (outcome.kind) {
          case "ready":
            setRecoveryState("ready");
            setMessage("Choose a new password for this account.");
            return;
          case "missing":
            setRecoveryState("missing");
            setMessage("This page needs a recovery link from email. Request a new one.");
            return;
          case "invalid":
            setRecoveryState("invalid");
            setMessage("This recovery link is invalid or has already been used.");
            return;
          case "scrub_failed":
            setRecoveryState("unavailable");
            setMessage(
              "This browser could not safely clear the recovery link. Close this page and request a new link.",
            );
        }
      });
    }
    const activeCoordinator = coordinator.current;
    activeCoordinator.start();
    return () => {
      mounted.current = false;
      activeCoordinator.stop();
    };
  }, []);

  useEffect(() => {
    if (historySafe && recoveryState !== "checking") heading.current?.focus();
  }, [historySafe, recoveryState]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const activeCapability = capability.current;
    if (busy || !activeCapability) return;
    if (!isValidNewPassword(newPassword)) {
      setFieldError("Use between 12 and 128 characters for the new password.");
      setFieldErrorTarget("password");
      newPasswordInput.current?.focus();
      return;
    }
    if (confirmation !== newPassword) {
      setFieldError("The password confirmation does not match.");
      setFieldErrorTarget("confirmation");
      confirmationInput.current?.focus();
      return;
    }

    setBusy(true);
    setFieldError("");
    setFieldErrorTarget(null);
    setMessage("Resetting your password…");
    const outcome = await activeCapability.submit(newPassword);
    if (!mounted.current || capability.current !== activeCapability) return;
    setBusy(false);
    if (!outcome.retryable) capability.current = null;
    switch (outcome.kind) {
      case "success":
        setConfirmation("");
        setNewPassword("");
        setRecoveryState("success");
        setMessage("Your password was reset. All previous sessions were closed; sign in again.");
        return;
      case "expired":
        setConfirmation("");
        setNewPassword("");
        setRecoveryState("expired");
        setMessage("This recovery link has expired. Request a new one.");
        return;
      case "invalid":
        setConfirmation("");
        setNewPassword("");
        setRecoveryState("invalid");
        setMessage("This recovery link is invalid or has already been used.");
        return;
      case "rate_limited":
        setRecoveryState("rate_limited");
        setMessage("Password recovery is temporarily busy. Wait a moment and try again.");
        return;
      case "validation":
        setFieldError("Use between 12 and 128 characters for the new password.");
        setFieldErrorTarget("password");
        setRecoveryState("ready");
        newPasswordInput.current?.focus();
        return;
      case "unavailable":
        setRecoveryState("unavailable");
        setMessage(
          outcome.retryable
            ? "The reset result could not be confirmed. You can retry while this page stays open; if a retry says the link was used, try signing in with the new password."
            : "The account service returned an invalid response. Request a new recovery link.",
        );
    }
  }

  const formAvailable =
    capability.current !== null &&
    (recoveryState === "ready" ||
      recoveryState === "rate_limited" ||
      recoveryState === "unavailable");
  const stateIsError =
    recoveryState === "expired" ||
    recoveryState === "invalid" ||
    recoveryState === "missing" ||
    recoveryState === "rate_limited" ||
    recoveryState === "unavailable";

  return (
    <>
      {historySafe ? (
        <nav className="nav" aria-label="Account navigation">
          <Link className="brand brandDark" href="/">
            nutrition<span>/ledger</span>
          </Link>
          <Link className="textLink" href="/login">
            Sign in
          </Link>
        </nav>
      ) : null}
      <section className="authCard recoveryCard" aria-labelledby="password-reset-title">
        <p className="kicker">Account recovery</p>
        <h1 id="password-reset-title" ref={heading} tabIndex={-1}>
          {passwordRecoveryHeading(recoveryState)}
        </h1>
        <p className={stateIsError ? "authStatus authStatus--error" : "authStatus"} role="status">
          {message}
        </p>
        {historySafe && formAvailable ? (
          <form onSubmit={submit}>
            <label htmlFor="recovery-new-password">New password</label>
            <input
              aria-describedby={
                fieldErrorTarget === "password"
                  ? "recovery-password-help recovery-password-error"
                  : "recovery-password-help"
              }
              aria-invalid={fieldErrorTarget === "password" ? true : undefined}
              autoComplete="new-password"
              disabled={busy}
              id="recovery-new-password"
              maxLength={256}
              minLength={12}
              onChange={(event) => setNewPassword(event.target.value)}
              ref={newPasswordInput}
              required
              type="password"
              value={newPassword}
            />
            <small id="recovery-password-help">
              Use between 12 and 128 characters. Spaces are preserved.
            </small>
            <label htmlFor="recovery-confirm-password">Confirm new password</label>
            <input
              aria-describedby={
                fieldErrorTarget === "confirmation" ? "recovery-password-error" : undefined
              }
              aria-invalid={fieldErrorTarget === "confirmation" ? true : undefined}
              autoComplete="new-password"
              disabled={busy}
              id="recovery-confirm-password"
              maxLength={256}
              minLength={12}
              onChange={(event) => setConfirmation(event.target.value)}
              ref={confirmationInput}
              required
              type="password"
              value={confirmation}
            />
            {fieldError ? (
              <p className="recoveryFieldError" id="recovery-password-error" role="alert">
                {fieldError}
              </p>
            ) : null}
            <button className="authSubmit" disabled={busy} type="submit">
              {busy ? "Please wait…" : "Reset password"}
            </button>
          </form>
        ) : null}
        {historySafe ? (
          <div className="recoveryActions">
            <Link className="textLink" href="/forgot-password">
              Request a new recovery link
            </Link>
            <Link className="textLink" href="/login">
              Sign in
            </Link>
          </div>
        ) : null}
        {historySafe ? (
          <p className="privacyCopy">
            The one-time token is read only from this page fragment, removed from browser history
            before this form appears, and retained only in this open page while a retry is safe.
          </p>
        ) : null}
      </section>
    </>
  );
}
