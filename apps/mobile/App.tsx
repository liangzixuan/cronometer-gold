import { NavigationContainer, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { foundationItems } from "./src/foundation";
import { FoodSearchScreen } from "./src/search/FoodSearchScreen";
import { palette } from "./src/theme";

type RootStackParamList = {
  Today: undefined;
  Search: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function TodayScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return (
    <SafeAreaView edges={["left", "right", "bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.kicker}>
          SAMPLE DAY · NO ENTRIES
        </Text>
        <Text accessibilityRole="header" style={styles.title}>
          Your diary, with the uncertainty left visible.
        </Text>
        <Text style={styles.intro}>
          This client does not invent calories. Public food search now exposes promoted catalogue
          records while diary totals remain intentionally gated.
        </Text>

        <Pressable
          accessibilityHint="Opens public food search"
          accessibilityRole="button"
          onPress={() => navigation.navigate("Search")}
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
        >
          <Text style={styles.actionLabel}>Search foods</Text>
        </Pressable>

        <View style={styles.rule} />
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          Foundation ledger
        </Text>
        {foundationItems.map((item) => (
          <View key={item.title} style={styles.card}>
            <Text style={[styles.state, styles[`state_${item.state}`]]}>{item.state}</Text>
            <Text style={styles.cardTitle}>{item.title}</Text>
            <Text style={styles.cardBody}>{item.description}</Text>
          </View>
        ))}

        <Text style={styles.disclaimer}>Wellness information only—not medical advice.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
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
            component={TodayScreen}
            name="Today"
            options={{ title: "nutrition/ledger" }}
          />
          <Stack.Screen
            component={FoodSearchScreen}
            name="Search"
            options={{ title: "Food search" }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  action: {
    alignSelf: "flex-start",
    backgroundColor: palette.forest,
    borderRadius: 999,
    marginTop: 28,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  actionLabel: { color: palette.white, fontSize: 14, fontWeight: "700" },
  actionPressed: { opacity: 0.78 },
  card: { borderTopColor: palette.line, borderTopWidth: 1, paddingVertical: 22 },
  cardBody: { color: palette.muted, fontSize: 15, lineHeight: 22, marginTop: 6 },
  cardTitle: { color: palette.ink, fontSize: 21, fontWeight: "700", letterSpacing: -0.5 },
  content: { padding: 24, paddingBottom: 56 },
  disclaimer: { color: palette.muted, fontSize: 12, marginTop: 36 },
  intro: { color: palette.muted, fontSize: 17, lineHeight: 25, marginTop: 20 },
  kicker: { color: palette.forest, fontSize: 11, fontWeight: "800", letterSpacing: 1.6 },
  notice: { backgroundColor: palette.forest, borderRadius: 18, marginTop: 34, padding: 24 },
  noticeBody: { color: "#c8d8d0", fontSize: 15, lineHeight: 22, marginTop: 8 },
  noticeTitle: { color: palette.lime, fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  rule: { backgroundColor: palette.line, height: 1, marginVertical: 42 },
  screen: { backgroundColor: palette.paper, flex: 1 },
  sectionTitle: { color: palette.ink, fontSize: 28, fontWeight: "700", letterSpacing: -1 },
  state: {
    alignSelf: "flex-start",
    borderRadius: 999,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
    marginBottom: 10,
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 5,
    textTransform: "uppercase",
  },
  state_building: { backgroundColor: "#f7e6b0", color: "#6b4c00" },
  state_gated: { backgroundColor: "#f4d9d3", color: "#78413b" },
  state_ready: { backgroundColor: "#dcefd8", color: "#245a3a" },
  title: {
    color: palette.ink,
    fontSize: 42,
    fontWeight: "700",
    letterSpacing: -1.8,
    lineHeight: 45,
    marginTop: 12,
  },
});
