import type { AccountErasureJob } from "@nutrition-tracker/contracts";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiUrl, jsonBody, responseError } from "../api/private-api";
import { palette } from "../theme";
import type { ErasureStatusCapability } from "./erasure-status";
import { parseErasureResponse } from "./retention";

interface Props {
  readonly apiBase: URL;
  readonly capability: ErasureStatusCapability;
  readonly onTerminal: (job: AccountErasureJob) => Promise<void>;
  readonly onExpired: () => Promise<void>;
}

export function ErasureStatusScreen({ apiBase, capability, onTerminal, onExpired }: Props) {
  const [job, setJob] = useState<AccountErasureJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("Checking permanent account-erasure status…");

  const refresh = useCallback(async () => {
    if (Date.parse(capability.expiresAt) <= Date.now()) {
      await onExpired();
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        apiUrl(apiBase, `/v1/account/erasure/${capability.jobId}`).toString(),
        {
          headers: {
            accept: "application/json",
            "x-erasure-status-token": capability.token,
          },
        },
      );
      const value = await jsonBody(response);
      if (!response.ok) {
        throw new Error(responseError(value, "Erasure status is temporarily unavailable."));
      }
      const next = parseErasureResponse(value).job;
      setJob(next);
      setMessage(
        next.status === "queued"
          ? `Erasure is queued and eligible after ${next.executeAfter}.`
          : next.status === "running"
            ? "Permanent deletion is running."
            : next.status === "completed"
              ? "Account access, private health data, and export links were permanently removed."
              : "Erasure failed. Contact support before clearing this status capability.",
      );
      if (next.status === "completed" || next.status === "failed") await onTerminal(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Erasure status is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [apiBase, capability.expiresAt, capability.jobId, capability.token, onExpired, onTerminal]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.kicker}>PRIVACY STATUS</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Account erasure
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.message}>
          {message}
        </Text>
        {job ? (
          <Text style={styles.meta}>
            Job {job.id} · {job.status}
          </Text>
        ) : null}
        {loading ? <ActivityIndicator color={palette.forest} /> : null}
        <Pressable
          accessibilityRole="button"
          disabled={loading}
          onPress={() => void refresh()}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Refresh status</Text>
        </Pressable>
        <Text style={styles.note}>
          This screen uses only a short-lived status capability stored separately from the deleted
          session. It cannot open diary or health data.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: "flex-start",
    backgroundColor: palette.forest,
    borderRadius: 999,
    marginTop: 20,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  buttonText: { color: palette.white, fontSize: 14, fontWeight: "800" },
  card: { maxWidth: 540, width: "100%" },
  kicker: { color: palette.forest, fontSize: 11, fontWeight: "800", letterSpacing: 1.4 },
  message: { color: palette.muted, fontSize: 15, lineHeight: 23, marginTop: 18 },
  meta: { color: palette.ink, fontSize: 13, marginTop: 12 },
  note: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 22 },
  screen: {
    alignItems: "center",
    backgroundColor: palette.paper,
    flex: 1,
    justifyContent: "center",
    padding: 28,
  },
  title: { color: palette.ink, fontSize: 34, fontWeight: "700", letterSpacing: -1, marginTop: 7 },
});
