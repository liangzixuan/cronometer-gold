import { type BarcodeScanningResult, CameraView } from "expo-camera";
import { useEffect, useRef } from "react";
import { AppState, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { palette } from "../theme";
import {
  canOpenBarcodeScanner,
  createBarcodeScannerEventGate,
  FOOD_BARCODE_TYPES,
} from "./barcode-scanner";

interface BarcodeScannerModalProps {
  readonly onCancel: () => void;
  readonly onError: () => void;
  readonly onScanned: (result: Pick<BarcodeScanningResult, "data" | "type">) => void;
}

export function BarcodeScannerModal({ onCancel, onError, onScanned }: BarcodeScannerModalProps) {
  const callbacks = useRef({ onCancel, onError, onScanned });
  callbacks.current = { onCancel, onError, onScanned };
  const startedInForeground = useRef(canOpenBarcodeScanner(AppState.currentState)).current;
  const gate = useRef(
    createBarcodeScannerEventGate<Pick<BarcodeScanningResult, "data" | "type">>({
      onCancel: () => callbacks.current.onCancel(),
      onError: () => callbacks.current.onError(),
      onScanned: (result) => callbacks.current.onScanned(result),
    }),
  );

  useEffect(() => {
    if (!startedInForeground || !canOpenBarcodeScanner(AppState.currentState)) {
      gate.current.cancel();
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") gate.current.cancel();
    });
    return () => subscription.remove();
  }, [startedInForeground]);

  function handleScan(result: BarcodeScanningResult) {
    gate.current.scan(result);
  }

  function handleMountError() {
    gate.current.error();
  }

  function handleCancel() {
    gate.current.cancel();
  }

  return (
    <Modal
      animationType="slide"
      onRequestClose={handleCancel}
      presentationStyle="fullScreen"
      statusBarTranslucent
      visible
    >
      <View accessibilityViewIsModal style={styles.container}>
        {startedInForeground ? (
          <CameraView
            accessible={false}
            barcodeScannerSettings={{ barcodeTypes: [...FOOD_BARCODE_TYPES] }}
            facing="back"
            onBarcodeScanned={handleScan}
            onMountError={handleMountError}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <SafeAreaView pointerEvents="box-none" style={styles.safeArea}>
          <View accessibilityRole="summary" style={styles.instructions}>
            <Text accessibilityRole="header" style={styles.title}>
              Scan a food barcode
            </Text>
            <Text style={styles.copy}>
              Center the UPC, EAN, or ITF-14 code inside the frame. The first camera reading is
              checked against the current catalogue.
            </Text>
          </View>
          <View accessible={false} pointerEvents="none" style={styles.frame} />
          <Pressable
            accessibilityHint="Closes the camera without looking up a barcode"
            accessibilityLabel="Cancel barcode scan"
            accessibilityRole="button"
            onPress={handleCancel}
            style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  cancelButton: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: palette.white,
    borderRadius: 999,
    justifyContent: "center",
    minHeight: 52,
    minWidth: 160,
    paddingHorizontal: 24,
  },
  cancelText: { color: palette.ink, fontSize: 16, fontWeight: "800" },
  container: { backgroundColor: palette.ink, flex: 1 },
  copy: {
    color: palette.white,
    fontSize: 15,
    lineHeight: 21,
    marginTop: 8,
    textAlign: "center",
  },
  frame: {
    alignSelf: "center",
    borderColor: palette.white,
    borderRadius: 18,
    borderWidth: 3,
    height: 190,
    width: "82%",
  },
  instructions: {
    backgroundColor: "rgba(23, 33, 29, 0.82)",
    borderRadius: 14,
    marginHorizontal: 20,
    padding: 18,
  },
  pressed: { opacity: 0.72 },
  safeArea: {
    flex: 1,
    justifyContent: "space-between",
    paddingBottom: 24,
    paddingTop: 12,
  },
  title: { color: palette.white, fontSize: 24, fontWeight: "800", textAlign: "center" },
});
