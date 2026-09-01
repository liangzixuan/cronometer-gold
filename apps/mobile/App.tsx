import { NavigationContainer, useNavigation, useRoute } from "@react-navigation/native";
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from "@react-navigation/native-stack";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { EmailVerificationScreen } from "./src/auth/EmailVerificationScreen";
import {
  acceptEmailVerificationSessionUpdate,
  type EmailVerificationSessionUpdate,
} from "./src/auth/email-verification";
import { newOperationId } from "./src/auth/operation-id";
import {
  clearSecureSession,
  loadSecureSession,
  saveSecureSession,
} from "./src/auth/secure-session";
import { DiaryScreen } from "./src/diary/DiaryScreen";
import { type MealSlot, parseSession, type SessionSummary } from "./src/diary/diary";
import {
  createQuickAddOutboxController,
  type FatalQuickAddOutboxStoreReason,
  type QuickAddOutboxController,
  type QuickAddOutboxControllerState,
  type QuickAddOutboxSnapshot,
  type QuickAddReceipt,
} from "./src/diary/quick-add-outbox";
import {
  createSecureQuickAddOutboxStore,
  QuickAddOutboxCorruptError,
  QuickAddOutboxHeadConflictError,
  QuickAddOutboxOwnerMismatchError,
} from "./src/diary/quick-add-outbox-store";
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
  VerifyEmail: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

interface AuthenticatedAppProps {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly session: SessionSummary;
  readonly sessionEpoch: number;
  readonly onUnauthorized: () => Promise<void>;
  readonly onSignOut: () => Promise<void>;
  readonly onSessionUpdated: (update: EmailVerificationSessionUpdate) => void;
  readonly onErasurePrepared: () => void;
  readonly quickAddOutboxController: QuickAddOutboxController;
  readonly quickAddOutboxState: QuickAddOutboxControllerState;
  readonly subscribeQuickAddReceipts: (listener: (receipt: QuickAddReceipt) => void) => () => void;
}

interface PreparedQuickAddOutbox {
  readonly ownerUserId: string;
  readonly sessionEpoch: number;
  readonly initialState: QuickAddOutboxControllerState;
}

class QuickAddOutboxPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuickAddOutboxPreparationError";
  }
}

function quickAddOutboxState(snapshot: QuickAddOutboxSnapshot): QuickAddOutboxControllerState {
  const head = snapshot.items[0];
  if (!head) return { status: "idle", pendingCount: 0 };
  if (!head.blocked) return { status: "pending", pendingCount: snapshot.items.length };
  return {
    status: "blocked",
    pendingCount: snapshot.items.length,
    operationId: head.operationId,
    httpStatus: head.blocked.status,
    blockedReason: head.blocked.reason,
    foodName: head.display.foodName,
    servingLabel: head.display.servingLabel,
    localDate: head.localDate,
    mealSlot: head.body.mealSlot,
  };
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
      quickAddOutboxState={props.quickAddOutboxState}
      subscribeQuickAddReceipts={props.subscribeQuickAddReceipts}
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
      onErasurePrepared={props.onErasurePrepared}
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
      apiBase={props.apiBase}
      diaryDate={route.params.date}
      mealSlot={route.params.meal}
      onAdded={(date) =>
        navigation.navigate(authenticatedRoutes.today, {
          date,
          refreshKey: String(Date.now()),
        })
      }
      profileTimeZone={route.params.timeZone}
      quickAddOutboxController={props.quickAddOutboxController}
      quickAddOutboxState={props.quickAddOutboxState}
      subscribeQuickAddReceipts={props.subscribeQuickAddReceipts}
    />
  );
}

