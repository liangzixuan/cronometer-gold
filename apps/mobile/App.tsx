import { NavigationContainer, useNavigation, useRoute } from "@react-navigation/native";
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from "@react-navigation/native-stack";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { apiUrl, authenticatedHeaders, jsonBody } from "./src/api/private-api";
import { type AuthResult, AuthScreen } from "./src/auth/AuthScreen";
import { sessionBootstrapDecision } from "./src/auth/bootstrap";
import { newOperationId } from "./src/auth/operation-id";
import {
  clearSecureSession,
  loadSecureSession,
  saveSecureSession,
} from "./src/auth/secure-session";
import { DiaryScreen } from "./src/diary/DiaryScreen";
import { type MealSlot, parseSession, type SessionSummary } from "./src/diary/diary";
import { authenticatedRoutes } from "./src/navigation/routes";
import { GoalsScreen } from "./src/recipes/GoalsScreen";
import { RecipesScreen } from "./src/recipes/RecipesScreen";
import {
  beginPrivateDeviceCleanup,
  createSecurePrivateCleanupStore,
  type PrivateCleanupDependencies,
  type PrivateCleanupReason,
  resumePrivateDeviceCleanup,
} from "./src/retention/device-cleanup";
import { createHardwareDeviceSigner } from "./src/retention/device-signing";
import {
  clearRegisteredHealthDevice,
  loadRegisteredHealthDevice,
} from "./src/retention/device-state";
import { ErasureStatusScreen } from "./src/retention/ErasureStatusScreen";
import { submitPendingErasure } from "./src/retention/erasure-recovery";
import {
  createErasureCapabilityStore,
  type ErasureStatusCapability,
} from "./src/retention/erasure-status";
import { clearHealthCursor } from "./src/retention/health-cursor-store";
import { createExpoNotificationAdapter } from "./src/retention/notifications";
import {
  createPendingErasureStore,
  type PendingErasureEnvelope,
} from "./src/retention/pending-erasure";
import { RetentionScreen } from "./src/retention/RetentionScreen";
import {
  createForegroundReminderReconciler,
  ReminderReconciliationUnauthorizedError,
} from "./src/retention/reminder-foreground";
import {
  clearAllLocalReminderSchedules,
  createSecureReminderScheduleStore,
} from "./src/retention/reminder-schedule";
import { parseIntegrations, parseReminders } from "./src/retention/retention";
import { FoodSearchScreen } from "./src/search/FoodSearchScreen";
import { resolveMobileApiBase } from "./src/search/food-search";
import { palette } from "./src/theme";

declare const process: { readonly env: { readonly EXPO_PUBLIC_API_URL?: string } };

type RootStackParamList = {
  Today: { readonly date?: string; readonly refreshKey?: string } | undefined;
  Search: { readonly date: string; readonly meal: MealSlot; readonly timeZone: string };
  Recipes: undefined;
  Goals: undefined;
  Health: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

interface AuthenticatedAppProps {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly session: SessionSummary;
  readonly onUnauthorized: () => Promise<void>;
  readonly onSignOut: () => Promise<void>;
}

function TodayRoute(props: AuthenticatedAppProps) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<NativeStackScreenProps<RootStackParamList, "Today">["route"]>();
  return (
    <DiaryScreen
      accessToken={props.accessToken}
      apiBase={props.apiBase}
      onSearch={(date, meal, timeZone) =>
        navigation.navigate(authenticatedRoutes.search, { date, meal, timeZone })
      }
      onRecipes={() => navigation.navigate(authenticatedRoutes.recipes)}
      onGoals={() => navigation.navigate(authenticatedRoutes.goals)}
      onHealth={() => navigation.navigate(authenticatedRoutes.health)}
      onUnauthorized={props.onUnauthorized}
      profileTimeZone={props.session.profile.timeZone}
      {...(route.params?.refreshKey ? { refreshKey: route.params.refreshKey } : {})}
      {...(route.params?.date ? { requestedDate: route.params.date } : {})}
    />
  );
}

function HealthRoute(
  props: AuthenticatedAppProps & {
    readonly onErasureAccepted: (input: {
      readonly job: { readonly id: string };
      readonly token: string;
      readonly expiresAt: string;
    }) => Promise<void>;
  },
) {
  return (
    <RetentionScreen
      accessToken={props.accessToken}
      apiBase={props.apiBase}
      onErasureAccepted={props.onErasureAccepted}
      onUnauthorized={props.onUnauthorized}
      profileTimeZone={props.session.profile.timeZone}
    />
  );
}

