import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiUrl, jsonBody, responseError } from "../api/private-api";
import { isSupportedTimeZone, parseAuthResponse, type SessionSummary } from "../diary/diary";
import { palette } from "../theme";

type Mode = "login" | "register";

export interface AuthResult {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly session: SessionSummary;
}

interface AuthScreenProps {
  readonly apiBase: URL;
  readonly onAuthenticated: (result: AuthResult) => Promise<void>;
}

function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function AuthScreen({ apiBase, onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [timeZone, setTimeZone] = useState(deviceTimeZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [message, setMessage] = useState("Sign in to open your private diary.");

  async function submit() {
    if (mode === "register" && !isSupportedTimeZone(timeZone.trim())) {
      setError(true);
      setMessage("Enter a valid IANA time zone, such as America/Chicago.");
      return;
    }
    if (password.length < 12) {
      setError(true);
      setMessage("Password must contain at least 12 characters.");
      return;
    }
    setBusy(true);
    setError(false);
    setMessage(mode === "login" ? "Signing in…" : "Creating your account…");
    try {
      const response = await fetch(apiUrl(apiBase, `/v1/auth/${mode}`).toString(), {
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
      });
      const body = await jsonBody(response);
      if (!response.ok) throw new Error(responseError(body, "The account request failed."));
      await onAuthenticated(parseAuthResponse(body));
    } catch (caught) {
      setError(true);
      setMessage(
        caught instanceof Error
          ? caught.message
          : "The account service is unavailable. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  function selectMode(next: Mode) {
    if (busy) return;
    setMode(next);
    setError(false);
    setMessage(
      next === "login"
        ? "Sign in to open your private diary."
        : "Your time zone determines which local day receives each entry.",
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScrollView
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.kicker}>PRIVATE NUTRITION LEDGER</Text>
          <Text accessibilityRole="header" style={styles.title}>
            {mode === "login" ? "Welcome back." : "Start your diary."}
          </Text>
          <View accessibilityRole="tablist" style={styles.tabs}>
            {(["login", "register"] as const).map((option) => (
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === option }}
                key={option}
                onPress={() => selectMode(option)}
                style={[styles.tab, mode === option && styles.tabActive]}
              >
                <Text style={[styles.tabText, mode === option && styles.tabTextActive]}>
                  {option === "login" ? "Sign in" : "Create account"}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>Email</Text>
          <TextInput
            accessibilityLabel="Email"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            maxLength={254}
            onChangeText={setEmail}
            style={styles.input}
            value={email}
          />
          <Text style={styles.label}>Password</Text>
          <TextInput
            accessibilityLabel="Password"
            autoCapitalize="none"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            maxLength={128}
            onChangeText={setPassword}
            secureTextEntry
            style={styles.input}
            value={password}
          />
          {mode === "register" ? (
            <>
              <Text style={styles.label}>Display name (optional)</Text>
              <TextInput
                accessibilityLabel="Display name optional"
                autoComplete="name"
                maxLength={100}
                onChangeText={setDisplayName}
                style={styles.input}
                value={displayName}
              />
              <Text style={styles.label}>Diary time zone</Text>
              <TextInput
                accessibilityHint="Use an IANA name such as America slash Chicago"
                accessibilityLabel="Diary time zone"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={63}
                onChangeText={setTimeZone}
                style={styles.input}
                value={timeZone}
              />
            </>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => void submit()}
            style={({ pressed }) => [styles.submit, pressed && styles.pressed]}
          >
            {busy ? <ActivityIndicator color={palette.white} /> : null}
            <Text style={styles.submitText}>
              {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
            </Text>
          </Pressable>
          <Text accessibilityLiveRegion="polite" style={[styles.status, error && styles.error]}>
            {message}
          </Text>
          <Text style={styles.privacy}>
            Your bearer session is kept in secure device credential storage and is never written to
            logs.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 28, paddingBottom: 64 },
  error: { color: "#8a3128" },
  flex: { flex: 1 },
  input: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 10,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 16,
    minHeight: 50,
    paddingHorizontal: 14,
  },
  kicker: { color: palette.forest, fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  label: {
    color: palette.muted,
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 7,
    marginTop: 20,
    textTransform: "uppercase",
  },
  pressed: { opacity: 0.78 },
  privacy: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 28 },
  screen: { backgroundColor: palette.paper, flex: 1 },
  status: { color: palette.muted, fontSize: 14, lineHeight: 20, marginTop: 18 },
  submit: {
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
  submitText: { color: palette.white, fontSize: 15, fontWeight: "800" },
  tab: {
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  tabActive: { backgroundColor: palette.forest, borderColor: palette.forest },
  tabs: { flexDirection: "row", gap: 8, marginTop: 28 },
  tabText: { color: palette.muted, fontSize: 13, fontWeight: "700" },
  tabTextActive: { color: palette.white },
  title: {
    color: palette.ink,
    fontSize: 44,
    fontWeight: "700",
    letterSpacing: -1.8,
    lineHeight: 47,
    marginTop: 12,
  },
});
