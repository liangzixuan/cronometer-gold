import { NavigationContainer, useNavigation, useRoute } from "@react-navigation/native";
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from "@react-navigation/native-stack";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { apiUrl, authenticatedHeaders, jsonBody } from "./src/api/private-api";
import { type AuthResult, AuthScreen } from "./src/auth/AuthScreen";
import { clearSessionFailClosed, sessionBootstrapDecision } from "./src/auth/bootstrap";
import {
  clearSecureSession,
  loadSecureSession,
  saveSecureSession,
} from "./src/auth/secure-session";
import { DiaryScreen } from "./src/diary/DiaryScreen";
import { type MealSlot, parseSession, type SessionSummary } from "./src/diary/diary";
import { FoodSearchScreen } from "./src/search/FoodSearchScreen";
import { resolveMobileApiBase } from "./src/search/food-search";
import { palette } from "./src/theme";

declare const process: { readonly env: { readonly EXPO_PUBLIC_API_URL?: string } };

type RootStackParamList = {
  Today: { readonly date?: string; readonly refreshKey?: string } | undefined;
  Search: { readonly date: string; readonly meal: MealSlot; readonly timeZone: string };
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
      onSearch={(date, meal, timeZone) => navigation.navigate("Search", { date, meal, timeZone })}
      onUnauthorized={props.onUnauthorized}
      profileTimeZone={props.session.profile.timeZone}
      {...(route.params?.refreshKey ? { refreshKey: route.params.refreshKey } : {})}
      {...(route.params?.date ? { requestedDate: route.params.date } : {})}
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
      onAdded={(date) => navigation.navigate("Today", { date, refreshKey: String(Date.now()) })}
      onUnauthorized={props.onUnauthorized}
      profileTimeZone={route.params.timeZone}
    />
  );
}

function AuthenticatedApp(props: AuthenticatedAppProps) {
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
          name="Today"
          options={{
            title: "nutrition/ledger",
            headerRight: () => (
              <Pressable accessibilityRole="button" onPress={() => void props.onSignOut()}>
                <Text style={styles.signOut}>Sign out</Text>
              </Pressable>
            ),
          }}
        >
          {() => <TodayRoute {...props} />}
        </Stack.Screen>
        <Stack.Screen name="Search" options={{ title: "Add a food" }}>
          {() => <SearchRoute {...props} />}
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
  const [credentialClearError, setCredentialClearError] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);

  const clearLocalSession = useCallback(async () => {
    const cleared = await clearSessionFailClosed(clearSecureSession, () => {
      setAccessToken(null);
      setSession(null);
    });
    setCredentialClearError(!cleared);
    if (cleared) setBootError(false);
  }, []);

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
      try {
        const stored = await loadSecureSession();
        if (!stored || cancelled) return;
        const response = await fetch(apiUrl(apiBase, "/v1/auth/me").toString(), {
          headers: authenticatedHeaders(stored.accessToken),
        });
        const decision = sessionBootstrapDecision(response.status);
        if (decision === "clear") {
          await clearSecureSession();
          return;
        }
        if (decision === "retry") throw new Error("session-verification-unavailable");
        const account = parseSession(await jsonBody(response));
        if (!cancelled) {
          setAccessToken(stored.accessToken);
          setSession(account);
        }
      } catch {
        if (!cancelled) setBootError(true);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, bootAttempt]);

  async function authenticated(result: AuthResult) {
    await saveSecureSession({ accessToken: result.accessToken, expiresAt: result.expiresAt });
    setCredentialClearError(false);
    setAccessToken(result.accessToken);
    setSession(result.session);
  }

  async function signOut() {
    if (apiBase && accessToken) {
      try {
        await fetch(apiUrl(apiBase, "/v1/auth/logout").toString(), {
          method: "POST",
          headers: authenticatedHeaders(accessToken),
        });
      } catch {
        // The local credential is still destroyed when remote revocation is unavailable.
      }
    }
    await clearLocalSession();
  }

  return (
    <SafeAreaProvider>
      {booting ? (
        <SafeAreaView style={styles.center}>
          <ActivityIndicator color={palette.forest} size="large" />
          <Text style={styles.status}>Opening secure session…</Text>
        </SafeAreaView>
      ) : credentialClearError ? (
        <SafeAreaView style={styles.center}>
          <Text accessibilityRole="header" style={styles.errorTitle}>
            Credential removal needs attention
          </Text>
          <Text style={styles.status}>
            The private diary was closed in memory, but this device could not remove its saved
            credential. Retry before handing the device to someone else.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void clearLocalSession()}
            style={styles.clearButton}
          >
            <Text style={styles.clearText}>Retry credential removal</Text>
          </Pressable>
        </SafeAreaView>
      ) : bootError ? (
        <SafeAreaView style={styles.center}>
          <Text accessibilityRole="header" style={styles.errorTitle}>
            Session check unavailable
          </Text>
          <Text style={styles.status}>
            Your saved credential was preserved. Reconnect and try again, or sign out on this
            device.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setBootAttempt((value) => value + 1)}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void clearLocalSession()}
            style={styles.clearButton}
          >
            <Text style={styles.clearText}>Sign out on this device</Text>
          </Pressable>
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
          onSignOut={signOut}
          onUnauthorized={clearLocalSession}
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
  signOut: { color: palette.forest, fontSize: 13, fontWeight: "800" },
  status: {
    color: palette.muted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 16,
    textAlign: "center",
  },
});