function RecipesRoute(props: AuthenticatedAppProps) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <RecipesScreen
      accessToken={props.accessToken}
      apiBase={props.apiBase}
      onGoals={() => navigation.navigate(authenticatedRoutes.goals)}
      onLogged={(date) =>
        navigation.navigate(authenticatedRoutes.today, {
          date,
          refreshKey: String(Date.now()),
        })
      }
      onUnauthorized={props.onUnauthorized}
      profileTimeZone={props.session.profile.timeZone}
    />
  );
}

function GoalsRoute(props: AuthenticatedAppProps) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <GoalsScreen
      accessToken={props.accessToken}
      apiBase={props.apiBase}
      onDiary={(date) =>
        navigation.navigate(authenticatedRoutes.today, {
          date,
          refreshKey: String(Date.now()),
        })
      }
      onRecipes={() => navigation.navigate(authenticatedRoutes.recipes)}
      onUnauthorized={props.onUnauthorized}
      profileTimeZone={props.session.profile.timeZone}
    />
  );
}

function SearchRoute(props: AuthenticatedAppProps) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<NativeStackScreenProps<RootStackParamList, "Search">["route"]>();
  return (
    <FoodSearchScreen
      accessToken={props.accessToken}
      apiBase={props.apiBase}
      diaryDate={route.params.date}
      mealSlot={route.params.meal}
      onAdded={(date) =>
        navigation.navigate(authenticatedRoutes.today, {
          date,
          refreshKey: String(Date.now()),
        })
      }
      onUnauthorized={props.onUnauthorized}
      profileTimeZone={route.params.timeZone}
    />
  );
}

