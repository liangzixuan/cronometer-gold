"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  isLocalDate,
  localDateInTimeZone,
  localDateTimeToInstant,
  localTimeInTimeZone,
  type MealSlot,
  mealSlots,
  parseDiaryMutation,
  parseSession,
  quoteRevision,
  type SessionSummary,
  shiftLocalDate,
} from "../../lib/diary";
import { confirmBrowserLogout } from "../../lib/private-api";
import { parseTargetableNutrients, type TargetableNutrient } from "../../lib/recipes-goals";
import {
  type AccountErasureJob,
  type AccountExportJob,
  type BiometricDefinition,
  type BiometricEvent,
  type BiometricTrend,
  biometricEventLocalTimeUnchanged,
  type CustomFood,
  type CustomFoodNutrient,
  isPositiveInputDecimal,
  isSignedExactDecimal,
  type NutrientTrend,
  operationId,
  type PlatformIntegration,
  parseBiometricDefinitionResponse,
  parseBiometricDefinitions,
  parseBiometricEvents,
  parseBiometricMutation,
  parseBiometricTrend,
  parseCustomFoodList,
  parseCustomFoodMutation,
  parseErasureJob,
  parseExportJob,
  parseIntegrations,
  parseNutrientTrend,
  parseReauthentication,
  parseReminderResponse,
  parseReminders,
  type Reminder,
  trendAggregateLabel,
} from "../../lib/retention";

type LoadState = "loading" | "ready" | "error";

interface CustomDraft {
  readonly id: string | null;
  readonly revision: string | null;
  readonly name: string;
  readonly brandName: string;
  readonly servingLabel: string;
  readonly servingGrams: string;
  readonly notes: string;
  readonly nutrients: readonly CustomFoodNutrient[];
}

interface ReminderDraft {
  readonly id: string | null;
  readonly revision: string | null;
  readonly label: string;
  readonly localTime: string;
  readonly daysOfWeek: readonly number[];
  readonly status: "active" | "paused";
}

interface CustomLogDraft {
  readonly food: CustomFood;
  readonly kind: "serving" | "grams";
  readonly quantity: string;
  readonly mealSlot: MealSlot;
  readonly localDate: string;
  readonly localTime: string;
}

const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseError(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" && error.length <= 500 ? error : fallback;
}

function blankCustom(nutrientId: string): CustomDraft {
  return {
    id: null,
    revision: null,
    name: "",
    brandName: "",
    servingLabel: "",
    servingGrams: "",
    notes: "",
    nutrients: nutrientId ? [{ nutrientId, state: "quantified", amountPer100Grams: "0" }] : [],
  };
}

function customDraft(food: CustomFood): CustomDraft {
  return {
    id: food.id,
    revision: food.revision,
    name: food.currentVersion.name,
    brandName: food.currentVersion.brandName ?? "",
    servingLabel: food.currentVersion.serving?.label ?? "",
    servingGrams: food.currentVersion.serving?.grams ?? "",
    notes: food.currentVersion.notes ?? "",
    nutrients: food.currentVersion.nutrients.map((snapshot) =>
      snapshot.state === "quantified"
        ? {
            nutrientId: snapshot.nutrient.id,
            state: snapshot.state,
            amountPer100Grams: snapshot.amountPer100Grams,
          }
        : snapshot.state === "trace"
          ? { nutrientId: snapshot.nutrient.id, state: snapshot.state, amountPer100Grams: null }
          : {
              nutrientId: snapshot.nutrient.id,
              state: snapshot.state,
              amountPer100Grams: null,
              reason: snapshot.reason,
            },
    ),
  };
}

function reminderDraft(reminder?: Reminder): ReminderDraft {
  return reminder
    ? {
        id: reminder.id,
        revision: reminder.revision,
        label: reminder.label,
        localTime: reminder.localTime,
        daysOfWeek: reminder.daysOfWeek,
        status: reminder.status === "paused" ? "paused" : "active",
      }
    : {
        id: null,
        revision: null,
        label: "",
        localTime: "20:00",
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        status: "active",
      };
}

