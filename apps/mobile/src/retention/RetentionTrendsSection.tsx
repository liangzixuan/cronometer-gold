import type { BiometricDefinition } from "@nutrition-tracker/contracts";
import { Text, View } from "react-native";

import type { TargetableNutrient } from "../recipes/recipes-goals";
import type { parseBiometricTrend, parseNutrientTrend } from "./retention";
import { Button, ChipRow, LabeledInput, Section, styles } from "./retention-ui";

interface Props {
  readonly from: string;
  readonly to: string;
  readonly profileTimeZone: string;
  readonly trendReady: boolean;
  readonly trendFilter: string;
  readonly nutrientListStatus: string;
  readonly nutrientCount: number;
  readonly filteredTrendNutrients: readonly TargetableNutrient[];
  readonly chosenTrendNutrient: TargetableNutrient | undefined;
  readonly selectedNutrient: string;
  readonly definitions: readonly BiometricDefinition[];
  readonly selectedDefinition: string;
  readonly loadDisabled: boolean;
  readonly trendPending: boolean;
  readonly nutrientTrend: ReturnType<typeof parseNutrientTrend> | null;
  readonly biometricTrend: ReturnType<typeof parseBiometricTrend> | null;
  readonly nutrientTrendLabel: (
    aggregate: ReturnType<typeof parseNutrientTrend>["points"][number]["aggregate"],
  ) => string;
  readonly changeTrendInput: (
    field: "from" | "to" | "nutrientId" | "definitionId",
    value: string,
  ) => void;
  readonly changeTrendFilter: (value: string) => void;
  readonly applyTrendDatePreset: (days: 7 | 30 | 90) => void;
  readonly loadTrends: () => Promise<void>;
}

export function RetentionTrendsSection({
  from,
  to,
  profileTimeZone,
  trendReady,
  trendFilter,
  nutrientListStatus,
  nutrientCount,
  filteredTrendNutrients,
  chosenTrendNutrient,
  selectedNutrient,
  definitions,
  selectedDefinition,
  loadDisabled,
  trendPending,
  nutrientTrend,
  biometricTrend,
  nutrientTrendLabel,
  changeTrendInput,
  changeTrendFilter,
  applyTrendDatePreset,
  loadTrends,
}: Props) {
  return (
    <Section
      title="Trends"
      subtitle="Exact totals are labeled exact. Incomplete nutrition is shown as a lower bound, never as zero."
    >
      <LabeledInput
        label="From (YYYY-MM-DD)"
        value={from}
        disabled={!trendReady}
        onChangeText={(value) => changeTrendInput("from", value)}
        maxLength={10}
      />
      <LabeledInput
        label="To (YYYY-MM-DD)"
        value={to}
        disabled={!trendReady}
        onChangeText={(value) => changeTrendInput("to", value)}
        maxLength={10}
      />
      <Text style={styles.help}>
        Ranges include today in {profileTimeZone}. Choose Load local-day trends to view them.
      </Text>
      <View style={styles.actions}>
        {([7, 30, 90] as const).map((days) => (
          <Button
            key={days}
            label={`Last ${days} days`}
            disabled={!trendReady}
            onPress={() => applyTrendDatePreset(days)}
            secondary
          />
        ))}
      </View>
      <Text style={styles.label}>Nutrient</Text>
      <LabeledInput
        label="Find a trend nutrient by name"
        value={trendFilter}
        disabled={!trendReady}
        onChangeText={changeTrendFilter}
        maxLength={200}
      />
      <Button
        label="Clear trend nutrient filter"
        disabled={!trendReady}
        onPress={() => changeTrendFilter("")}
        secondary
      />
      <Text style={styles.help}>{nutrientListStatus}</Text>
      {trendReady && nutrientCount > 0 && filteredTrendNutrients.length === 0 ? (
        <Text style={styles.help}>No loaded nutrients match this name.</Text>
      ) : null}
      <Text style={styles.help}>
        {chosenTrendNutrient
          ? `Selected nutrient: ${chosenTrendNutrient.name} · ${chosenTrendNutrient.unit}`
          : "No trend nutrient selected."}
      </Text>
      <ChipRow
        items={filteredTrendNutrients.map((item) => ({
          key: item.nutrientId,
          label: `${item.name} · ${item.unit}`,
        }))}
        selected={selectedNutrient}
        disabled={!trendReady}
        wrapLabels
        onSelect={(value) => changeTrendInput("nutrientId", value)}
      />
      <Text style={styles.label}>Biometric</Text>
      <ChipRow
        items={
          trendReady
            ? [
                { key: "", label: "None" },
                ...definitions.map((item) => ({
                  key: item.id,
                  label: `${item.name} (${item.canonicalUnit})${item.status === "archived" ? " (archived)" : ""}`,
                })),
              ]
            : []
        }
        selected={selectedDefinition}
        disabled={!trendReady}
        wrapLabels
        onSelect={(value) => changeTrendInput("definitionId", value)}
      />
      <Button
        disabled={loadDisabled}
        label={trendPending ? "Loading…" : "Load local-day trends"}
        onPress={() => void loadTrends()}
      />
      {nutrientTrend ? (
        <Text accessibilityRole="header" style={styles.cardTitle}>
          {`${nutrientTrend.nutrient.name} (${nutrientTrend.nutrient.unit}) · ${nutrientTrend.from} to ${nutrientTrend.to} · ${nutrientTrend.timeZone}`}
        </Text>
      ) : null}
      {nutrientTrend?.points.map((point) => (
        <Text key={point.localDate} style={styles.rowText}>
          {point.localDate}: {nutrientTrendLabel(point.aggregate)}
        </Text>
      ))}
      {biometricTrend ? (
        <Text accessibilityRole="header" style={styles.cardTitle}>
          {`${biometricTrend.definition.name} (${biometricTrend.definition.canonicalUnit}) · ${biometricTrend.from} to ${biometricTrend.to} · ${biometricTrend.timeZone}`}
        </Text>
      ) : null}
      {biometricTrend?.points.map((point) => (
        <Text key={point.localDate} style={styles.rowText}>
          {point.localDate}: {point.last} {biometricTrend?.definition.canonicalUnit} · {point.count}{" "}
          reading{point.count === 1 ? "" : "s"}
        </Text>
      ))}
    </Section>
  );
}