function AuthenticatedApp(
  props: AuthenticatedAppProps & {
    readonly onErasureAccepted: (input: {
      readonly job: { readonly id: string };
      readonly token: string;
      readonly expiresAt: string;
    }) => Promise<void>;
  },
) {
  useEffect(() => {
    const reconciler = createForegroundReminderReconciler({
      async loadReminders(signal) {
        const response = await fetch(apiUrl(props.apiBase, "/v1/reminders").toString(), {
          headers: authenticatedHeaders(props.accessToken),
          signal,
        });
        if (response.status === 401) throw new ReminderReconciliationUnauthorizedError();
        if (!response.ok) throw new Error("The reminder schedule could not be refreshed.");
        return parseReminders(await jsonBody(response));
      },
      adapter: createExpoNotificationAdapter(),
      store: createSecureReminderScheduleStore(),
      onUnauthorized: props.onUnauthorized,
    });
    void reconciler.request();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void reconciler.request();
    });
    return () => {
      subscription.remove();
      reconciler.dispose();
    };
  }, [props.accessToken, props.apiBase, props.onUnauthorized]);

  return (
    <NavigationContainer>
      <StatusBar style="dark" />
      <Stack.Navigator
        screenOptions={{
          contentStyle: { backgroundColor: palette.paper },
          headerShadowVisible: false,
          headerStyle: { backgroundColor: palette.paper },
          headerTintColor: palette.ink,
        }}
      >
        <Stack.Screen
          name={authenticatedRoutes.today}
          options={{
            title: "nutrition/ledger",
            headerRight: () => (
              <View style={styles.headerActions}>
                <Pressable accessibilityRole="button" onPress={() => void props.onSignOut()}>
                  <Text style={styles.signOut}>Sign out</Text>
                </Pressable>
              </View>
            ),
          }}
        >
          {() => <TodayRoute {...props} />}
        </Stack.Screen>
        <Stack.Screen name={authenticatedRoutes.search} options={{ title: "Add a food" }}>
          {() => <SearchRoute {...props} />}
        </Stack.Screen>
        <Stack.Screen name={authenticatedRoutes.recipes} options={{ title: "Recipes" }}>
          {() => <RecipesRoute {...props} />}
        </Stack.Screen>
        <Stack.Screen name={authenticatedRoutes.goals} options={{ title: "Goals" }}>
          {() => <GoalsRoute {...props} />}
        </Stack.Screen>
        <Stack.Screen name={authenticatedRoutes.health} options={{ title: "Health & privacy" }}>
          {() => <HealthRoute {...props} />}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  const apiBase = useMemo(() => {
    try {
      const platform =
        Platform.OS === "android" ? "android" : Platform.OS === "web" ? "web" : "ios";
      return resolveMobileApiBase(process.env.EXPO_PUBLIC_API_URL, platform);
    } catch {
      return null;
    }
  }, []);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState(false);
  const [cleanupError, setCleanupError] = useState(false);
  const [cleanupRetryReason, setCleanupRetryReason] = useState<PrivateCleanupReason>("sign_out");
  const [remoteCleanupWarning, setRemoteCleanupWarning] = useState(false);
  const [erasureCapability, setErasureCapability] = useState<ErasureStatusCapability | null>(null);
  const [erasureRecoveryPending, setErasureRecoveryPending] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);

  const buildCleanupDependencies = useCallback(
    (token: string | null, reason: PrivateCleanupReason): PrivateCleanupDependencies => ({
      closePrivateUi() {
        setAccessToken(null);
        setSession(null);
      },
      async cleanupServerState() {
        if (!apiBase || !token) return;
        let incomplete = false;
        let integrations: ReturnType<typeof parseIntegrations> = [];
        try {
          const response = await fetch(apiUrl(apiBase, "/v1/integrations/health").toString(), {
            headers: authenticatedHeaders(token),
          });
          if (response.ok) integrations = parseIntegrations(await jsonBody(response));
          else if (response.status !== 401) incomplete = true;
        } catch {
          incomplete = true;
        }
        for (const integration of integrations.filter((item) => item.status === "connected")) {
          try {
            const response = await fetch(
              apiUrl(
                apiBase,
                `/v1/integrations/health/${integration.platform}/disconnect`,
              ).toString(),
              {
                method: "POST",
                headers: authenticatedHeaders(token, {
                  "content-type": "application/json",
                  "idempotency-key": newOperationId(),
                  "if-match": `"${integration.revision}"`,
                }),
                body: JSON.stringify({
                  importedDataDisposition: reason === "account_erasure" ? "delete" : "retain",
                }),
              },
            );
            if (!response.ok && response.status !== 401) incomplete = true;
          } catch {
            incomplete = true;
          }
        }
        try {
          const device = await loadRegisteredHealthDevice();
          if (device) {
            const response = await fetch(apiUrl(apiBase, `/v1/devices/${device.id}`).toString(), {
              method: "DELETE",
              headers: authenticatedHeaders(token, {
                "idempotency-key": newOperationId(),
                "if-match": `"${device.revision}"`,
              }),
            });
            if (!response.ok && response.status !== 401) incomplete = true;
          }
        } catch {
          incomplete = true;
        }
        try {
          const response = await fetch(apiUrl(apiBase, "/v1/auth/logout").toString(), {
            method: "POST",
            headers: authenticatedHeaders(token),
          });
          if (!response.ok && response.status !== 401) incomplete = true;
        } catch {
          incomplete = true;
        }
        if (incomplete) throw new Error("Remote device cleanup was incomplete.");
      },
      clearLocalReminders: () =>
        clearAllLocalReminderSchedules(
          createExpoNotificationAdapter(),
          createSecureReminderScheduleStore(),
        ),
      async clearHealthCursors() {
        const results = await Promise.allSettled([
          clearHealthCursor("apple_healthkit"),
          clearHealthCursor("android_health_connect"),
        ]);
        if (results.some((result) => result.status === "rejected")) {
          throw new Error("Protected health cursors could not all be removed.");
        }
      },
      clearDeviceState: clearRegisteredHealthDevice,
      deleteSigningKey: () => createHardwareDeviceSigner().resetHardwareKey(),
      clearSessionCredential: clearSecureSession,
      now: () => new Date(),
    }),
    [apiBase],
  );

  const performCleanup = useCallback(
    async (reason: PrivateCleanupReason, token = accessToken) => {
      setCleanupRetryReason(reason);
      const result = await beginPrivateDeviceCleanup(
        reason,
        buildCleanupDependencies(token, reason),
        createSecurePrivateCleanupStore(),
      );
      setCleanupError(!result.complete);
      setRemoteCleanupWarning(result.remoteCleanupIncomplete);
      if (result.complete) setBootError(false);
      return result;
    },
    [accessToken, buildCleanupDependencies],
  );

  const retryCleanup = useCallback(async () => {
    const dependencies = buildCleanupDependencies(null, cleanupRetryReason);
    const store = createSecurePrivateCleanupStore();
    const resumed = await resumePrivateDeviceCleanup(dependencies, store);
    const result =
      resumed ?? (await beginPrivateDeviceCleanup(cleanupRetryReason, dependencies, store));
    setCleanupError(!result.complete);
    if (result.complete) setBootError(false);
  }, [buildCleanupDependencies, cleanupRetryReason]);

  useEffect(() => {
    void bootAttempt;
    if (!apiBase) {
      setBooting(false);
      return;
    }
    let cancelled = false;
    setBooting(true);
    setBootError(false);
    void (async () => {
      let recoveringErasure = false;
      try {
        const cleanupStore = createSecurePrivateCleanupStore();
        const resumed = await resumePrivateDeviceCleanup(
          buildCleanupDependencies(null, "sign_out"),
          cleanupStore,
        );
        if (resumed && !resumed.complete) {
          if (!cancelled) setCleanupError(true);
          return;
        }
        const capability = await createErasureCapabilityStore().load();
        if (capability) {
          await createPendingErasureStore().clear();
          if (!cancelled) setErasureCapability(capability);
          return;
        }
        let pendingErasure: PendingErasureEnvelope | null;
        try {
          pendingErasure = await createPendingErasureStore().load();
        } catch (error) {
          recoveringErasure = true;
          throw error;
        }
        recoveringErasure = pendingErasure !== null;
        const stored = await loadSecureSession();
        if (pendingErasure) {
          if (!stored) {
            throw new Error(
              "The protected erasure replay exists but its session proof is missing.",
            );
          }
          const recovered = await submitPendingErasure({
            apiBase,
            accessToken: stored.accessToken,
            pending: pendingErasure,
          });
          if (!recovered.statusCapability) {
            throw new Error("The erasure replay omitted its status capability.");
          }
          const recoveredCapability: ErasureStatusCapability = {
            version: 1,
            jobId: recovered.job.id,
            token: recovered.statusCapability.token,
            expiresAt: recovered.statusCapability.expiresAt,
          };
          await createErasureCapabilityStore().save(recoveredCapability);
          await createPendingErasureStore().clear();
          const result = await beginPrivateDeviceCleanup(
            "account_erasure",
            buildCleanupDependencies(stored.accessToken, "account_erasure"),
            cleanupStore,
          );
          if (!cancelled) {
            setErasureCapability(recoveredCapability);
            setCleanupError(!result.complete);
            setRemoteCleanupWarning(result.remoteCleanupIncomplete);
            setErasureRecoveryPending(false);
          }
          return;
        }
        if (!stored || cancelled) return;
        const response = await fetch(apiUrl(apiBase, "/v1/auth/me").toString(), {
          headers: authenticatedHeaders(stored.accessToken),
        });
        const decision = sessionBootstrapDecision(response.status);
        if (decision === "clear") {
          const result = await beginPrivateDeviceCleanup(
            "terminal_unauthorized",
            buildCleanupDependencies(stored.accessToken, "terminal_unauthorized"),
            cleanupStore,
          );
          if (!cancelled) setCleanupError(!result.complete);
          return;
        }
        if (decision === "retry") throw new Error("session-verification-unavailable");
        const account = parseSession(await jsonBody(response));
        if (!cancelled) {
          setAccessToken(stored.accessToken);
          setSession(account);
        }
      } catch {
        if (!cancelled) {
          setErasureRecoveryPending(recoveringErasure);
          setBootError(true);
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, bootAttempt, buildCleanupDependencies]);

  async function authenticated(result: AuthResult) {
    await saveSecureSession({ accessToken: result.accessToken, expiresAt: result.expiresAt });
    setCleanupError(false);
    setRemoteCleanupWarning(false);
    setAccessToken(result.accessToken);
    setSession(result.session);
  }

  async function signOut() {
    await performCleanup("sign_out");
  }

  async function acceptErasure(input: {
    readonly job: { readonly id: string };
    readonly token: string;
    readonly expiresAt: string;
  }) {
    const capability: ErasureStatusCapability = {
      version: 1,
      jobId: input.job.id,
      token: input.token,
      expiresAt: input.expiresAt,
    };
    // Persist status authority before any session, reminder, cursor, device, or key deletion.
    await createErasureCapabilityStore().save(capability);
    setErasureCapability(capability);
    await performCleanup("account_erasure");
  }

  async function clearErasureCapability() {
    await createErasureCapabilityStore().clear();
    setErasureCapability(null);
  }

  return (
    <SafeAreaProvider>
      {booting ? (
        <SafeAreaView style={styles.center}>
          <ActivityIndicator color={palette.forest} size="large" />
          <Text style={styles.status}>Opening secure session…</Text>
        </SafeAreaView>
      ) : cleanupError ? (
        <SafeAreaView style={styles.center}>
          <Text accessibilityRole="header" style={styles.errorTitle}>
            Private-device cleanup needs attention
          </Text>
          <Text style={styles.status}>
            Private screens are closed, but one or more local reminders, health cursors, device
            records, signing keys, or credentials could not be removed. Retry before handing this
            device to someone else.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void retryCleanup()}
            style={styles.clearButton}
          >
            <Text style={styles.clearText}>Retry all private cleanup</Text>
          </Pressable>
        </SafeAreaView>
      ) : apiBase && erasureCapability ? (
        <ErasureStatusScreen
          apiBase={apiBase}
          capability={erasureCapability}
          onExpired={clearErasureCapability}
          onTerminal={async () => clearErasureCapability()}
        />
      ) : remoteCleanupWarning ? (
        <SafeAreaView style={styles.center}>
          <Text accessibilityRole="header" style={styles.errorTitle}>
            Local cleanup completed
          </Text>
          <Text style={styles.status}>
            This device removed its private data and non-exportable signing key, but the server did
            not confirm every best-effort disconnect. Sign in later to review connected devices.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setRemoteCleanupWarning(false)}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Continue</Text>
          </Pressable>
        </SafeAreaView>
      ) : bootError ? (
        <SafeAreaView style={styles.center}>
          <Text accessibilityRole="header" style={styles.errorTitle}>
            {erasureRecoveryPending
              ? "Protected erasure replay needs attention"
              : "Session check unavailable"}
          </Text>
          <Text style={styles.status}>
            {erasureRecoveryPending
              ? "The exact erasure request and session proof were preserved. Reconnect and retry; do not clear this device until the one-purpose status capability is recovered."
              : "Your saved credential was preserved. Reconnect and try again, or sign out on this device."}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setBootAttempt((value) => value + 1)}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
          {!erasureRecoveryPending ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void performCleanup("sign_out")}
              style={styles.clearButton}
            >
              <Text style={styles.clearText}>Sign out on this device</Text>
            </Pressable>
          ) : null}
        </SafeAreaView>
      ) : !apiBase ? (
        <SafeAreaView style={styles.center}>
          <Text accessibilityRole="header" style={styles.errorTitle}>
            Secure API configuration required
          </Text>
          <Text style={styles.status}>
            Set a safe HTTPS API origin before using the mobile app.
          </Text>
        </SafeAreaView>
      ) : accessToken && session ? (
        <AuthenticatedApp
          accessToken={accessToken}
          apiBase={apiBase}
          onErasureAccepted={acceptErasure}
          onSignOut={signOut}
          onUnauthorized={async () => {
            await performCleanup("terminal_unauthorized");
          }}
          session={session}
        />
      ) : (
        <AuthScreen apiBase={apiBase} onAuthenticated={authenticated} />
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    backgroundColor: palette.paper,
    flex: 1,
    justifyContent: "center",
    padding: 28,
  },
  errorTitle: { color: palette.ink, fontSize: 28, fontWeight: "700", textAlign: "center" },
  clearButton: { marginTop: 16, padding: 10 },
  clearText: { color: "#8a3128", fontSize: 14, fontWeight: "700" },
  retryButton: {
    backgroundColor: palette.forest,
    borderRadius: 999,
    marginTop: 24,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  retryText: { color: palette.white, fontSize: 14, fontWeight: "800" },
  headerActions: { alignItems: "center", flexDirection: "row", gap: 12 },
  signOut: { color: palette.forest, fontSize: 13, fontWeight: "800" },
  status: {
    color: palette.muted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 16,
    textAlign: "center",
  },
});
