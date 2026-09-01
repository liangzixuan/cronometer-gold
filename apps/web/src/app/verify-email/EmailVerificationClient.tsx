"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";

import {
  createEmailVerificationFragmentCoordinator,
  requestAndReconcileEmailVerification,
} from "../../lib/email-verification";

type ConfirmationState = "checking" | "expired" | "invalid" | "ready" | "success" | "unavailable";

export function EmailVerificationClient() {
  const fragmentCoordinator = useRef<ReturnType<
    typeof createEmailVerificationFragmentCoordinator
  > | null>(null);
  const resendStarted = useRef(false);
  const [confirmationState, setConfirmationState] = useState<ConfirmationState>("checking");
  const [historySafe, setHistorySafe] = useState(false);
  const [message, setMessage] = useState("Checking your verification link…");
  const [resendBusy, setResendBusy] = useState(false);
  const [resendError, setResendError] = useState(false);
  const [resendMessage, setResendMessage] = useState("");

  useLayoutEffect(() => {
    if (fragmentCoordinator.current === null) {
      fragmentCoordinator.current = createEmailVerificationFragmentCoordinator(
        window,
        (outcome) => {
          setHistorySafe(outcome.historySafe);
          switch (outcome.kind) {
            case "success":
              setConfirmationState("success");
              setMessage("Your email address is verified. You can return to your diary.");
              return;
            case "expired":
              setConfirmationState("expired");
              setMessage(
                "This verification link has expired. Request a fresh email while signed in.",
              );
              return;
            case "invalid":
              setConfirmationState("invalid");
              setMessage("This verification link is invalid or has already been used.");
              return;
            case "ready":
              setConfirmationState("ready");
              setMessage("Send a verification email, then open its exact one-time link.");
              return;
            case "scrub_failed":
              setConfirmationState("unavailable");
              setMessage(
                "This browser could not safely clear the verification link. Close this page and try again.",
              );
              return;
            case "unavailable":
              setConfirmationState("unavailable");
              setMessage("Email verification is temporarily unavailable. Please try again.");
          }
        },
      );
    }
    const coordinator = fragmentCoordinator.current;
    coordinator.start();
    return () => coordinator.stop();
  }, []);

  async function resend() {
    if (resendStarted.current) return;
    resendStarted.current = true;
    setResendBusy(true);
    setResendError(false);
    setResendMessage("Requesting a fresh verification email…");
    try {
      const outcome = await requestAndReconcileEmailVerification();
      if (outcome.kind === "rejected") {
        setResendError(true);
        setResendMessage(outcome.problem.message);
        return;
      }
      if (outcome.status === "verified") {
        setConfirmationState("success");
        setMessage("Your email address is verified. You can return to your diary.");
        setResendMessage("Your account is already verified; no new email is needed.");
      } else if (outcome.status === "unverified") {
        setResendMessage(
          "A fresh link was accepted for delivery. Open the newest email; older links no longer work.",
        );
      } else {
        setResendMessage(
          "The request was accepted, but verification status could not be refreshed. Check your account status and inbox before requesting again.",
        );
      }
    } catch {
      setResendError(true);
      setResendMessage("A verification email could not be requested. Please try again.");
    } finally {
      resendStarted.current = false;
      setResendBusy(false);
    }
  }

  return (
    <>
      {historySafe ? (
        <nav className="nav" aria-label="Account navigation">
          <Link className="brand brandDark" href="/">
            nutrition<span>/ledger</span>
          </Link>
          <Link className="textLink" href="/dashboard">
            Open diary
          </Link>
        </nav>
      ) : null}
      <section className="authCard verificationCard" aria-labelledby="verification-title">
        <p className="kicker">Account email</p>
        <h1 id="verification-title">
          {confirmationState === "success" ? "Email verified." : "Verify your email."}
        </h1>
        <p
          className={
            confirmationState === "expired" ||
            confirmationState === "invalid" ||
            confirmationState === "unavailable"
              ? "authStatus authStatus--error"
              : "authStatus"
          }
          role="status"
        >
          {message}
        </p>
        {historySafe && confirmationState !== "success" && confirmationState !== "checking" ? (
          <button
            className="authSubmit verificationResend"
            disabled={resendBusy}
            onClick={() => void resend()}
            type="button"
          >
            {resendBusy ? "Please wait…" : "Send a new verification email"}
          </button>
        ) : null}
        {historySafe && resendMessage ? (
          <p className={resendError ? "authStatus authStatus--error" : "authStatus"} role="status">
            {resendMessage}
          </p>
        ) : null}
        {historySafe ? (
          <div className="verificationActions">
            <Link className="textLink" href="/dashboard">
              Return to diary
            </Link>
            <Link className="textLink" href="/login">
              Sign in
            </Link>
          </div>
        ) : null}
        {historySafe ? (
          <p className="privacyCopy">
            The one-time token is read only from this page fragment, removed from browser history
            before confirmation, and never placed in a query string.
          </p>
        ) : null}
      </section>
    </>
  );
}
