import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { SessionSummary } from "../diary/diary";
import { palette } from "../theme";
import {
  createEmailVerificationActionFence,
  type EmailVerificationSessionUpdate,
  EmailVerificationUnauthorizedError,
  loadEmailVerificationSession,
  requestAndReconcileEmailVerification,
} from "./email-verification";

interface EmailVerificationScreenProps {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly session: SessionSummary;
  readonly sessionEpoch: number;
  readonly onSessionUpdated: (update: EmailVerificationSessionUpdate) => void;
  readonly onUnauthorized: () => Promise<void>;
}

type BusyAction = "refresh" | "request" | null;

export function EmailVerificationScreen({
  apiBase,
  accessToken,
  session,
  sessionEpoch,
  onSessionUpdated,
  onUnauthorized,
}: EmailVerificationScreenProps) {
  const actionFence = useRef<ReturnType<typeof createEmailVerificationActionFence> | null>(null);
  if (actionFence.current === null) actionFence.current = createEmailVerificationActionFence();
  const activeRequests = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  const currentContext = useRef({
    emailVerified: session.user.emailVerified,
    sessionEpoch,
    userId: session.user.id,
  });
  currentContext.current = {
    emailVerified: session.user.emailVerified,
    sessionEpoch,
    userId: session.user.id,
  };
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState(false);
  const [message, setMessage] = useState(
    session.user.emailVerified
      ? "Your email address is verified."
      : "Request an email, then open its exact one-time link in your device browser.",
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of activeRequests.current) controller.abort();
      activeRequests.current.clear();
    };
  }, []);

  useEffect(() => {
    currentContext.current = {
      emailVerified: session.user.emailVerified,
      sessionEpoch,
      userId: session.user.id,
    };
    actionFence.current = createEmailVerificationActionFence();
    setBusy(null);
    setError(false);
    setMessage(
      session.user.emailVerified
        ? "Your email address is verified."
        : "Request an email, then open its exact one-time link in your device browser.",
    );
    return () => {
      for (const controller of activeRequests.current) controller.abort();
      activeRequests.current.clear();
    };
  }, [session.user.emailVerified, session.user.id, sessionEpoch]);

  const refresh = useCallback((): Promise<void> => {
    if (session.user.emailVerified) return Promise.resolve();
    const initiatingSessionEpoch = sessionEpoch;
    const initiatingUserId = session.user.id;
    return (
      actionFence.current?.run(async () => {
        const contextIsCurrent = () =>
          mounted.current &&
          currentContext.current.sessionEpoch === initiatingSessionEpoch &&
          currentContext.current.userId === initiatingUserId;
        if (!contextIsCurrent() || currentContext.current.emailVerified) return;
        const controller = new AbortController();
        activeRequests.current.add(controller);
        setBusy("refresh");
        setError(false);
        setMessage("Checking verification status…");
        try {
          const refreshed = await loadEmailVerificationSession(apiBase, accessToken, {
            signal: controller.signal,
          });
          if (!contextIsCurrent() || controller.signal.aborted) return;
          if (refreshed.user.id !== initiatingUserId) {
            setError(true);
            setMessage("Verification status could not be refreshed. Please sign in again.");
            return;
          }
          onSessionUpdated({
            initiatingSessionEpoch,
            initiatingUserId,
            session: refreshed,
          });
          if (refreshed.user.emailVerified) {
            setMessage("Your email address is verified.");
          } else {
            setMessage("Not verified yet. Open the newest link from your email and check again.");
          }
        } catch (caught) {
          if (!contextIsCurrent() || controller.signal.aborted) return;
          if (caught instanceof EmailVerificationUnauthorizedError) {
            await onUnauthorized();
            return;
          }
          setError(true);
          setMessage(
            caught instanceof Error
              ? caught.message
              : "Verification status could not be refreshed. Try again when connected.",
          );
        } finally {
          activeRequests.current.delete(controller);
          if (contextIsCurrent() && !controller.signal.aborted) setBusy(null);
        }
      }) ?? Promise.resolve()
    );
  }, [
    accessToken,
    apiBase,
    onSessionUpdated,
    onUnauthorized,
    session.user.emailVerified,
    session.user.id,
    sessionEpoch,
  ]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && !session.user.emailVerified) void refresh();
    });
    return () => subscription.remove();
  }, [refresh, session.user.emailVerified]);

  async function requestEmail() {
    if (session.user.emailVerified) return;
    const initiatingSessionEpoch = sessionEpoch;
    const initiatingUserId = session.user.id;
    await actionFence.current?.run(async () => {
      const contextIsCurrent = () =>
        mounted.current &&
        currentContext.current.sessionEpoch === initiatingSessionEpoch &&
        currentContext.current.userId === initiatingUserId;
      if (!contextIsCurrent() || currentContext.current.emailVerified) return;
      const controller = new AbortController();
      activeRequests.current.add(controller);
      setBusy("request");
      setError(false);
      setMessage("Requesting a fresh verification email…");
      try {
        const result = await requestAndReconcileEmailVerification(apiBase, accessToken, {
          signal: controller.signal,
        });
        if (!contextIsCurrent() || controller.signal.aborted) return;
        if (result.kind === "unknown" || result.session.user.id !== initiatingUserId) {
          setMessage(
            "The request was accepted, but verification status could not be refreshed. Check your account status and inbox before requesting again.",
          );
          return;
        }
        onSessionUpdated({
          initiatingSessionEpoch,
          initiatingUserId,
          session: result.session,
        });
        if (result.kind === "verified") {
          setMessage("Your email address is verified; no new email is needed.");
        } else {
          setMessage(
            "A fresh link was accepted for delivery. Open the newest email in your device browser; older links no longer work.",
          );
        }
      } catch (caught) {
        if (!contextIsCurrent() || controller.signal.aborted) return;
        if (caught instanceof EmailVerificationUnauthorizedError) {
          await onUnauthorized();
          return;
        }
        setError(true);
        setMessage(
          caught instanceof Error
            ? caught.message
            : "A verification email could not be requested. Please try again.",
        );
      } finally {
        activeRequests.current.delete(controller);
        if (contextIsCurrent() && !controller.signal.aborted) setBusy(null);
      }
    });
  }

  const verified = session.user.emailVerified;
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.kicker}>ACCOUNT EMAIL</Text>
        <Text accessibilityRole="header" style={styles.title}>
          {verified ? "Email verified." : "Verify your email."}
        </Text>
        <View style={[styles.statusCard, verified && styles.statusCardVerified]}>
          <Text style={styles.email}>{session.user.email}</Text>
          <Text style={verified ? styles.verified : styles.unverified}>
            {verified ? "Verified" : "Not verified"}
          </Text>
        </View>
        <Text accessibilityLiveRegion="polite" style={[styles.message, error && styles.error]}>
          {message}
        </Text>
        {!verified ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy !== null }}
              disabled={busy !== null}
              onPress={() => void requestEmail()}
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
            >
              {busy === "request" ? <ActivityIndicator color={palette.white} /> : null}
              <Text style={styles.primaryText}>
                {busy === "request" ? "Please wait…" : "Send verification email"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy !== null }}
              disabled={busy !== null}
              onPress={() => void refresh()}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              {busy === "refresh" ? <ActivityIndicator color={palette.forest} /> : null}
              <Text style={styles.secondaryText}>
                {busy === "refresh" ? "Checking…" : "Check verification status"}
              </Text>
            </Pressable>
          </>
        ) : null}
        <Text style={styles.help}>
          The one-time token stays in the email link and is confirmed by the website in your system
          browser. This app does not accept verification deep links or gate diary access while the
          address is unverified. Return here after using the link; status refreshes when the app
          becomes active.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 28, paddingBottom: 64 },
  email: { color: palette.ink, fontSize: 15, fontWeight: "700" },
  error: { color: "#8a3128" },
  help: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 28 },
  kicker: { color: palette.forest, fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  message: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 20 },
  pressed: { opacity: 0.78 },
  primary: {
    alignItems: "center",
    backgroundColor: palette.forest,
    borderRadius: 999,
    flexDirection: "row",
    gap: 9,
    justifyContent: "center",
    marginTop: 28,
    minHeight: 52,
    paddingHorizontal: 18,
  },
  primaryText: { color: palette.white, fontSize: 15, fontWeight: "800" },
  screen: { backgroundColor: palette.paper, flex: 1 },
  secondary: {
    alignItems: "center",
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 9,
    justifyContent: "center",
    marginTop: 12,
    minHeight: 50,
    paddingHorizontal: 18,
  },
  secondaryText: { color: palette.forest, fontSize: 14, fontWeight: "800" },
  statusCard: {
    backgroundColor: "#fff4dd",
    borderColor: palette.line,
    borderRadius: 14,
    borderWidth: 1,
    gap: 6,
    marginTop: 28,
    padding: 18,
  },
  statusCardVerified: { backgroundColor: "#e2f1dc" },
  title: {
    color: palette.ink,
    fontSize: 44,
    fontWeight: "700",
    letterSpacing: -1.8,
    lineHeight: 47,
    marginTop: 12,
  },
  unverified: { color: "#7c5110", fontSize: 13, fontWeight: "800" },
  verified: { color: "#245a3a", fontSize: 13, fontWeight: "800" },
});