function EmailVerificationRoute(props: AuthenticatedAppProps) {
  return (
    <EmailVerificationScreen
      accessToken={props.accessToken}
      apiBase={props.apiBase}
      onSessionUpdated={props.onSessionUpdated}
      onUnauthorized={props.onUnauthorized}
      session={props.session}
      sessionEpoch={props.sessionEpoch}
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

  useEffect(() => {
    const controller = props.quickAddOutboxController;
    if (AppState.currentState === "active") void controller.resume();
    else controller.suspend();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void controller.resume();
      else controller.suspend();
    });
    return () => {
      subscription.remove();
      controller.suspend();
    };
  }, [props.quickAddOutboxController]);

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
          options={({ navigation }) => ({
            title: "nutrition/ledger",
            headerRight: () => (
              <View style={styles.headerActions}>
                {!props.session.user.emailVerified ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => navigation.navigate(authenticatedRoutes.verifyEmail)}
                  >
                    <Text style={styles.verifyEmail}>Verify email</Text>
                  </Pressable>
                ) : null}
                <Pressable accessibilityRole="button" onPress={() => void props.onSignOut()}>
                  <Text style={styles.signOut}>Sign out</Text>
                </Pressable>
              </View>
            ),
          })}
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
        <Stack.Screen name={authenticatedRoutes.verifyEmail} options={{ title: "Verify email" }}>
          {() => <EmailVerificationRoute {...props} />}
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
  const quickAddOutboxStore = useMemo(() => createSecureQuickAddOutboxStore(), []);
  const quickAddOutboxControllerRef = useRef<QuickAddOutboxController | null>(null);
  const quickAddReceiptListenersRef = useRef(new Set<(receipt: QuickAddReceipt) => void>());
  const privateSessionEpochRef = useRef(0);
  const unauthorizedCleanupFlightRef = useRef<{
    readonly sessionEpoch: number;
    readonly promise: Promise<void>;
  } | null>(null);
  const fatalOutboxCleanupFlightRef = useRef<{
    readonly sessionEpoch: number;
    readonly promise: Promise<void>;
  } | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState(false);
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupError, setCleanupError] = useState(false);
  const [cleanupRetryReason, setCleanupRetryReason] = useState<PrivateCleanupReason>("sign_out");
  const [remoteCleanupWarning, setRemoteCleanupWarning] = useState(false);
  const [outboxResetWarning, setOutboxResetWarning] = useState(false);
  const [outboxPreparationError, setOutboxPreparationError] = useState(false);
  const [erasureCapability, setErasureCapability] = useState<ErasureStatusCapability | null>(null);
  const [erasureRecoveryPending, setErasureRecoveryPending] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [preparedQuickAddOutbox, setPreparedQuickAddOutbox] =
    useState<PreparedQuickAddOutbox | null>(null);
  const [quickAddOutboxController, setQuickAddOutboxController] =
    useState<QuickAddOutboxController | null>(null);
  const [currentQuickAddOutboxState, setCurrentQuickAddOutboxState] =
    useState<QuickAddOutboxControllerState>({ status: "idle", pendingCount: 0 });

  const updateEmailVerificationSession = useCallback((update: EmailVerificationSessionUpdate) => {
    if (privateSessionEpochRef.current !== update.initiatingSessionEpoch) return;
    setSession((current) =>
      acceptEmailVerificationSessionUpdate(current, privateSessionEpochRef.current, update),
    );
  }, []);

  const closePrivateUi = useCallback(() => {
    privateSessionEpochRef.current += 1;
    const controller = quickAddOutboxControllerRef.current;
    quickAddOutboxControllerRef.current = null;
    controller?.close();
    quickAddReceiptListenersRef.current.clear();
    setQuickAddOutboxController(null);
    setPreparedQuickAddOutbox(null);
    setCurrentQuickAddOutboxState({ status: "idle", pendingCount: 0 });
    setAccessToken(null);
    setSession(null);
  }, []);

  const prepareQuickAddOutbox = useCallback(
    async (ownerUserId: string) => {
      let reset = false;
      let snapshot: QuickAddOutboxSnapshot;
      try {
        snapshot = await quickAddOutboxStore.snapshot(ownerUserId);
      } catch (error) {
        if (
          !(error instanceof QuickAddOutboxOwnerMismatchError) &&
          !(error instanceof QuickAddOutboxHeadConflictError) &&
          !(error instanceof QuickAddOutboxCorruptError)
        ) {
          throw new QuickAddOutboxPreparationError(
            "Protected queued diary adds could not be prepared on this device.",
          );
        }
        reset = true;
        try {
          await quickAddOutboxStore.clear();
          snapshot = await quickAddOutboxStore.snapshot(ownerUserId);
        } catch {
          throw new QuickAddOutboxPreparationError(
            "Protected queued diary adds could not be prepared on this device.",
          );
        }
      }
      return { initialState: quickAddOutboxState(snapshot), reset };
    },
    [quickAddOutboxStore],
  );

  const subscribeQuickAddReceipts = useCallback((listener: (receipt: QuickAddReceipt) => void) => {
    quickAddReceiptListenersRef.current.add(listener);
    return () => quickAddReceiptListenersRef.current.delete(listener);
  }, []);

  const buildCleanupDependencies = useCallback(
    (token: string | null, reason: PrivateCleanupReason): PrivateCleanupDependencies => ({
      closePrivateUi,
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
      clearQuickAddOutbox: () => quickAddOutboxStore.clear(),
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
    [apiBase, closePrivateUi, quickAddOutboxStore],
  );

  const performCleanup = useCallback(
    async (reason: PrivateCleanupReason, token = accessToken) => {
      setCleanupRetryReason(reason);
      setCleanupRunning(true);
      try {
        const result = await beginPrivateDeviceCleanup(
          reason,
          buildCleanupDependencies(token, reason),
          createSecurePrivateCleanupStore(),
        );
        setCleanupError(!result.complete);
        setRemoteCleanupWarning(result.remoteCleanupIncomplete);
        if (result.complete) setBootError(false);
        return result;
      } finally {
        setCleanupRunning(false);
      }
    },
    [accessToken, buildCleanupDependencies],
  );

  const handleTerminalUnauthorized = useCallback(
    (token: string, sessionEpoch: number): Promise<void> => {
      const existing = unauthorizedCleanupFlightRef.current;
      if (privateSessionEpochRef.current !== sessionEpoch) {
        return existing?.sessionEpoch === sessionEpoch ? existing.promise : Promise.resolve();
      }
      closePrivateUi();
      if (existing?.sessionEpoch === sessionEpoch) return existing.promise;
      const promise = performCleanup("terminal_unauthorized", token).then(() => undefined);
      unauthorizedCleanupFlightRef.current = { sessionEpoch, promise };
      return promise;
    },
    [closePrivateUi, performCleanup],
  );

  const handleUnauthorized = useCallback((): Promise<void> => {
    if (!accessToken || !preparedQuickAddOutbox) {
      closePrivateUi();
      return Promise.resolve();
    }
    return handleTerminalUnauthorized(accessToken, preparedQuickAddOutbox.sessionEpoch);
  }, [accessToken, closePrivateUi, handleTerminalUnauthorized, preparedQuickAddOutbox]);

  const handleFatalQuickAddOutbox = useCallback(
    (reason: FatalQuickAddOutboxStoreReason): Promise<void> => {
      const token = accessToken;
      const prepared = preparedQuickAddOutbox;
      const existing = fatalOutboxCleanupFlightRef.current;
      if (!token || !prepared) {
        closePrivateUi();
        return Promise.resolve();
      }
      if (privateSessionEpochRef.current !== prepared.sessionEpoch) {
        return existing?.sessionEpoch === prepared.sessionEpoch
          ? existing.promise
          : Promise.resolve();
      }
      setOutboxResetWarning(reason === "owner_mismatch" || reason === "corrupt");
      closePrivateUi();
      if (existing?.sessionEpoch === prepared.sessionEpoch) return existing.promise;
      const promise = performCleanup("sign_out", token).then(() => undefined);
      fatalOutboxCleanupFlightRef.current = {
        sessionEpoch: prepared.sessionEpoch,
        promise,
      };
      return promise;
    },
    [accessToken, closePrivateUi, performCleanup, preparedQuickAddOutbox],
  );

  const fenceQuickAddOutboxForErasure = useCallback(() => {
    quickAddOutboxControllerRef.current?.close();
  }, []);

  const retryCleanup = useCallback(async () => {
    setCleanupRunning(true);
    try {
      const dependencies = buildCleanupDependencies(null, cleanupRetryReason);
      const store = createSecurePrivateCleanupStore();
      const resumed = await resumePrivateDeviceCleanup(dependencies, store);
      const result =
        resumed ?? (await beginPrivateDeviceCleanup(cleanupRetryReason, dependencies, store));
      let complete = result.complete;
      if (complete && erasureCapability) {
        try {
          await createPendingErasureStore().clear();
        } catch {
          complete = false;
        }
      }
      setCleanupError(!complete);
      if (complete) {
        setBootError(false);
        setBootAttempt((value) => value + 1);
      }
    } finally {
      setCleanupRunning(false);
    }
  }, [buildCleanupDependencies, cleanupRetryReason, erasureCapability]);

  useEffect(() => {
    if (
      !apiBase ||
      !accessToken ||
      !session ||
      !preparedQuickAddOutbox ||
      preparedQuickAddOutbox.ownerUserId !== session.user.id
    ) {
      return;
    }
    const controller = createQuickAddOutboxController({
      apiBase,
      ownerUserId: session.user.id,
      expectedTimeZone: session.profile.timeZone,
      store: quickAddOutboxStore,
      fetcher: (input, init) => fetch(input, init),
      accessToken: () => accessToken,
      isForeground: () => AppState.currentState === "active",
      operationId: newOperationId,
      onUnauthorized: handleUnauthorized,
      onFatalStoreError: handleFatalQuickAddOutbox,
      onReceipt(receipt) {
        for (const listener of [...quickAddReceiptListenersRef.current]) {
          try {
            listener(receipt);
          } catch {
            // A screen observer cannot interrupt an already accepted durable receipt.
          }
        }
      },
    });
    controller.suspend();
    quickAddOutboxControllerRef.current = controller;
    setCurrentQuickAddOutboxState(preparedQuickAddOutbox.initialState);
    const unsubscribe = controller.subscribe(setCurrentQuickAddOutboxState);
    setQuickAddOutboxController(controller);
    return () => {
      unsubscribe();
      if (quickAddOutboxControllerRef.current === controller) {
        quickAddOutboxControllerRef.current = null;
      }
      controller.close();
    };
  }, [
    accessToken,
    apiBase,
    handleFatalQuickAddOutbox,
    handleUnauthorized,
    preparedQuickAddOutbox,
    quickAddOutboxStore,
    session,
  ]);

  useEffect(() => {
    void bootAttempt;
    let cancelled = false;
    setBooting(true);
    setBootError(false);
    setOutboxPreparationError(false);
    void (async () => {
      let recoveringErasure = false;
      try {
        const cleanupStore = createSecurePrivateCleanupStore();
        const resumed = await resumePrivateDeviceCleanup(
          buildCleanupDependencies(null, "sign_out"),
          cleanupStore,
        );
        let pendingErasure: PendingErasureEnvelope | null;
        try {
          pendingErasure = await createPendingErasureStore().load();
        } catch (error) {
          recoveringErasure = true;
          throw error;
        }
        recoveringErasure = pendingErasure !== null;
        let capability: ErasureStatusCapability | null;
        try {
          capability = await createErasureCapabilityStore().load();
        } catch (error) {
          recoveringErasure = true;
          throw error;
        }
        if (capability) recoveringErasure = true;
        if (resumed && !resumed.complete) {
          if (!cancelled) {
            if (capability) {
              setCleanupRetryReason("account_erasure");
              setErasureCapability(capability);
            }
            setCleanupError(true);
            setRemoteCleanupWarning(resumed.remoteCleanupIncomplete);
          }
          return;
        }
        const stored = await loadSecureSession();
        if (!stored) {
          try {
            await quickAddOutboxStore.clear();
          } catch {
            throw new QuickAddOutboxPreparationError(
              "Protected queued diary adds could not be cleared on this device.",
            );
          }
        }
        if (capability) {
          const result =
            resumed ??
            (await beginPrivateDeviceCleanup(
              "account_erasure",
              buildCleanupDependencies(stored?.accessToken ?? null, "account_erasure"),
              cleanupStore,
            ));
          if (result.complete) await createPendingErasureStore().clear();
          if (!cancelled) {
            setCleanupRetryReason("account_erasure");
            setErasureCapability(capability);
            setCleanupError(!result.complete);
            setRemoteCleanupWarning(result.remoteCleanupIncomplete);
          }
          return;
        }
        if (pendingErasure) {
          if (!apiBase) {
            throw new Error("A safe API origin is required to replay the protected erasure.");
          }
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
          const result = await beginPrivateDeviceCleanup(
            "account_erasure",
            buildCleanupDependencies(stored.accessToken, "account_erasure"),
            cleanupStore,
          );
          if (result.complete) await createPendingErasureStore().clear();
          if (!cancelled) {
            setCleanupRetryReason("account_erasure");
            setErasureCapability(recoveredCapability);
            setCleanupError(!result.complete);
            setRemoteCleanupWarning(result.remoteCleanupIncomplete);
            setErasureRecoveryPending(false);
          }
          return;
        }
        if (!stored || cancelled || !apiBase) return;
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
        const prepared = await prepareQuickAddOutbox(account.user.id);
        if (!cancelled) {
          const sessionEpoch = privateSessionEpochRef.current + 1;
          privateSessionEpochRef.current = sessionEpoch;
          unauthorizedCleanupFlightRef.current = null;
          fatalOutboxCleanupFlightRef.current = null;
          setPreparedQuickAddOutbox({
            ownerUserId: account.user.id,
            sessionEpoch,
            initialState: prepared.initialState,
          });
          setOutboxResetWarning(prepared.reset);
          setAccessToken(stored.accessToken);
          setSession(account);
        }
      } catch (error) {
        if (!cancelled) {
          setErasureRecoveryPending(recoveringErasure);
          setOutboxPreparationError(error instanceof QuickAddOutboxPreparationError);
          setBootError(true);
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, bootAttempt, buildCleanupDependencies, prepareQuickAddOutbox, quickAddOutboxStore]);

  async function authenticated(result: AuthResult) {
    const prepared = await prepareQuickAddOutbox(result.session.user.id);
    await saveSecureSession({ accessToken: result.accessToken, expiresAt: result.expiresAt });
    const sessionEpoch = privateSessionEpochRef.current + 1;
    privateSessionEpochRef.current = sessionEpoch;
    unauthorizedCleanupFlightRef.current = null;
    fatalOutboxCleanupFlightRef.current = null;
    setCleanupError(false);
    setRemoteCleanupWarning(false);
    setPreparedQuickAddOutbox({
      ownerUserId: result.session.user.id,
      sessionEpoch,
      initialState: prepared.initialState,
    });
    setOutboxResetWarning(prepared.reset);
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
    const result = await performCleanup("account_erasure");
    if (!result.complete) {
      throw new Error(
        "The erasure request was accepted, but private device cleanup must finish before its protected replay proof is removed.",
      );
    }
  }

  async function clearErasureCapability() {
    await createErasureCapabilityStore().clear();
    setErasureCapability(null);
  }

  return (
    <SafeAreaProvider>
      {booting || cleanupRunning ? (
        <SafeAreaView style={styles.center}>
          <ActivityIndicator color={palette.forest} size="large" />
          <Text style={styles.status}>
            {cleanupRunning ? "Removing private device data…" : "Opening secure session…"}
          </Text>
        </SafeAreaView>
      ) : cleanupError ? (
        <SafeAreaView style={styles.center}>
          <Text accessibilityRole="header" style={styles.errorTitle}>
            Private-device cleanup needs attention
          </Text>
          <Text style={styles.status}>
            Private screens are closed, but one or more queued diary adds, local reminders, health
            cursors, device records, signing keys, or credentials could not be removed. Retry before
            handing this device to someone else.
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
      ) : outboxResetWarning ? (
        <SafeAreaView style={styles.center}>
          <Text accessibilityRole="header" style={styles.errorTitle}>
            Queued diary adds were reset
          </Text>
          <Text style={styles.status}>
            Protected queued adds on this device could not be safely read or attributed to this
            account and were removed before private screens opened.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setOutboxResetWarning(false)}
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
              : outboxPreparationError
                ? "Protected queue needs attention"
                : "Session check unavailable"}
          </Text>
          <Text style={styles.status}>
            {erasureRecoveryPending
              ? "The exact erasure request and session proof were preserved. Reconnect and retry; do not clear this device until the one-purpose status capability is recovered."
              : outboxPreparationError
                ? "The app could not safely read or clear protected queued diary adds, so private screens remain closed. Retry first. Signing out on this device will retry removing the queue."
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
            Set a safe HTTPS API origin before using the mobile app. Local cleanup recovery has
            still run; signing out below removes protected data held on this device.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void performCleanup("sign_out", null)}
            style={styles.clearButton}
          >
            <Text style={styles.clearText}>Sign out on this device</Text>
          </Pressable>
        </SafeAreaView>
      ) : accessToken && session && preparedQuickAddOutbox && quickAddOutboxController ? (
        <AuthenticatedApp
          accessToken={accessToken}
          apiBase={apiBase}
          onErasureAccepted={acceptErasure}
          onErasurePrepared={fenceQuickAddOutboxForErasure}
          onSessionUpdated={updateEmailVerificationSession}
          onSignOut={signOut}
          onUnauthorized={handleUnauthorized}
          quickAddOutboxController={quickAddOutboxController}
          quickAddOutboxState={currentQuickAddOutboxState}
          session={session}
          sessionEpoch={preparedQuickAddOutbox.sessionEpoch}
          subscribeQuickAddReceipts={subscribeQuickAddReceipts}
        />
      ) : accessToken && session ? (
        <SafeAreaView style={styles.center}>
          <ActivityIndicator color={palette.forest} size="large" />
          <Text style={styles.status}>Preparing protected queued diary adds…</Text>
        </SafeAreaView>
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
  verifyEmail: { color: "#8a5705", fontSize: 13, fontWeight: "800" },
  status: {
    color: palette.muted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 16,
    textAlign: "center",
  },
});