export function HealthClient() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Opening your private health workspace…");
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [nutrients, setNutrients] = useState<readonly TargetableNutrient[]>([]);
  const [customFoods, setCustomFoods] = useState<readonly CustomFood[]>([]);
  const [customFoodCursor, setCustomFoodCursor] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<readonly BiometricDefinition[]>([]);
  const [events, setEvents] = useState<readonly BiometricEvent[]>([]);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [eventWindow, setEventWindow] = useState<{
    readonly from: string;
    readonly to: string;
  } | null>(null);
  const [reminders, setReminders] = useState<readonly Reminder[]>([]);
  const [integrations, setIntegrations] = useState<readonly PlatformIntegration[]>([]);
  const [custom, setCustom] = useState<CustomDraft>(() => blankCustom(""));
  const [customLog, setCustomLog] = useState<CustomLogDraft | null>(null);
  const [definitionName, setDefinitionName] = useState("Weight");
  const [definitionDimension, setDefinitionDimension] = useState<
    "mass" | "length" | "temperature" | "duration" | "count" | "other"
  >("mass");
  const [definitionUnit, setDefinitionUnit] = useState("kg");
  const [editingDefinition, setEditingDefinition] = useState<BiometricDefinition | null>(null);
  const [selectedDefinition, setSelectedDefinition] = useState("");
  const [eventValue, setEventValue] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventTime, setEventTime] = useState("");
  const [editingEvent, setEditingEvent] = useState<BiometricEvent | null>(null);
  const [reminder, setReminder] = useState<ReminderDraft>(() => reminderDraft());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedNutrient, setSelectedNutrient] = useState("");
  const [nutrientTrend, setNutrientTrend] = useState<NutrientTrend | null>(null);
  const [biometricTrend, setBiometricTrend] = useState<BiometricTrend | null>(null);
  const [exportJob, setExportJob] = useState<AccountExportJob | null>(null);
  const [erasureJob, setErasureJob] = useState<AccountErasureJob | null>(null);
  const [password, setPassword] = useState("");
  const [confirmConsequences, setConfirmConsequences] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const operations = useRef(new Map<string, string>());
  const loadController = useRef<AbortController | null>(null);
  const trendController = useRef<AbortController | null>(null);

  const signInAgain = useCallback(() => {
    router.replace("/login");
    router.refresh();
  }, [router]);

  const operation = useCallback((key: string) => {
    const existing = operations.current.get(key);
    if (existing) return existing;
    const created = operationId();
    operations.current.set(key, created);
    return created;
  }, []);

  const request = useCallback(
    async (
      path: string,
      input: {
        readonly method?: "DELETE" | "PATCH" | "POST";
        readonly body?: unknown;
        readonly key?: string;
        readonly revision?: string;
        readonly recentAuth?: string;
      } = {},
    ) => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (input.body !== undefined) headers["content-type"] = "application/json";
      if (input.key) headers["idempotency-key"] = operation(input.key);
      if (input.revision) headers["if-match"] = quoteRevision(input.revision);
      if (input.recentAuth) headers["x-reauthentication-token"] = input.recentAuth;
      const response = await fetch(`/api/retention/${path}`, {
        method: input.method ?? "GET",
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        cache: "no-store",
      });
      if (response.status === 401) {
        signInAgain();
        throw new Error("Sign in to continue.");
      }
      const body = await json(response);
      if (!response.ok) throw new Error(responseError(body, "The private health request failed."));
      return body;
    },
    [operation, signInAgain],
  );

  const loadAll = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setState("loading");
    try {
      const sessionResponse = await fetch("/api/auth/me", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (sessionResponse.status === 401) return signInAgain();
      const nextSession = parseSession(await json(sessionResponse));
      const now = new Date();
      const localToday = localDateInTimeZone(now, nextSession.profile.timeZone);
      const rangeStart = new Date(now.getTime() - 120 * 24 * 60 * 60 * 1_000).toISOString();
      const rangeEnd = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
      const responses = await Promise.all([
        fetch("/api/nutrients/targetable", { cache: "no-store", signal: controller.signal }),
        fetch("/api/retention/custom-foods?limit=50", {
          cache: "no-store",
          signal: controller.signal,
        }),
        fetch("/api/retention/biometrics/definitions", {
          cache: "no-store",
          signal: controller.signal,
        }),
        fetch(
          `/api/retention/biometrics/events?from=${encodeURIComponent(rangeStart)}&to=${encodeURIComponent(rangeEnd)}&limit=100`,
          { cache: "no-store", signal: controller.signal },
        ),
        fetch("/api/retention/reminders", { cache: "no-store", signal: controller.signal }),
        fetch("/api/retention/integrations/health", {
          cache: "no-store",
          signal: controller.signal,
        }),
      ]);
      if (responses.some((response) => response.status === 401)) return signInAgain();
      for (const response of responses) {
        if (!response.ok)
          throw new Error(
            responseError(await json(response), "Private health data could not be loaded."),
          );
      }
      const [nutrientBody, customBody, definitionBody, eventBody, reminderBody, integrationBody] =
        await Promise.all(responses.map(json));
      if (controller.signal.aborted) return;
      const nextNutrients = parseTargetableNutrients(nutrientBody);
      const nextDefinitions = parseBiometricDefinitions(definitionBody);
      setSession(nextSession);
      setNutrients(nextNutrients);
      const customPage = parseCustomFoodList(customBody);
      const eventPage = parseBiometricEvents(eventBody);
      setCustomFoods(customPage.items);
      setCustomFoodCursor(customPage.nextCursor);
      setDefinitions(nextDefinitions);
      setEvents(eventPage.items);
      setEventCursor(eventPage.nextCursor);
      setEventWindow({ from: rangeStart, to: rangeEnd });
      setReminders(parseReminders(reminderBody));
      setIntegrations(parseIntegrations(integrationBody));
      setFrom((value) => value || shiftLocalDate(localToday, -13));
      setTo((value) => value || localToday);
      setEventDate((value) => value || localToday);
      setEventTime(
        (value) => value || localTimeInTimeZone(now, nextSession.profile.timeZone).slice(0, 5),
      );
      setSelectedNutrient((value) => value || nextNutrients[0]?.nutrientId || "");
      setSelectedDefinition(
        (value) => value || nextDefinitions.find((item) => item.status === "active")?.id || "",
      );
      setCustom((value) =>
        value.nutrients.length === 0 ? blankCustom(nextNutrients[0]?.nutrientId ?? "") : value,
      );
      setState("ready");
      setMessage("Private health workspace is current.");
    } catch (error) {
      if (controller.signal.aborted) return;
      setState("error");
      setMessage(
        error instanceof Error ? error.message : "Private health data could not be loaded.",
      );
    }
  }, [signInAgain]);

  async function loadMoreCustomFoods() {
    if (!customFoodCursor) return;
    setBusy("custom-more");
    try {
      const page = parseCustomFoodList(
        await request(`custom-foods?limit=50&cursor=${encodeURIComponent(customFoodCursor)}`),
      );
      setCustomFoods((items) => [
        ...items,
        ...page.items.filter((food) => !items.some((existing) => existing.id === food.id)),
      ]);
      setCustomFoodCursor(page.nextCursor);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "More custom foods could not be loaded.");
    } finally {
      setBusy(null);
    }
  }

  async function loadMoreEvents() {
    if (!eventCursor || !eventWindow) return;
    setBusy("event-more");
    try {
      const page = parseBiometricEvents(
        await request(
          `biometrics/events?from=${encodeURIComponent(eventWindow.from)}&to=${encodeURIComponent(eventWindow.to)}&limit=100&cursor=${encodeURIComponent(eventCursor)}`,
        ),
      );
      setEvents((items) => [
        ...items,
        ...page.items.filter((event) => !items.some((existing) => existing.id === event.id)),
      ]);
      setEventCursor(page.nextCursor);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "More biometric events could not be loaded.",
      );
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void loadAll();
    return () => loadController.current?.abort();
  }, [loadAll]);

  useEffect(() => {
    if (!from || !to || !isLocalDate(from) || !isLocalDate(to) || from > to) return;
    trendController.current?.abort();
    const controller = new AbortController();
    trendController.current = controller;
    void (async () => {
      try {
        const requests: Promise<Response>[] = [];
        if (selectedNutrient)
          requests.push(
            fetch(
              `/api/retention/trends/nutrients?nutrientId=${encodeURIComponent(selectedNutrient)}&from=${from}&to=${to}`,
              { cache: "no-store", signal: controller.signal },
            ),
          );
        if (selectedDefinition)
          requests.push(
            fetch(
              `/api/retention/trends/biometrics?definitionId=${encodeURIComponent(selectedDefinition)}&from=${from}&to=${to}`,
              { cache: "no-store", signal: controller.signal },
            ),
          );
        const responses = await Promise.all(requests);
        for (const response of responses)
          if (!response.ok)
            throw new Error(responseError(await json(response), "Trends could not be loaded."));
        if (controller.signal.aborted) return;
        let index = 0;
        setNutrientTrend(
          selectedNutrient ? parseNutrientTrend(await json(responses[index++] as Response)) : null,
        );
        setBiometricTrend(
          selectedDefinition ? parseBiometricTrend(await json(responses[index] as Response)) : null,
        );
      } catch (error) {
        if (!controller.signal.aborted)
          setMessage(error instanceof Error ? error.message : "Trends could not be loaded.");
      }
    })();
    return () => controller.abort();
  }, [from, selectedDefinition, selectedNutrient, to]);

  const selectedDefinitionRecord = useMemo(
    () => definitions.find((definition) => definition.id === selectedDefinition) ?? null,
    [definitions, selectedDefinition],
  );

  async function saveCustomFood() {
    if (!custom.name.trim() || custom.nutrients.length < 1)
      return setMessage("Name and at least one nutrient are required.");
    if (
      new Set(custom.nutrients.map((nutrient) => nutrient.nutrientId)).size !==
      custom.nutrients.length
    ) {
      return setMessage("Each nutrient can appear only once in a custom food.");
    }
    if (
      (custom.servingLabel.trim() || custom.servingGrams.trim()) &&
      (!custom.servingLabel.trim() || !isPositiveInputDecimal(custom.servingGrams))
    ) {
      return setMessage("A serving needs both a label and positive grams.");
    }
    for (const nutrient of custom.nutrients) {
      if (
        nutrient.state === "quantified" &&
        !isPositiveInputDecimal(nutrient.amountPer100Grams) &&
        nutrient.amountPer100Grams !== "0"
      ) {
        return setMessage("Quantified nutrients require canonical non-negative values per 100 g.");
      }
    }
    const body = {
      name: custom.name.trim(),
      brandName: custom.brandName.trim() || null,
      serving: custom.servingLabel.trim()
        ? { label: custom.servingLabel.trim(), grams: custom.servingGrams }
        : null,
      nutrients: custom.nutrients,
      notes: custom.notes.trim() || null,
    };
    const path = custom.id ? `custom-foods/${custom.id}/revisions` : "custom-foods";
    const key = `custom:${custom.id ?? "new"}:${custom.revision ?? "0"}:${JSON.stringify(body)}`;
    setBusy("custom");
    try {
      const saved = parseCustomFoodMutation(
        await request(path, {
          method: "POST",
          body,
          key,
          ...(custom.revision ? { revision: custom.revision } : {}),
        }),
      );
      operations.current.delete(key);
      setCustomFoods((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setCustom(blankCustom(nutrients[0]?.nutrientId ?? ""));
      setMessage(`Saved private custom food version ${saved.currentVersion.versionNumber}.`);
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "Custom food could not be saved."} Submit again to retry safely.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function archiveCustomFood(food: CustomFood) {
    if (
      !window.confirm(
        `Archive ${food.currentVersion.name}? Historical diary entries keep their pinned version.`,
      )
    )
      return;
    const key = `custom-archive:${food.id}:${food.revision}`;
    setBusy(`custom:${food.id}`);
    try {
      const archived = parseCustomFoodMutation(
        await request(`custom-foods/${food.id}`, {
          method: "DELETE",
          key,
          revision: food.revision,
        }),
      );
      operations.current.delete(key);
      setCustomFoods((items) => items.map((item) => (item.id === archived.id ? archived : item)));
      setMessage("Custom food archived; pinned diary history was preserved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Custom food could not be archived.");
    } finally {
      setBusy(null);
    }
  }

  async function saveDefinition() {
    if (!definitionName.trim() || !definitionUnit.trim())
      return setMessage("Metric name and unit are required.");
    const body = editingDefinition
      ? { name: definitionName.trim(), notes: null }
      : {
          name: definitionName.trim(),
          dimension: definitionDimension,
          canonicalUnit: definitionUnit.trim(),
          notes: null,
        };
    const key = `definition:${editingDefinition?.id ?? "new"}:${editingDefinition?.revision ?? "0"}:${JSON.stringify(body)}`;
    setBusy("definition");
    try {
      const saved = parseBiometricDefinitionResponse(
        await request(
          editingDefinition
            ? `biometrics/definitions/${editingDefinition.id}`
            : "biometrics/definitions",
          {
            method: editingDefinition ? "PATCH" : "POST",
            body,
            key,
            ...(editingDefinition ? { revision: editingDefinition.revision } : {}),
          },
        ),
      );
      operations.current.delete(key);
      setDefinitions((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setEditingDefinition(null);
      setDefinitionName("Weight");
      setDefinitionDimension("mass");
      setDefinitionUnit("kg");
      setMessage("Metric definition saved; historical events keep their canonical unit.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Metric could not be created.");
    } finally {
      setBusy(null);
    }
  }

  async function archiveDefinition(definition: BiometricDefinition) {
    if (!window.confirm(`Archive ${definition.name}? Existing events and trends remain available.`))
      return;
    const key = `definition-archive:${definition.id}:${definition.revision}`;
    setBusy(`definition:${definition.id}`);
    try {
      const archived = parseBiometricDefinitionResponse(
        await request(`biometrics/definitions/${definition.id}`, {
          method: "DELETE",
          key,
          revision: definition.revision,
        }),
      );
      operations.current.delete(key);
      setDefinitions((items) => items.map((item) => (item.id === archived.id ? archived : item)));
      setMessage("Metric archived; historical events remain visible.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Metric could not be archived.");
    } finally {
      setBusy(null);
    }
  }

  async function logCustomFood() {
    if (!session || !customLog || !isPositiveInputDecimal(customLog.quantity)) {
      return setMessage("Choose a private food and enter a positive canonical quantity.");
    }
    const serving = customLog.food.currentVersion.serving;
    if (customLog.kind === "serving" && !serving)
      return setMessage("This food has no serving definition.");
    const body = {
      customFoodVersionId: customLog.food.currentVersion.id,
      portion:
        customLog.kind === "serving" && serving
          ? { kind: "serving" as const, servingId: serving.id, amount: customLog.quantity }
          : { kind: "grams" as const, grams: customLog.quantity },
      mealSlot: customLog.mealSlot,
      occurredAt: localDateTimeToInstant(
        customLog.localDate,
        customLog.localTime,
        session.profile.timeZone,
      ),
    };
    const key = `custom-log:${customLog.food.id}:${customLog.food.currentVersion.id}:${JSON.stringify(body)}`;
    setBusy("custom-log");
    try {
      const mutation = parseDiaryMutation(
        await request(`custom-foods/${customLog.food.id}/log`, { method: "POST", body, key }),
      );
      operations.current.delete(key);
      setCustomLog(null);
      setMessage(
        `Pinned private food version logged to ${mutation.entry?.localDate ?? customLog.localDate}.`,
      );
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "Private food could not be logged."} Submit again to retry the exact version safely.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function saveEvent() {
    if (
      !session ||
      !selectedDefinitionRecord ||
      !isSignedExactDecimal(eventValue) ||
      !isLocalDate(eventDate) ||
      !/^\d{2}:\d{2}$/u.test(eventTime)
    ) {
      return setMessage("Metric, exact value, local date, and local time are required.");
    }
    const localTimeChanged =
      editingEvent !== null &&
      !biometricEventLocalTimeUnchanged(editingEvent, eventDate, eventTime);
    const body = editingEvent
      ? {
          value: eventValue,
          ...(localTimeChanged
            ? { measuredAt: localDateTimeToInstant(eventDate, eventTime, session.profile.timeZone) }
            : {}),
        }
      : {
          definitionId: selectedDefinitionRecord.id,
          measuredAt: localDateTimeToInstant(eventDate, eventTime, session.profile.timeZone),
          value: eventValue,
        };
    const path = editingEvent ? `biometrics/events/${editingEvent.id}` : "biometrics/events";
    const key = `event:${editingEvent?.id ?? "new"}:${editingEvent?.revision ?? "0"}:${JSON.stringify(body)}`;
    setBusy("event");
    try {
      const saved = parseBiometricMutation(
        await request(path, {
          method: editingEvent ? "PATCH" : "POST",
          body,
          key,
          ...(editingEvent ? { revision: editingEvent.revision } : {}),
        }),
      );
      operations.current.delete(key);
      if (saved) setEvents((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setEditingEvent(null);
      setEventValue("");
      setMessage("Biometric event saved with its exact entered decimal.");
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "Biometric event could not be saved."} Submit again to retry safely.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function deleteEvent(event: BiometricEvent) {
    if (event.source.kind !== "manual" || !window.confirm("Delete this manual biometric event?"))
      return;
    const key = `event-delete:${event.id}:${event.revision}`;
    setBusy(`event:${event.id}`);
    try {
      parseBiometricMutation(
        await request(`biometrics/events/${event.id}`, {
          method: "DELETE",
          key,
          revision: event.revision,
        }),
      );
      operations.current.delete(key);
      setEvents((items) => items.filter((item) => item.id !== event.id));
      setMessage("Manual biometric event deleted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Biometric event could not be deleted.");
    } finally {
      setBusy(null);
    }
  }

  async function saveReminder() {
    if (!session || !reminder.label.trim() || reminder.daysOfWeek.length < 1)
      return setMessage("Reminder label, time, and at least one day are required.");
    const body = reminder.id
      ? {
          label: reminder.label.trim(),
          localTime: reminder.localTime,
          daysOfWeek: reminder.daysOfWeek,
          timeZone: session.profile.timeZone,
          status: reminder.status,
        }
      : {
          label: reminder.label.trim(),
          localTime: reminder.localTime,
          daysOfWeek: reminder.daysOfWeek,
          timeZone: session.profile.timeZone,
          channel: "local" as const,
          consentGranted: true as const,
        };
    const path = reminder.id ? `reminders/${reminder.id}` : "reminders";
    const key = `reminder:${reminder.id ?? "new"}:${reminder.revision ?? "0"}:${JSON.stringify(body)}`;
    setBusy("reminder");
    try {
      const saved = parseReminderResponse(
        await request(path, {
          method: reminder.id ? "PATCH" : "POST",
          body,
          key,
          ...(reminder.revision ? { revision: reminder.revision } : {}),
        }),
      );
      operations.current.delete(key);
      setReminders((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setReminder(reminderDraft());
      setMessage("Reminder saved. A signed mobile app must sync it before local delivery begins.");
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "Reminder could not be saved."} Submit again to retry safely.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function changeReminder(reminderRecord: Reminder, action: "pause" | "resume" | "delete") {
    if (
      action === "delete" &&
      !window.confirm("Delete this reminder and revoke notification consent for it?")
    )
      return;
    const key = `reminder-${action}:${reminderRecord.id}:${reminderRecord.revision}`;
    setBusy(`reminder:${reminderRecord.id}`);
    try {
      const saved = parseReminderResponse(
        await request(`reminders/${reminderRecord.id}`, {
          method: action === "delete" ? "DELETE" : "PATCH",
          ...(action === "delete"
            ? {}
            : {
                body: {
                  label: reminderRecord.label,
                  localTime: reminderRecord.localTime,
                  daysOfWeek: reminderRecord.daysOfWeek,
                  timeZone: reminderRecord.timeZone,
                  status: action === "pause" ? "paused" : "active",
                },
              }),
          key,
          revision: reminderRecord.revision,
        }),
      );
      operations.current.delete(key);
      setReminders((items) => items.map((item) => (item.id === saved.id ? saved : item)));
      setMessage(
        action === "delete" ? "Reminder deleted and consent revoked." : `Reminder ${action}d.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Reminder could not be changed.");
    } finally {
      setBusy(null);
    }
  }

  async function reauthenticate(purpose: "account_export" | "account_erasure"): Promise<string> {
    if (!password) throw new Error("Enter your current password to continue.");
    const key = `reauth:${Date.now()}`;
    const proof = parseReauthentication(
      await request("auth/reauthenticate", { method: "POST", body: { password, purpose }, key }),
    );
    operations.current.delete(key);
    setPassword("");
    return proof.reauthenticationToken;
  }

  async function requestExport() {
    setBusy("export");
    try {
      const proof = await reauthenticate("account_export");
      const body = { formats: ["json", "csv"] };
      const key = `export:${JSON.stringify(body)}`;
      const job = parseExportJob(
        await request("exports", { method: "POST", body, key, recentAuth: proof }),
      );
      operations.current.delete(key);
      setExportJob(job);
      setMessage("Complete JSON and CSV export queued. Reconciliation status will be shown here.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export could not be requested.");
    } finally {
      setBusy(null);
    }
  }

  async function refreshExport() {
    if (!exportJob) return;
    setBusy("export-status");
    try {
      setExportJob(parseExportJob(await request(`exports/${exportJob.id}`)));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export status could not be refreshed.");
    } finally {
      setBusy(null);
    }
  }

  async function requestErasure() {
    if (
      !confirmConsequences ||
      !window.confirm(
        "Permanently erase the account after the disclosed processing window? This cannot be undone.",
      )
    )
      return;
    setBusy("erasure");
    let staged = false;
    try {
      const proof = await reauthenticate("account_erasure");
      const body = { confirmation: "DELETE_MY_ACCOUNT" };
      const key = `erasure:${JSON.stringify(body)}`;
      await request("account/erasure/stage", {
        method: "POST",
        body,
        key,
        recentAuth: proof,
      });
      staged = true;
      const response = await fetch("/api/retention/account/erasure/submit", {
        method: "POST",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const value = await json(response);
      if (!response.ok) {
        throw new Error(responseError(value, "The protected erasure response was not received."));
      }
      const job = parseErasureJob(value);
      setErasureJob(job);
      setMessage("Account erasure request accepted. Opening the restart-safe status page…");
      window.location.assign("/erasure-status");
    } catch (error) {
      if (staged) {
        // The protected HttpOnly pending envelope survives an upstream or browser response loss.
        window.location.assign("/erasure-status");
      } else {
        setMessage(error instanceof Error ? error.message : "Erasure could not be requested.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function refreshErasure() {
    if (!erasureJob) return;
    setBusy("erasure-status");
    try {
      setErasureJob(parseErasureJob(await request("account/erasure/status")));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Erasure status could not be refreshed.");
    } finally {
      setBusy(null);
    }
  }

  async function signOut() {
    setBusy("logout");
    const confirmed = await confirmBrowserLogout(
      () => fetch("/api/auth/logout", { method: "POST", cache: "no-store" }),
      signInAgain,
    );
    if (!confirmed) {
      setMessage("Sign out could not be confirmed. Your private workspace remains open.");
      setBusy(null);
    }
  }

  return (
    <>
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          nutrition<span>/ledger</span>
        </Link>
        <nav aria-label="Application navigation">
          <Link href="/dashboard">Diary</Link>
          <Link href="/foods">Foods</Link>
          <Link href="/recipes">Recipes</Link>
          <Link href="/goals">Goals</Link>
          <Link aria-current="page" href="/health">
            Health & privacy
          </Link>
        </nav>
        {session ? <p className="accountIdentity">Signed in as {session.user.email}</p> : null}
        <button
          className="signOutButton"
          disabled={busy === "logout"}
          onClick={() => void signOut()}
          type="button"
        >
          Sign out
        </button>
        <p className="wellnessNote">Wellness information only—not medical advice.</p>
      </aside>

      <main className="dashboard retentionDashboard">
        <header className="dashboardHeader">
          <div>
            <p className="kicker">Retention milestone</p>
            <h1>Health, trends & privacy</h1>
          </div>
          <span className="statusPill">{session?.profile.timeZone ?? "Profile time"}</span>
        </header>
        <p className={`diaryStatus diaryStatus--${state}`} role="status" aria-live="polite">
          {message}
        </p>
        {state === "error" ? (
          <button className="secondaryAction" onClick={() => void loadAll()} type="button">
            Retry private data
          </button>
        ) : null}

        <section className="retentionSection" aria-labelledby="trends-heading">
          <div className="sectionHeading">
            <div>
              <p className="kicker">Timezone-correct local days</p>
              <h2 id="trends-heading">Trends</h2>
            </div>
            <p>
              Partial nutrition is labeled as a lower bound; the browser never fills missing
              nutrients with zero.
            </p>
          </div>
          <fieldset className="retentionFilters">
            <legend>Date range and series</legend>
            <label>
              From
              <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
            <label>
              Nutrient
              <select
                value={selectedNutrient}
                onChange={(event) => setSelectedNutrient(event.target.value)}
              >
                {nutrients.map((item) => (
                  <option key={item.nutrientId} value={item.nutrientId}>
                    {item.name} ({item.unit})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Biometric
              <select
                value={selectedDefinition}
                onChange={(event) => setSelectedDefinition(event.target.value)}
              >
                <option value="">None</option>
                {definitions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.canonicalUnit})
                    {item.status === "archived" ? " · archived" : ""}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          <div className="trendTables">
            <div>
              <h3>{nutrientTrend?.nutrient.name ?? "Nutrition"}</h3>
              <p className="finePrint">
                Buckets use {nutrientTrend?.timeZone ?? session?.profile.timeZone ?? "profile time"}
                ; UTC bounds preserve 23/25-hour days.
              </p>
              <ul className="compactList">
                {nutrientTrend?.points.map((point) => (
                  <li key={point.localDate}>
                    <span>{point.localDate}</span>
                    <strong>{trendAggregateLabel(point.aggregate)}</strong>
                  </li>
                )) ?? <li>Choose a range to load server totals.</li>}
              </ul>
            </div>
            <div>
              <h3>{biometricTrend?.definition.name ?? "Biometrics"}</h3>
              <p className="finePrint">
                Exact entered values; no averages are calculated in JavaScript.
              </p>
              <ul className="compactList">
                {biometricTrend?.points.map((point) => (
                  <li key={point.localDate}>
                    <span>
                      {point.localDate} · {point.count} sample{point.count === 1 ? "" : "s"}
                    </span>
                    <strong>
                      {point.last} {biometricTrend.definition.canonicalUnit}
                    </strong>
                    <small>
                      min {point.minimum} · max {point.maximum}
                    </small>
                  </li>
                )) ?? <li>Choose a metric to load server aggregates.</li>}
              </ul>
            </div>
          </div>
        </section>

        <section className="retentionSection" aria-labelledby="custom-food-heading">
          <div className="sectionHeading">
            <div>
              <p className="kicker">Private and versioned</p>
              <h2 id="custom-food-heading">Custom foods</h2>
            </div>
            <p>
              Serving grams and nutrient values are canonical inputs. Revisions never rewrite diary
              history.
            </p>
          </div>
          <div className="retentionColumns">
            <form
              className="retentionForm"
              onSubmit={(event) => {
                event.preventDefault();
                void saveCustomFood();
              }}
            >
              <label>
                Name
                <input
                  maxLength={500}
                  value={custom.name}
                  onChange={(event) => setCustom({ ...custom, name: event.target.value })}
                />
              </label>
              <label>
                Brand (optional)
                <input
                  maxLength={300}
                  value={custom.brandName}
                  onChange={(event) => setCustom({ ...custom, brandName: event.target.value })}
                />
              </label>
              <div className="inlineFields">
                <label>
                  Serving label
                  <input
                    maxLength={200}
                    value={custom.servingLabel}
                    onChange={(event) => setCustom({ ...custom, servingLabel: event.target.value })}
                  />
                </label>
                <label>
                  Serving grams
                  <input
                    inputMode="decimal"
                    maxLength={19}
                    value={custom.servingGrams}
                    onChange={(event) => setCustom({ ...custom, servingGrams: event.target.value })}
                  />
                </label>
              </div>
              <fieldset>
                <legend>Nutrients per 100 g</legend>
                {custom.nutrients.map((row, index) => (
                  <div className="nutrientDraftRow" key={row.nutrientId}>
                    <select
                      aria-label={`Nutrient ${index + 1}`}
                      value={row.nutrientId}
                      onChange={(event) =>
                        setCustom({
                          ...custom,
                          nutrients: custom.nutrients.map((item, rowIndex) =>
                            rowIndex === index
                              ? {
                                  nutrientId: event.target.value,
                                  state: "quantified",
                                  amountPer100Grams: "0",
                                }
                              : item,
                          ),
                        })
                      }
                    >
                      {nutrients.map((item) => (
                        <option key={item.nutrientId} value={item.nutrientId}>
                          {item.name} ({item.unit})
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`Nutrient state ${index + 1}`}
                      value={row.state}
                      onChange={(event) => {
                        const stateValue = event.target.value;
                        setCustom({
                          ...custom,
                          nutrients: custom.nutrients.map((item, rowIndex) =>
                            rowIndex !== index
                              ? item
                              : stateValue === "quantified"
                                ? {
                                    nutrientId: item.nutrientId,
                                    state: "quantified",
                                    amountPer100Grams: "0",
                                  }
                                : stateValue === "trace"
                                  ? {
                                      nutrientId: item.nutrientId,
                                      state: "trace",
                                      amountPer100Grams: null,
                                    }
                                  : {
                                      nutrientId: item.nutrientId,
                                      state: "unknown",
                                      amountPer100Grams: null,
                                      reason: "not_reported",
                                    },
                          ),
                        });
                      }}
                    >
                      <option value="quantified">Quantified</option>
                      <option value="trace">Trace</option>
                      <option value="unknown">Unknown</option>
                    </select>
                    {row.state === "quantified" ? (
                      <input
                        aria-label={`Amount per 100 grams ${index + 1}`}
                        inputMode="decimal"
                        value={row.amountPer100Grams}
                        onChange={(event) =>
                          setCustom({
                            ...custom,
                            nutrients: custom.nutrients.map((item, rowIndex) =>
                              rowIndex === index && item.state === "quantified"
                                ? { ...item, amountPer100Grams: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    ) : row.state === "unknown" ? (
                      <select
                        aria-label={`Unknown reason ${index + 1}`}
                        value={row.reason}
                        onChange={(event) =>
                          setCustom({
                            ...custom,
                            nutrients: custom.nutrients.map((item, rowIndex) =>
                              rowIndex === index && item.state === "unknown"
                                ? {
                                    ...item,
                                    reason: event.target.value as
                                      | "not_reported"
                                      | "not_analyzed"
                                      | "not_applicable"
                                      | "withheld",
                                  }
                                : item,
                            ),
                          })
                        }
                      >
                        <option value="not_reported">Not reported</option>
                        <option value="not_analyzed">Not analyzed</option>
                        <option value="not_applicable">Not applicable</option>
                        <option value="withheld">Withheld</option>
                      </select>
                    ) : (
                      <span>Trace amount</span>
                    )}
                    <button
                      aria-label={`Remove nutrient ${index + 1}`}
                      onClick={() =>
                        setCustom({
                          ...custom,
                          nutrients: custom.nutrients.filter((_, rowIndex) => rowIndex !== index),
                        })
                      }
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => {
                    const nutrientId = nutrients.find(
                      (item) => !custom.nutrients.some((row) => row.nutrientId === item.nutrientId),
                    )?.nutrientId;
                    if (nutrientId)
                      setCustom({
                        ...custom,
                        nutrients: [
                          ...custom.nutrients,
                          { nutrientId, state: "quantified", amountPer100Grams: "0" },
                        ],
                      });
                  }}
                  type="button"
                >
                  Add nutrient
                </button>
              </fieldset>
              <label>
                Notes (optional)
                <textarea
                  maxLength={2000}
                  value={custom.notes}
                  onChange={(event) => setCustom({ ...custom, notes: event.target.value })}
                />
              </label>
              <div className="entryActions">
                <button disabled={busy === "custom"} type="submit">
                  {busy === "custom"
                    ? "Saving…"
                    : custom.id
                      ? "Save new version"
                      : "Create private food"}
                </button>
                {custom.id ? (
                  <button
                    onClick={() => setCustom(blankCustom(nutrients[0]?.nutrientId ?? ""))}
                    type="button"
                  >
                    Cancel edit
                  </button>
                ) : null}
              </div>
            </form>
            <div>
              <ul className="recordList">
                {customFoods.map((food) => (
                  <li key={food.id}>
                    <div>
                      <strong>{food.currentVersion.name}</strong>
                      <small>
                        v{food.currentVersion.versionNumber} · {food.status} · private user-entered
                        data
                      </small>
                    </div>
                    <div className="entryActions">
                      <button onClick={() => setCustom(customDraft(food))} type="button">
                        Revise
                      </button>
                      {food.status === "active" ? (
                        <>
                          <button
                            onClick={() => {
                              const now = new Date();
                              setCustomLog({
                                food,
                                kind: food.currentVersion.serving ? "serving" : "grams",
                                quantity: "1",
                                mealSlot: "snacks",
                                localDate: localDateInTimeZone(
                                  now,
                                  session?.profile.timeZone ?? "UTC",
                                ),
                                localTime: localTimeInTimeZone(
                                  now,
                                  session?.profile.timeZone ?? "UTC",
                                ).slice(0, 5),
                              });
                            }}
                            type="button"
                          >
                            Log pinned v{food.currentVersion.versionNumber}
                          </button>
                          <button
                            className="dangerAction"
                            disabled={busy === `custom:${food.id}`}
                            onClick={() => void archiveCustomFood(food)}
                            type="button"
                          >
                            Archive
                          </button>
                        </>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
              {customFoodCursor ? (
                <button
                  disabled={busy === "custom-more"}
                  onClick={() => void loadMoreCustomFoods()}
                  type="button"
                >
                  Load more private foods
                </button>
              ) : null}
              {customLog ? (
                <form
                  className="retentionForm"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void logCustomFood();
                  }}
                >
                  <h3>
                    Log {customLog.food.currentVersion.name} v
                    {customLog.food.currentVersion.versionNumber}
                  </h3>
                  <div className="inlineFields">
                    <label>
                      Portion
                      <select
                        value={customLog.kind}
                        onChange={(event) =>
                          setCustomLog({
                            ...customLog,
                            kind: event.target.value as "serving" | "grams",
                          })
                        }
                      >
                        <option value="grams">Grams</option>
                        {customLog.food.currentVersion.serving ? (
                          <option value="serving">
                            {customLog.food.currentVersion.serving.label}
                          </option>
                        ) : null}
                      </select>
                    </label>
                    <label>
                      Exact quantity
                      <input
                        inputMode="decimal"
                        value={customLog.quantity}
                        onChange={(event) =>
                          setCustomLog({ ...customLog, quantity: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Meal
                      <select
                        value={customLog.mealSlot}
                        onChange={(event) =>
                          setCustomLog({ ...customLog, mealSlot: event.target.value as MealSlot })
                        }
                      >
                        {mealSlots.map((slot) => (
                          <option key={slot} value={slot}>
                            {slot}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Local date
                      <input
                        type="date"
                        value={customLog.localDate}
                        onChange={(event) =>
                          setCustomLog({ ...customLog, localDate: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Local time
                      <input
                        type="time"
                        value={customLog.localTime}
                        onChange={(event) =>
                          setCustomLog({ ...customLog, localTime: event.target.value })
                        }
                      />
                    </label>
                  </div>
                  <small>
                    The immutable custom-food version ID is included in the stable retry body.
                  </small>
                  <div className="entryActions">
                    <button disabled={busy === "custom-log"} type="submit">
                      Log exact version
                    </button>
                    <button onClick={() => setCustomLog(null)} type="button">
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          </div>
        </section>

        <section className="retentionSection" aria-labelledby="biometrics-heading">
          <div className="sectionHeading">
            <div>
              <p className="kicker">Manual weight & metrics</p>
              <h2 id="biometrics-heading">Biometrics</h2>
            </div>
            <p>Imported records retain source identity. Only manual records can be edited here.</p>
          </div>
          <div className="retentionColumns">
            <div>
              <form
                className="retentionForm"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveDefinition();
                }}
              >
                <h3>{editingDefinition ? "Revise metric definition" : "Add metric definition"}</h3>
                <div className="inlineFields">
                  <label>
                    Name
                    <input
                      maxLength={120}
                      value={definitionName}
                      onChange={(event) => setDefinitionName(event.target.value)}
                    />
                  </label>
                  <label>
                    Dimension
                    <select
                      disabled={editingDefinition !== null}
                      value={definitionDimension}
                      onChange={(event) =>
                        setDefinitionDimension(event.target.value as typeof definitionDimension)
                      }
                    >
                      <option value="mass">Mass</option>
                      <option value="length">Length</option>
                      <option value="temperature">Temperature</option>
                      <option value="duration">Duration</option>
                      <option value="count">Count</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label>
                    Canonical unit
                    <input
                      disabled={editingDefinition !== null}
                      maxLength={32}
                      value={definitionUnit}
                      onChange={(event) => setDefinitionUnit(event.target.value)}
                    />
                  </label>
                </div>
                <div className="entryActions">
                  <button disabled={busy === "definition"} type="submit">
                    {editingDefinition ? "Save definition revision" : "Add metric"}
                  </button>
                  {editingDefinition ? (
                    <button
                      onClick={() => {
                        setEditingDefinition(null);
                        setDefinitionName("Weight");
                        setDefinitionDimension("mass");
                        setDefinitionUnit("kg");
                      }}
                      type="button"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </form>
              <ul className="recordList">
                {definitions.map((definition) => (
                  <li key={definition.id}>
                    <div>
                      <strong>
                        {definition.name} ({definition.canonicalUnit})
                      </strong>
                      <small>
                        {definition.dimension} · {definition.status}
                      </small>
                    </div>
                    <div className="entryActions">
                      <button
                        onClick={() => {
                          setEditingDefinition(definition);
                          setDefinitionName(definition.name);
                          setDefinitionDimension(definition.dimension);
                          setDefinitionUnit(definition.canonicalUnit);
                        }}
                        type="button"
                      >
                        Revise name
                      </button>
                      {definition.status === "active" ? (
                        <button
                          className="dangerAction"
                          disabled={busy === `definition:${definition.id}`}
                          onClick={() => void archiveDefinition(definition)}
                          type="button"
                        >
                          Archive
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
              <form
                className="retentionForm"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveEvent();
                }}
              >
                <h3>{editingEvent ? "Edit manual event" : "Log event"}</h3>
                <label>
                  Metric
                  <select
                    disabled={editingEvent !== null}
                    value={selectedDefinition}
                    onChange={(event) => setSelectedDefinition(event.target.value)}
                  >
                    {definitions
                      .filter((item) => item.status === "active")
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} ({item.canonicalUnit})
                        </option>
                      ))}
                  </select>
                </label>
                <div className="inlineFields">
                  <label>
                    Exact value
                    <input
                      inputMode="decimal"
                      maxLength={160}
                      value={eventValue}
                      onChange={(event) => setEventValue(event.target.value)}
                    />
                  </label>
                  <label>
                    Local date
                    <input
                      type="date"
                      value={eventDate}
                      onChange={(event) => setEventDate(event.target.value)}
                    />
                  </label>
                  <label>
                    Local time
                    <input
                      type="time"
                      value={eventTime}
                      onChange={(event) => setEventTime(event.target.value)}
                    />
                  </label>
                </div>
                <small>
                  Interpreted in {session?.profile.timeZone ?? "your profile time zone"}. If date
                  and time are untouched, the original seconds and milliseconds are preserved.
                </small>
                <div className="entryActions">
                  <button disabled={busy === "event"} type="submit">
                    {editingEvent ? "Save event" : "Log event"}
                  </button>
                  {editingEvent ? (
                    <button onClick={() => setEditingEvent(null)} type="button">
                      Cancel
                    </button>
                  ) : null}
                </div>
              </form>
            </div>
            <div>
              <ul className="recordList">
                {events.map((event) => {
                  const definition = definitions.find((item) => item.id === event.definitionId);
                  return (
                    <li key={event.id}>
                      <div>
                        <strong>
                          {event.value} {definition?.canonicalUnit ?? ""} ·{" "}
                          {definition?.name ?? "Metric"}
                        </strong>
                        <small>
                          {new Date(event.measuredAt).toLocaleString()} · {event.source.kind}
                        </small>
                      </div>
                      {event.source.kind === "manual" ? (
                        <div className="entryActions">
                          <button
                            onClick={() => {
                              setEditingEvent(event);
                              setSelectedDefinition(event.definitionId);
                              setEventValue(event.value);
                              setEventDate(event.localDate);
                              setEventTime(
                                localTimeInTimeZone(
                                  new Date(event.measuredAt),
                                  event.timeZone,
                                ).slice(0, 5),
                              );
                            }}
                            type="button"
                          >
                            Edit
                          </button>
                          <button
                            className="dangerAction"
                            disabled={busy === `event:${event.id}`}
                            onClick={() => void deleteEvent(event)}
                            type="button"
                          >
                            Delete
                          </button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {eventCursor ? (
                <button
                  disabled={busy === "event-more"}
                  onClick={() => void loadMoreEvents()}
                  type="button"
                >
                  Load older biometric events
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <section className="retentionSection" aria-labelledby="reminders-heading">
          <div className="sectionHeading">
            <div>
              <p className="kicker">Explicit notification consent</p>
              <h2 id="reminders-heading">Reminders</h2>
            </div>
            <p>
              The lock screen always says “Nutrition Tracker” and “Time to check in.” The web stores
              consent and schedule only; delivery starts after a signed mobile app syncs it to that
              device.
            </p>
          </div>
          <div className="retentionColumns">
            <form
              className="retentionForm"
              onSubmit={(event) => {
                event.preventDefault();
                void saveReminder();
              }}
            >
              <label>
                Private in-app label
                <input
                  maxLength={120}
                  value={reminder.label}
                  onChange={(event) => setReminder({ ...reminder, label: event.target.value })}
                />
              </label>
              <label>
                Local time
                <input
                  type="time"
                  value={reminder.localTime}
                  onChange={(event) => setReminder({ ...reminder, localTime: event.target.value })}
                />
              </label>
              <fieldset>
                <legend>Days</legend>
                <div className="dayChoices">
                  {dayNames.map((name, index) => {
                    const day = index + 1;
                    return (
                      <label key={name}>
                        <input
                          checked={reminder.daysOfWeek.includes(day)}
                          onChange={() =>
                            setReminder({
                              ...reminder,
                              daysOfWeek: reminder.daysOfWeek.includes(day)
                                ? reminder.daysOfWeek.filter((item) => item !== day)
                                : [...reminder.daysOfWeek, day].sort(),
                            })
                          }
                          type="checkbox"
                        />
                        {name}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <label className="consentLine">
                <input required type="checkbox" />I consent to this schedule being synced as generic
                local notifications by a signed mobile app.
              </label>
              <div className="entryActions">
                <button disabled={busy === "reminder"} type="submit">
                  {reminder.id ? "Save reminder" : "Create reminder"}
                </button>
                {reminder.id ? (
                  <button onClick={() => setReminder(reminderDraft())} type="button">
                    Cancel edit
                  </button>
                ) : null}
              </div>
            </form>
            <ul className="recordList">
              {reminders.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.label}</strong>
                    <small>
                      {item.localTime} · {item.timeZone} · {item.status}
                    </small>
                    <small>Lock screen: {item.deliveryPolicy.lockScreenText}</small>
                  </div>
                  <div className="entryActions">
                    <button onClick={() => setReminder(reminderDraft(item))} type="button">
                      Edit
                    </button>
                    {item.status !== "revoked" ? (
                      <>
                        <button
                          disabled={busy === `reminder:${item.id}`}
                          onClick={() =>
                            void changeReminder(item, item.status === "paused" ? "resume" : "pause")
                          }
                          type="button"
                        >
                          {item.status === "paused" ? "Resume" : "Pause"}
                        </button>
                        <button
                          className="dangerAction"
                          onClick={() => void changeReminder(item, "delete")}
                          type="button"
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="retentionSection privacyCenter" aria-labelledby="privacy-heading">
          <div className="sectionHeading">
            <div>
              <p className="kicker">Control and portability</p>
              <h2 id="privacy-heading">Privacy Center</h2>
            </div>
            <p>
              Exports and erasure require your password again. Reauthentication proofs are
              single-use and kept only for the immediate request.
            </p>
          </div>
          <div className="privacyGrid">
            <article>
              <h3>Health integrations</h3>
              {integrations.length === 0 ? (
                <p>
                  No connected health platforms. Connect weight import from the mobile app, where
                  the operating system can show its permission sheet.
                </p>
              ) : (
                <ul className="recordList">
                  {integrations.map((integration) => (
                    <li key={integration.platform}>
                      <div>
                        <strong>
                          {integration.platform === "apple_healthkit"
                            ? "Apple Health"
                            : "Health Connect"}
                        </strong>
                        <small>
                          {integration.status} · scope: {integration.dataTypeCodes.join(", ")}
                        </small>
                        <small>
                          Consent {new Date(integration.consentGrantedAt).toLocaleString()} ·{" "}
                          {integration.consentHistory.length} recorded consent event
                          {integration.consentHistory.length === 1 ? "" : "s"}
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </article>
            <article>
              <h3>Complete data export</h3>
              <p>
                Includes JSON and CSV plus hashes and reconciliation counts. Downloads are
                authenticated, same-origin, and expire.
              </p>
              <label>
                Current password
                <input
                  autoComplete="current-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button
                disabled={busy === "export"}
                onClick={() => void requestExport()}
                type="button"
              >
                Request JSON + CSV export
              </button>
              {exportJob ? (
                <div className="jobStatus">
                  <strong>Status: {exportJob.status}</strong>
                  <button
                    disabled={busy === "export-status"}
                    onClick={() => void refreshExport()}
                    type="button"
                  >
                    Refresh status
                  </button>
                  {exportJob.reconciliation ? (
                    <>
                      <small>
                        Reconciled: {exportJob.reconciliation.reconciled ? "yes" : "no"}
                      </small>
                      <small>
                        {exportJob.reconciliation.entities.length} entity groups checked at{" "}
                        {exportJob.reconciliation.snapshotWatermark}
                      </small>
                    </>
                  ) : null}
                  {exportJob.artifacts.map((artifact) => (
                    <a
                      href={artifact.downloadPath.replace(/^\/v1/u, "/api/retention")}
                      key={artifact.format}
                    >
                      Download {artifact.format.toUpperCase()} ({artifact.byteLength} bytes)
                    </a>
                  ))}
                </div>
              ) : null}
            </article>
            <article className="dangerZone">
              <h3>Erase account</h3>
              <p>
                This permanently revokes account access, deletes private health data, and revokes
                export links after the disclosed processing window. Export first if you need a copy.
                This cannot be undone.
              </p>
              <label className="consentLine">
                <input
                  checked={confirmConsequences}
                  onChange={(event) => setConfirmConsequences(event.target.checked)}
                  type="checkbox"
                />
                I understand account access and export links will be revoked and private health data
                deleted.
              </label>
              <label>
                Current password
                <input
                  autoComplete="current-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button
                className="dangerAction"
                disabled={!confirmConsequences || busy === "erasure"}
                onClick={() => void requestErasure()}
                type="button"
              >
                Request permanent erasure
              </button>
              {erasureJob ? (
                <div className="jobStatus">
                  <strong>Erasure status: {erasureJob.status}</strong>
                  <small>
                    Scheduled no earlier than {new Date(erasureJob.executeAfter).toLocaleString()}
                  </small>
                  <small>
                    Recent authentication:{" "}
                    {erasureJob.recentAuthenticationSatisfied ? "confirmed" : "required"}
                  </small>
                  <small>{erasureJob.consequences.join(" · ")}</small>
                  <button
                    disabled={busy === "erasure-status"}
                    onClick={() => void refreshErasure()}
                    type="button"
                  >
                    Refresh status
                  </button>
                </div>
              ) : null}
            </article>
          </div>
        </section>
      </main>
    </>
  );
}
