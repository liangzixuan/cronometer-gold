import type * as React from "react";
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { palette } from "../theme";

export function Section({
  title,
  subtitle,
  children,
  onLayout,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly children: React.ReactNode;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
}) {
  return (
    <View style={styles.section} onLayout={onLayout}>
      <Text accessibilityRole="header" style={styles.heading}>
        {title}
      </Text>
      <Text style={styles.intro}>{subtitle}</Text>
      {children}
    </View>
  );
}

export function LabeledInput(props: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly maxLength: number;
  readonly multiline?: boolean;
  readonly placeholder?: string;
  readonly secureTextEntry?: boolean;
  readonly autoCapitalize?: "none" | "sentences" | "words" | "characters";
  readonly keyboardType?: "default" | "decimal-pad" | "numbers-and-punctuation";
}) {
  return (
    <View>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        editable={!props.disabled}
        autoCapitalize={props.autoCapitalize ?? "none"}
        keyboardType={props.keyboardType ?? "default"}
        maxLength={props.maxLength}
        multiline={props.multiline}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        secureTextEntry={props.secureTextEntry}
        style={[styles.input, props.multiline && styles.multiline]}
        value={props.value}
      />
    </View>
  );
}

export function ChipRow(props: {
  readonly disabled?: boolean;
  readonly items: readonly {
    readonly key: string;
    readonly label: string;
    readonly disabled?: boolean;
  }[];
  readonly selected: string | readonly string[];
  readonly onSelect: (key: string) => void;
  readonly multiple?: boolean;
  readonly wrapLabels?: boolean;
}) {
  const selected = Array.isArray(props.selected) ? props.selected : [props.selected];
  return (
    <View accessibilityRole={props.multiple ? undefined : "radiogroup"} style={styles.chips}>
      {props.items.map((item) => {
        const active = selected.includes(item.key);
        const disabled = Boolean(props.disabled || item.disabled);
        return (
          <Pressable
            accessibilityRole={props.multiple ? "checkbox" : "radio"}
            accessibilityState={
              props.multiple ? { checked: active, disabled } : { selected: active, disabled }
            }
            disabled={disabled}
            key={item.key}
            onPress={() => {
              if (!disabled) props.onSelect(item.key);
            }}
            style={[
              styles.chip,
              props.wrapLabels && styles.wrappingChip,
              active && styles.chipActive,
            ]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Button({
  label,
  onPress,
  disabled,
  secondary,
  danger,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly secondary?: boolean;
  readonly danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary && styles.buttonSecondary,
        danger && styles.buttonDanger,
        disabled && styles.disabled,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          secondary && styles.buttonSecondaryText,
          danger && styles.buttonDangerText,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  button: {
    alignSelf: "flex-start",
    backgroundColor: palette.forest,
    borderColor: palette.forest,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buttonDanger: { backgroundColor: "transparent", borderColor: "#9b443d" },
  buttonDangerText: { color: "#8a3128" },
  buttonSecondary: { backgroundColor: "transparent", borderColor: palette.line },
  buttonSecondaryText: { color: palette.forest },
  buttonText: { color: palette.white, fontSize: 13, fontWeight: "800" },
  card: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 12,
    padding: 14,
  },
  cardTitle: { color: palette.ink, fontSize: 17, fontWeight: "700" },
  chip: {
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  wrappingChip: { maxWidth: "100%", minWidth: 0, flexShrink: 1 },
  chipActive: { backgroundColor: palette.forest, borderColor: palette.forest },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chipText: { color: palette.muted, fontSize: 12, fontWeight: "700" },
  chipTextActive: { color: palette.white },
  content: { padding: 22, paddingBottom: 80 },
  disabled: { opacity: 0.5 },
  editor: {
    borderColor: palette.line,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 14,
    padding: 14,
  },
  heading: { color: palette.ink, fontSize: 26, fontWeight: "700", letterSpacing: -0.6 },
  help: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 9 },
  input: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 9,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 15,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  intro: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 8 },
  kicker: { color: palette.forest, fontSize: 11, fontWeight: "800", letterSpacing: 1.4 },
  label: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "800",
    marginBottom: 5,
    marginTop: 13,
    textTransform: "uppercase",
  },
  meta: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 5 },
  multiline: { minHeight: 100, paddingTop: 12, textAlignVertical: "top" },
  rowText: { color: palette.ink, fontSize: 13, lineHeight: 20, marginTop: 7 },
  savedNutrients: { minWidth: 0, width: "100%", marginTop: 14 },
  savedNutrientRow: { minWidth: 0, width: "100%", marginTop: 7 },
  screen: { backgroundColor: palette.paper, flex: 1 },
  section: { borderTopColor: palette.line, borderTopWidth: 1, marginTop: 34, paddingTop: 28 },
  status: { color: palette.forest, fontSize: 13, lineHeight: 19, marginVertical: 18 },
  subheading: { color: palette.ink, fontSize: 20, fontWeight: "700", marginTop: 24 },
  title: { color: palette.ink, fontSize: 35, fontWeight: "700", letterSpacing: -1, marginTop: 6 },
  warning: {
    backgroundColor: "#f7e6b0",
    borderRadius: 10,
    color: "#6b4c00",
    fontSize: 13,
    lineHeight: 20,
    marginTop: 22,
    padding: 14,
  },
});
