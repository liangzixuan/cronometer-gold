"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ActivityCreateBody,
  type ActivityDay,
  type ActivityEntry,
  type ActivityMutationExpectation,
  type ActivityUpdateBody,
  activityDurationFromDraft,
  activityEnergyFromDraft,
  activityEntryAccessibilityLabel,
  assertActivityMutationSemantics,
  canonicalActivityNameFromDraft,
  parseActivityDay,
  parseActivityMutation,
} from "../../lib/activity";
import {
  isLocalDate,
  localDateInTimeZone,
  localDateTimeToInstant,
  localTimeInTimeZone,
  parseSession,
  quoteRevision,
  type SessionSummary,
  shiftLocalDate,
} from "../../lib/diary";
import { confirmBrowserLogout } from "../../lib/private-api";

type LoadState = "loading" | "ready" | "error";

interface ActivityClientProps {
  readonly initialDate?: string;
}

interface ActivityAddDraft {
  readonly name: string;
  readonly duration: string;
  readonly energy: string;
  readonly localTime: string;
}

interface ActivityReuseChoice {
  readonly entry: ActivityEntry;
  readonly day: ActivityDay;
  readonly draft: ActivityAddDraft;
}

interface ActivityEdit {
  readonly entry: ActivityEntry;
  readonly name: string;
  readonly duration: string;
  readonly energy: string;
  readonly localDate: string;
  readonly localTime: string;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseError(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const candidate = (value as Record<string, unknown>).error;
  return typeof candidate === "string" && candidate.length <= 500 ? candidate : fallback;
}

function responseCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>).code;
  return typeof candidate === "string" && candidate.length <= 100 ? candidate : null;
}

function retainedDefaultOccurredAt(
  value: string | undefined,
  localDate: string,
  localTime: string,
  timeZone: string,
): string | null {
  if (!value) return null;
  const captured = new Date(value);
  if (
    !Number.isFinite(captured.getTime()) ||
    localDateInTimeZone(captured, timeZone) !== localDate ||
    localTimeInTimeZone(captured, timeZone).slice(0, 5) !== localTime
  ) {
    return null;
  }
  return captured.toISOString();
}

export function prepareActivityCreate(
  nameDraft: string,
  durationDraft: string,
  energyDraft: string,
  selectedLocalDate: string,
  localTime: string,
  loadedDay: Pick<ActivityDay, "localDate" | "timeZone">,
  untouchedDefaultOccurredAt?: string,
): {
  readonly body: ActivityCreateBody;
  readonly expectedTimeZone: string;
} {
  if (loadedDay.localDate !== selectedLocalDate) {
    throw new TypeError("Load the selected activity day before adding an entry.");
  }
  const retainedOccurredAt = retainedDefaultOccurredAt(
    untouchedDefaultOccurredAt,
    selectedLocalDate,
    localTime,
    loadedDay.timeZone,
  );
  return {
    body: {
      name: canonicalActivityNameFromDraft(nameDraft),
      durationMinutes: activityDurationFromDraft(durationDraft),
      selfReportedEnergyKilocalories: activityEnergyFromDraft(energyDraft),
      occurredAt:
        retainedOccurredAt ??
        localDateTimeToInstant(selectedLocalDate, localTime, loadedDay.timeZone),
    },
    expectedTimeZone: loadedDay.timeZone,
  };
}

export function activityUpdateBody(nameDraft: string, durationDraft: string, energyDraft: string) {
  return {
    name: canonicalActivityNameFromDraft(nameDraft),
    durationMinutes: activityDurationFromDraft(durationDraft),
    selfReportedEnergyKilocalories: activityEnergyFromDraft(energyDraft),
  };
}

export function prepareActivityUpdate(
  nameDraft: string,
  durationDraft: string,
  energyDraft: string,
  selectedLocalDate: string,
  localTime: string,
  entry: ActivityEntry,
  loadedDay: Pick<ActivityDay, "localDate" | "timeZone">,
): { readonly body: ActivityUpdateBody; readonly expectedTimeZone?: string } {
  if (loadedDay.localDate !== entry.localDate) {
    throw new TypeError("Reload the activity entry before editing it.");
  }
  if (!isLocalDate(selectedLocalDate)) throw new TypeError("Choose a valid activity date.");
  const fields = activityUpdateBody(nameDraft, durationDraft, energyDraft);
  const timeChanged =
    selectedLocalDate !== entry.localDate || localTime !== entry.localTime.slice(0, 5);
  const body: ActivityUpdateBody = {
    ...(fields.name === entry.name ? {} : { name: fields.name }),
    ...(fields.durationMinutes === entry.durationMinutes
      ? {}
      : { durationMinutes: fields.durationMinutes }),
    ...(fields.selfReportedEnergyKilocalories === entry.selfReportedEnergyKilocalories
      ? {}
      : { selfReportedEnergyKilocalories: fields.selfReportedEnergyKilocalories }),
    ...(timeChanged
      ? { occurredAt: localDateTimeToInstant(selectedLocalDate, localTime, loadedDay.timeZone) }
      : {}),
  };
  if (Object.keys(body).length === 0) throw new RangeError("Change at least one activity field.");
  return timeChanged ? { body, expectedTimeZone: loadedDay.timeZone } : { body };
}

function dayMessage(day: ActivityDay): string {
  if (day.entries.length === 0) return "No activity entries for this local day.";
  return `${day.entries.length} ${day.entries.length === 1 ? "activity" : "activities"}; ${day.totalDurationMinutes.toLocaleString("en-US")} total minutes.`;
}

export function ActivityClient({ initialDate }: ActivityClientProps) {
  const router = useRouter();
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [date, setDate] = useState("");
  const [day, setDay] = useState<ActivityDay | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("Opening your private activity log…");
  const [messageIsError, setMessageIsError] = useState(false);
  const [draft, setDraftState] = useState<ActivityAddDraft>({
    name: "",
    duration: "",
    energy: "",
    localTime: "",
  });
  const { name, duration, energy, localTime } = draft;
  const [edit, setEditState] = useState<ActivityEdit | null>(null);
  const [reuseChoice, setReuseChoice] = useState<ActivityReuseChoice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(false);
  const privateClosed = useRef(false);
  const ownerRef = useRef<string | null>(null);
  const draftOwnerRef = useRef<string | null>(null);
  const dateRef = useRef("");
  const dayRef = useRef(day);
  dayRef.current = day;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editRef = useRef(edit);
  editRef.current = edit;
  const reuseChoiceRef = useRef(reuseChoice);
  const scopeGeneration = useRef(0);
  const controlGeneration = useRef(0);
  const createIntentGeneration = useRef(0);
  const draftEditGeneration = useRef(0);
  const mutationGeneration = useRef(0);
  const inFlight = useRef(false);
  const mutationController = useRef<AbortController | null>(null);
  const addNameRef = useRef<HTMLInputElement | null>(null);
  const reuseKeepRef = useRef<HTMLButtonElement | null>(null);
  const routeRef = useRef({ initialDate });
  if (routeRef.current.initialDate !== initialDate) routeRef.current = { initialDate };
  const routeContext = routeRef.current;
  const handledRouteRef = useRef<typeof routeContext | null>(null);
  const operations = useRef(new Map<string, string>());
  const loadController = useRef<AbortController | null>(null);
  const loadGeneration = useRef(0);
  const loadedTimeZone = useRef<string | null>(null);
  const untouchedDefaultOccurredAt = useRef<string | null>(null);

  const invalidateReuse = useCallback(() => {
    controlGeneration.current += 1;
    reuseChoiceRef.current = null;
    setReuseChoice(null);
  }, []);
  const replaceDraft = useCallback(
    (next: ActivityAddDraft, source: "interaction" | "clock" = "interaction") => {
      if (source === "interaction") draftEditGeneration.current += 1;
      invalidateReuse();
      draftRef.current = next;
      setDraftState(next);
    },
    [invalidateReuse],
  );
  const setEdit = useCallback(
    (next: ActivityEdit | null | ((current: ActivityEdit | null) => ActivityEdit | null)) => {
      invalidateReuse();
      const value = typeof next === "function" ? next(editRef.current) : next;
      editRef.current = value;
      setEditState(value);
    },
    [invalidateReuse],
  );

  const signInAgain = useCallback(() => {
    privateClosed.current = true;
    scopeGeneration.current += 1;
    mutationGeneration.current += 1;
    loadGeneration.current += 1;
    ownerRef.current = null;
    draftOwnerRef.current = null;
    dateRef.current = "";
    dayRef.current = null;
    inFlight.current = false;
    loadController.current?.abort();
    mutationController.current?.abort();
    operations.current.clear();
    untouchedDefaultOccurredAt.current = null;
    loadedTimeZone.current = null;
    replaceDraft({ name: "", duration: "", energy: "", localTime: "" });
    setEdit(null);
    setSession(null);
    setDay(null);
    setDate("");
    setBusy(null);
    setState("loading");
    setMessage("Closing your private activity log…");
    router.replace("/login");
    router.refresh();
  }, [replaceDraft, router, setEdit]);

  const loadDay = useCallback(
    async (requestedDate: string, successMessage?: string) => {
      const expectedOwnerUserId = ownerRef.current;
      if (
        !mounted.current ||
        privateClosed.current ||
        !expectedOwnerUserId ||
        requestedDate !== dateRef.current ||
        handledRouteRef.current !== routeRef.current
      )
        return false;
      const scope = scopeGeneration.current;
      const route = routeRef.current;
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      const generation = loadGeneration.current + 1;
      loadGeneration.current = generation;
      const current = () =>
        mounted.current &&
        !privateClosed.current &&
        !controller.signal.aborted &&
        loadGeneration.current === generation &&
        scopeGeneration.current === scope &&
        routeRef.current === route &&
        ownerRef.current === expectedOwnerUserId &&
        dateRef.current === requestedDate;
      invalidateReuse();
      setState("loading");
      setMessageIsError(false);
      setMessage(`Loading activity entries for ${requestedDate}…`);
      try {
        const response = await fetch(`/api/activities?date=${encodeURIComponent(requestedDate)}`, {
          cache: "no-store",
          headers: {
            accept: "application/json",
            "x-expected-owner-user-id": expectedOwnerUserId,
          },
          signal: controller.signal,
        });
        if (!current()) return false;
        if (response.status === 401) {
          signInAgain();
          return false;
        }
        const body = await json(response);
        if (!current()) return false;
        if (response.status === 409 && responseCode(body) === "ACTIVITY_OWNER_CHANGED") {
          signInAgain();
          return false;
        }
        if (!current()) return false;
        if (!response.ok) {
          throw new Error(responseError(body, "Activity entries could not be loaded."));
        }
        const next = parseActivityDay(body);
        if (next.localDate !== requestedDate) {
          throw new TypeError("The activity service returned another local day.");
        }
        if (loadedTimeZone.current !== next.timeZone) {
          const capturedNow = new Date();
          replaceDraft(
            {
              ...draftRef.current,
              localTime: localTimeInTimeZone(capturedNow, next.timeZone).slice(0, 5),
            },
            "clock",
          );
          setEdit(null);
          untouchedDefaultOccurredAt.current = capturedNow.toISOString();
          loadedTimeZone.current = next.timeZone;
        }
        dayRef.current = next;
        setDay(next);
        setState("ready");
        setMessageIsError(false);
        setMessage(successMessage ?? dayMessage(next));
        return true;
      } catch (error) {
        if (!current()) return false;
        dayRef.current = null;
        setDay(null);
        setState("error");
        setMessageIsError(true);
        setMessage(
          error instanceof Error ? error.message : "Activity entries could not be loaded.",
        );
        return false;
      }
    },
    [invalidateReuse, replaceDraft, setEdit, signInAgain],
  );

  useEffect(() => {
    mounted.current = true;
    if (privateClosed.current)
      return () => {
        mounted.current = false;
      };
    const controller = new AbortController();
    const scope = ++scopeGeneration.current;
    const route = routeRef.current;
    handledRouteRef.current = route;
    ownerRef.current = null;
    dayRef.current = null;
    inFlight.current = false;
    invalidateReuse();
    setSession(null);
    setDay(null);
    setEdit(null);
    setBusy(null);
    setState("loading");
    const current = () =>
      mounted.current &&
      !privateClosed.current &&
      !controller.signal.aborted &&
      scopeGeneration.current === scope &&
      routeRef.current === route;
    void (async () => {
      try {
        const response = await fetch("/api/auth/me", {
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!current()) return;
        if (response.status === 401) return signInAgain();
        if (!response.ok) throw new Error("Your session could not be verified.");
        const nextSession = parseSession(await json(response));
        if (!current()) return;
        const today = localDateInTimeZone(new Date(), nextSession.profile.timeZone);
        const nextDate = initialDate && isLocalDate(initialDate) ? initialDate : today;
        if (draftOwnerRef.current && draftOwnerRef.current !== nextSession.user.id) {
          operations.current.clear();
          replaceDraft({ name: "", duration: "", energy: "", localTime: "" });
          untouchedDefaultOccurredAt.current = null;
          loadedTimeZone.current = null;
        }
        ownerRef.current = nextSession.user.id;
        draftOwnerRef.current = nextSession.user.id;
        dateRef.current = nextDate;
        setSession(nextSession);
        setDate(nextDate);
        replaceDraft(
          {
            ...draftRef.current,
            localTime: localTimeInTimeZone(new Date(), nextSession.profile.timeZone).slice(0, 5),
          },
          "clock",
        );
      } catch (error) {
        if (!current()) return;
        setState("error");
        setMessageIsError(true);
        setMessage(error instanceof Error ? error.message : "Your session could not be verified.");
      }
    })();
    return () => {
      mounted.current = false;
      scopeGeneration.current += 1;
      mutationGeneration.current += 1;
      loadGeneration.current += 1;
      controlGeneration.current += 1;
      reuseChoiceRef.current = null;
      controller.abort();
      loadController.current?.abort();
      mutationController.current?.abort();
      inFlight.current = false;
    };
  }, [initialDate, invalidateReuse, replaceDraft, setEdit, signInAgain]);

  useEffect(() => {
    if (session && date) void loadDay(date);
    return () => loadController.current?.abort();
  }, [date, loadDay, session]);

  const renderedScope = scopeGeneration.current;
  const renderedControl = controlGeneration.current;
  const renderedLoad = loadGeneration.current;
  function canUseControls() {
    return (
      mounted.current &&
      !privateClosed.current &&
      !inFlight.current &&
      routeRef.current === routeContext &&
      handledRouteRef.current === routeContext &&
      scopeGeneration.current === renderedScope &&
      controlGeneration.current === renderedControl &&
      loadGeneration.current === renderedLoad &&
      session !== null &&
      ownerRef.current === session.user.id &&
      dateRef.current === date &&
      state !== "loading"
    );
  }
  function canUseDraft() {
    return (
      canUseControls() &&
      state === "ready" &&
      day !== null &&
      dayRef.current === day &&
      day.localDate === date &&
      draftRef.current === draft
    );
  }
  function changeDraft(field: keyof ActivityAddDraft, value: string) {
    if (!canUseDraft()) return;
    if (field === "localTime") untouchedDefaultOccurredAt.current = null;
    replaceDraft({ ...draftRef.current, [field]: value });
  }
  function selectDate(next: string) {
    if (!canUseControls() || !isLocalDate(next) || next === dateRef.current) return;
    scopeGeneration.current += 1;
    loadGeneration.current += 1;
    loadController.current?.abort();
    dateRef.current = next;
    dayRef.current = null;
    invalidateReuse();
    setEdit(null);
    setDay(null);
    setState("loading");
    setDate(next);
  }
  function beginEdit(entry: ActivityEntry) {
    if (!canUseControls() || !day || dayRef.current !== day || !day.entries.includes(entry)) return;
    setEdit({
      entry,
      name: entry.name,
      duration: String(entry.durationMinutes),
      energy: entry.selfReportedEnergyKilocalories ?? "",
      localDate: entry.localDate,
      localTime: entry.localTime.slice(0, 5),
    });
  }
  function changeEdit(field: keyof Omit<ActivityEdit, "entry">, value: string) {
    if (!canUseControls() || !edit || editRef.current !== edit) return;
    setEdit({ ...edit, [field]: value });
  }
  function installReuse(entry: ActivityEntry) {
    createIntentGeneration.current += 1;
    replaceDraft({
      ...draftRef.current,
      name: entry.name,
      duration: String(entry.durationMinutes),
      energy: entry.selfReportedEnergyKilocalories ?? "",
    });
    setMessageIsError(false);
    setMessage(
      `Details from ${entry.name} are ready to review. The selected date and time are unchanged; choose Add entry to save a new activity.`,
    );
    addNameRef.current?.focus();
  }
  function reuseEntry(entry: ActivityEntry) {
    if (!canUseDraft() || editRef.current || !day?.entries.includes(entry)) return;
    if (draft.name.length > 0 || draft.duration.length > 0 || draft.energy.length > 0) {
      invalidateReuse();
      const choice = { entry, day, draft };
      reuseChoiceRef.current = choice;
      setReuseChoice(choice);
    } else installReuse(entry);
  }
  function resolveReuse(choice: ActivityReuseChoice, replace: boolean) {
    if (
      !canUseDraft() ||
      editRef.current ||
      reuseChoiceRef.current !== choice ||
      day !== choice.day ||
      draftRef.current !== choice.draft ||
      !day.entries.includes(choice.entry)
    )
      return;
    if (replace) installReuse(choice.entry);
    else invalidateReuse();
  }

  function operationId(key: string): string {
    const existing = operations.current.get(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    operations.current.set(key, created);
    return created;
  }

  async function mutate(input: {
    readonly intentKey: string;
    readonly path: string;
    readonly method: "DELETE" | "PATCH" | "POST";
    readonly body?: unknown;
    readonly revision?: string;
    readonly expectedTimeZone?: string;
    readonly expectedOwnerUserId: string;
    readonly expectation: ActivityMutationExpectation;
    readonly successMessage: string;
  }): Promise<boolean> {
    if (
      !mounted.current ||
      privateClosed.current ||
      inFlight.current ||
      ownerRef.current !== input.expectedOwnerUserId
    )
      return false;
    inFlight.current = true;
    const generation = ++mutationGeneration.current;
    const scope = scopeGeneration.current;
    const sourceDate = dateRef.current;
    const route = routeRef.current;
    const controller = new AbortController();
    mutationController.current = controller;
    const current = () =>
      mounted.current &&
      !privateClosed.current &&
      !controller.signal.aborted &&
      mutationGeneration.current === generation &&
      scopeGeneration.current === scope &&
      ownerRef.current === input.expectedOwnerUserId &&
      dateRef.current === sourceDate &&
      routeRef.current === route;
    invalidateReuse();
    setBusy(input.intentKey);
    setMessageIsError(false);
    setMessage("Saving the activity entry…");
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        "idempotency-key": operationId(input.intentKey),
        "x-expected-owner-user-id": input.expectedOwnerUserId,
      };
      if (input.body !== undefined) headers["content-type"] = "application/json";
      if (input.revision) headers["if-match"] = quoteRevision(input.revision);
      if (input.expectedTimeZone) {
        headers["x-expected-profile-time-zone"] = input.expectedTimeZone;
      }
      const response = await fetch(input.path, {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!current()) return false;
      if (response.status === 401) {
        signInAgain();
        return false;
      }
      const body = await json(response);
      if (!current()) return false;
      if (response.status === 409 && responseCode(body) === "ACTIVITY_OWNER_CHANGED") {
        operations.current.delete(input.intentKey);
        signInAgain();
        return false;
      }
      if (response.status === 409 && responseCode(body) === "ACTIVITY_TIME_ZONE_CHANGED") {
        operations.current.delete(input.intentKey);
        const refreshed = await loadDay(sourceDate);
        if (!current()) return false;
        setMessageIsError(true);
        setMessage(
          refreshed
            ? "Your profile time zone changed. No activity was saved. Fresh entries were loaded; review the local date and time before saving again."
            : "Your profile time zone changed and no activity was saved. Refresh this page, then review the local date and time before saving again.",
        );
        return false;
      }
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          operations.current.delete(input.intentKey);
          const staleView = response.status === 404 || response.status === 412;
          if (staleView) {
            setEdit(null);
            await loadDay(sourceDate);
            if (!current()) return false;
          }
          setMessageIsError(true);
          setMessage(
            staleView
              ? "The activity changed elsewhere and was not saved. Fresh entries were loaded; review before saving again."
              : `${responseError(body, "The activity entry was not changed.")} Review the entry before submitting again.`,
          );
          return false;
        }
        throw new Error(responseError(body, "The activity entry could not be changed."));
      }
      const mutation = parseActivityMutation(body);
      assertActivityMutationSemantics(mutation, input.expectation);
      operations.current.delete(input.intentKey);
      const refreshed = await loadDay(sourceDate, input.successMessage);
      if (!current()) return false;
      if (!refreshed) {
        setState("error");
        setMessageIsError(true);
        setMessage(
          "The entry change was accepted, but the exact local-day view could not be refreshed. Retry the day view; do not submit the change again.",
        );
      }
      return true;
    } catch (error) {
      if (!current()) return false;
      setState("error");
      setMessageIsError(true);
      setMessage(
        `${error instanceof Error ? error.message : "The activity entry could not be changed."} Retry to safely reuse the same operation.`,
      );
      return false;
    } finally {
      if (mutationGeneration.current === generation && mutationController.current === controller) {
        inFlight.current = false;
        mutationController.current = null;
        if (current()) setBusy(null);
      }
    }
  }

  async function createEntry() {
    if (!canUseDraft() || !session || !day) return;
    const capturedDraftEdit = draftEditGeneration.current;
    const capturedIntent = createIntentGeneration.current;
    const scope = scopeGeneration.current;
    try {
      const prepared = prepareActivityCreate(
        name,
        duration,
        energy,
        date,
        localTime,
        day,
        untouchedDefaultOccurredAt.current ?? undefined,
      );
      const initiatingOwnerUserId = session.user.id;
      const intentKey = `create:${capturedIntent}:${initiatingOwnerUserId}:${prepared.expectedTimeZone}:${JSON.stringify(prepared.body)}`;
      if (
        await mutate({
          intentKey,
          path: "/api/activities/entries?profileTimeZonePrecondition=v1",
          method: "POST",
          body: prepared.body,
          expectedOwnerUserId: initiatingOwnerUserId,
          expectedTimeZone: prepared.expectedTimeZone,
          expectation: { kind: "create", sourceLocalDate: date, request: prepared.body },
          successMessage: `${prepared.body.name} added and the activity history refreshed.`,
        })
      ) {
        if (
          mounted.current &&
          !privateClosed.current &&
          routeRef.current === routeContext &&
          scopeGeneration.current === scope &&
          draftEditGeneration.current === capturedDraftEdit &&
          createIntentGeneration.current === capturedIntent
        ) {
          replaceDraft({ ...draftRef.current, name: "", duration: "", energy: "" });
        }
      }
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Enter a valid activity entry.");
    }
  }

  async function updateEntry() {
    if (
      !canUseControls() ||
      !session ||
      !edit ||
      editRef.current !== edit ||
      !day ||
      dayRef.current !== day
    )
      return;
    try {
      const prepared = prepareActivityUpdate(
        edit.name,
        edit.duration,
        edit.energy,
        edit.localDate,
        edit.localTime,
        edit.entry,
        day,
      );
      const initiatingOwnerUserId = session.user.id;
      const intentKey = `update:${initiatingOwnerUserId}:${edit.entry.id}:${edit.entry.revision}:${prepared.expectedTimeZone ?? "no-zone-guard"}:${JSON.stringify(prepared.body)}`;
      if (
        await mutate({
          intentKey,
          path: `/api/activities/entries/${encodeURIComponent(edit.entry.id)}${prepared.expectedTimeZone ? "?profileTimeZonePrecondition=v1" : ""}`,
          method: "PATCH",
          body: prepared.body,
          expectedOwnerUserId: initiatingOwnerUserId,
          revision: edit.entry.revision,
          ...(prepared.expectedTimeZone ? { expectedTimeZone: prepared.expectedTimeZone } : {}),
          expectation: {
            kind: "update",
            entryId: edit.entry.id,
            sourceLocalDate: edit.entry.localDate,
            request: prepared.body,
          },
          successMessage:
            edit.localDate === edit.entry.localDate
              ? "Activity updated and the day history refreshed."
              : `Activity moved to ${edit.localDate}; this source day was refreshed.`,
        })
      ) {
        if (editRef.current === edit) setEdit(null);
      }
    } catch (error) {
      setMessageIsError(true);
      setMessage(error instanceof Error ? error.message : "Enter valid activity details.");
    }
  }

  async function deleteEntry(entry: ActivityEntry) {
    if (
      !canUseControls() ||
      !session ||
      !day ||
      dayRef.current !== day ||
      !day.entries.includes(entry)
    )
      return;
    if (!window.confirm(`Delete ${entry.name} from this activity history?`)) return;
    const initiatingOwnerUserId = session.user.id;
    const intentKey = `delete:${initiatingOwnerUserId}:${entry.id}:${entry.revision}`;
    if (
      await mutate({
        intentKey,
        path: `/api/activities/entries/${encodeURIComponent(entry.id)}`,
        method: "DELETE",
        expectedOwnerUserId: initiatingOwnerUserId,
        revision: entry.revision,
        expectation: { kind: "delete", entryId: entry.id, sourceLocalDate: entry.localDate },
        successMessage: "Activity deleted and the day history refreshed.",
      })
    ) {
      setEdit((current) => (current?.entry.id === entry.id ? null : current));
    }
  }

  async function signOut() {
    if (!canUseControls()) return;
    inFlight.current = true;
    const generation = ++mutationGeneration.current;
    const scope = scopeGeneration.current;
    const owner = ownerRef.current;
    invalidateReuse();
    setBusy("logout");
    const current = () =>
      mounted.current &&
      !privateClosed.current &&
      mutationGeneration.current === generation &&
      scopeGeneration.current === scope &&
      ownerRef.current === owner &&
      routeRef.current === routeContext;
    const confirmed = await confirmBrowserLogout(
      () => fetch("/api/auth/logout", { method: "POST", cache: "no-store" }),
      () => {
        if (current()) signInAgain();
      },
    );
    if (!confirmed && current()) {
      inFlight.current = false;
      setMessage("Sign out could not be confirmed. Your activity log remains open; retry.");
      setState("error");
      setMessageIsError(true);
      setBusy(null);
    }
  }

  useEffect(() => {
    if (
      reuseChoice &&
      reuseChoiceRef.current === reuseChoice &&
      mounted.current &&
      !privateClosed.current &&
      routeRef.current === routeContext &&
      handledRouteRef.current === routeContext
    ) {
      reuseKeepRef.current?.focus();
    }
  }, [reuseChoice, routeContext]);

  const dateQuery = date ? `?date=${encodeURIComponent(date)}` : "";
  const controlsDisabled =
    busy !== null ||
    !session ||
    state === "loading" ||
    !mounted.current ||
    privateClosed.current ||
    handledRouteRef.current !== routeContext;
  const createDisabled =
    controlsDisabled || state !== "ready" || day === null || day.localDate !== date;

  return (
    <>
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          nutrition<span>/ledger</span>
        </Link>
        <nav aria-label="Application navigation">
          <Link href={`/dashboard${dateQuery}`}>Diary</Link>
          <Link href={`/foods${dateQuery}`}>Foods</Link>
          <Link href={`/recipes${dateQuery}`}>Recipes</Link>
          <Link href={`/goals${dateQuery}`}>Goals</Link>
          <Link href={`/hydration${dateQuery}`}>Hydration</Link>
          <Link aria-current="page" href={`/activities${dateQuery}`}>
            Activity
          </Link>
          <Link href={date ? `/reports?to=${encodeURIComponent(date)}` : "/reports"}>Reports</Link>
          <Link href="/health">Health & privacy</Link>
        </nav>
        {session ? <p className="accountIdentity">Signed in as {session.user.email}</p> : null}
        <button
          className="signOutButton"
          disabled={busy !== null}
          onClick={() => void signOut()}
          type="button"
        >
          Sign out
        </button>
      </aside>

      <section className="dashboard activityDashboard" aria-busy={state === "loading"}>
        <header className="dashboardHeader diaryHeader">
          <div>
            <p className="kicker">Private local-day activity log</p>
            <h1>Activity</h1>
          </div>
          <span className="statusPill">
            {day?.timeZone ?? session?.profile.timeZone ?? "Local time"}
          </span>
        </header>

        <fieldset className="dateNavigator">
          <legend className="srOnly">Activity date</legend>
          <button
            aria-label="Previous day"
            disabled={!date || controlsDisabled}
            onClick={() => selectDate(shiftLocalDate(date, -1))}
            type="button"
          >
            ←
          </button>
          <label htmlFor="activity-date">Local date</label>
          <input
            disabled={!date || controlsDisabled}
            id="activity-date"
            onChange={(event) => {
              selectDate(event.target.value);
            }}
            type="date"
            value={date}
          />
          <button
            aria-label="Next day"
            disabled={!date || controlsDisabled}
            onClick={() => selectDate(shiftLocalDate(date, 1))}
            type="button"
          >
            →
          </button>
          <button
            disabled={controlsDisabled}
            onClick={() => {
              const timeZone = day?.timeZone ?? session?.profile.timeZone;
              if (timeZone) selectDate(localDateInTimeZone(new Date(), timeZone));
            }}
            type="button"
          >
            Today
          </button>
        </fieldset>

        <p
          className={`activityStatus activityStatus--${messageIsError ? "error" : state}`}
          role={messageIsError ? "alert" : "status"}
          aria-live="polite"
        >
          {message}
        </p>
        {state === "error" && session && date ? (
          <button
            className="buttonQuiet activityRetry"
            disabled={busy !== null}
            onClick={() => {
              if (canUseControls()) void loadDay(date);
            }}
            type="button"
          >
            Retry day view
          </button>
        ) : null}

        <div className="activityGrid">
          <section className="retentionSection" aria-labelledby="activity-total-heading">
            <p className="kicker">Logged local-day duration</p>
            <h2 id="activity-total-heading" className="activityTotal">
              {day ? `${day.totalDurationMinutes.toLocaleString("en-US")} min` : "—"}
            </h2>
            <p className="finePrint">
              Sum of logged durations for {date || "this day"}. Overlapping activities are each
              counted.
            </p>
          </section>

          <section className="retentionSection" aria-labelledby="activity-add-heading">
            <div className="sectionHeading">
              <div>
                <p className="kicker">New entry</p>
                <h2 id="activity-add-heading">Add activity</h2>
              </div>
            </div>
            {reuseChoice ? (
              <div role="status" aria-live="polite">
                <p>
                  Your Add draft contains details. Keep editing it or replace those fields with
                  saved details from {reuseChoice.entry.name}. The selected date and time stay
                  unchanged.
                </p>
                <div className="entryActions">
                  <button
                    className="buttonQuiet"
                    disabled={createDisabled || edit !== null}
                    onClick={() => resolveReuse(reuseChoice, false)}
                    ref={reuseKeepRef}
                    type="button"
                  >
                    Keep editing
                  </button>
                  <button
                    className="buttonQuiet"
                    disabled={createDisabled || edit !== null}
                    onClick={() => resolveReuse(reuseChoice, true)}
                    type="button"
                  >
                    Replace draft with saved details
                  </button>
                </div>
              </div>
            ) : null}
            <form
              className="workspaceForm activityForm"
              onSubmit={(event) => {
                event.preventDefault();
                void createEntry();
              }}
            >
              <label className="formField">
                <span>Activity name</span>
                <input
                  disabled={createDisabled}
                  maxLength={240}
                  onChange={(event) => changeDraft("name", event.target.value)}
                  placeholder="Trail run"
                  ref={addNameRef}
                  required
                  value={session ? name : ""}
                />
              </label>
              <label className="formField">
                <span>Duration (minutes)</span>
                <input
                  aria-describedby="activity-duration-help"
                  disabled={createDisabled}
                  inputMode="numeric"
                  maxLength={4}
                  onChange={(event) => changeDraft("duration", event.target.value)}
                  placeholder="30"
                  required
                  value={session ? duration : ""}
                />
              </label>
              <small className="fieldHelp" id="activity-duration-help">
                Whole minutes, 1 to 1,440 per entry.
              </small>
              <label className="formField">
                <span>Self-reported calories (optional)</span>
                <input
                  aria-describedby="activity-energy-help"
                  disabled={createDisabled}
                  inputMode="decimal"
                  maxLength={9}
                  onChange={(event) => changeDraft("energy", event.target.value)}
                  placeholder="250"
                  value={session ? energy : ""}
                />
              </label>
              <small className="fieldHelp" id="activity-energy-help">
                Optional calories are your own estimate. They are recorded for history only and do
                not change nutrition goals or remaining calories.
              </small>
              <label className="formField">
                <span>Local time</span>
                <input
                  disabled={createDisabled}
                  onChange={(event) => {
                    changeDraft("localTime", event.target.value);
                  }}
                  required
                  type="time"
                  value={session ? localTime : ""}
                />
              </label>
              <button className="buttonPrimary" disabled={createDisabled} type="submit">
                {busy?.startsWith("create:") ? "Adding…" : "Add entry"}
              </button>
            </form>
          </section>
        </div>

        <section
          className="retentionSection activityEntries"
          aria-labelledby="activity-entries-heading"
        >
          <div className="sectionHeading">
            <div>
              <p className="kicker">Bounded day log</p>
              <h2 id="activity-entries-heading">Entries</h2>
            </div>
            <p>{day ? `${day.entries.length} of 64 maximum` : "Up to 64 per local day"}</p>
          </div>
          {day?.entries.length ? (
            <ul className="recordList">
              {day.entries.map((entry) => (
                <li key={entry.id} aria-label={activityEntryAccessibilityLabel(entry)}>
                  {edit?.entry.id === entry.id ? (
                    <form
                      className="activityEditor"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void updateEntry();
                      }}
                    >
                      <label className="formField">
                        <span>Activity name</span>
                        <input
                          disabled={controlsDisabled}
                          maxLength={240}
                          onChange={(event) => changeEdit("name", event.target.value)}
                          required
                          value={edit.name}
                        />
                      </label>
                      <label className="formField">
                        <span>Duration (minutes)</span>
                        <input
                          disabled={controlsDisabled}
                          inputMode="numeric"
                          maxLength={4}
                          onChange={(event) => changeEdit("duration", event.target.value)}
                          required
                          value={edit.duration}
                        />
                      </label>
                      <label className="formField">
                        <span>Self-reported calories (optional)</span>
                        <input
                          aria-describedby={`activity-edit-energy-help-${entry.id}`}
                          disabled={controlsDisabled}
                          inputMode="decimal"
                          maxLength={9}
                          onChange={(event) => changeEdit("energy", event.target.value)}
                          value={edit.energy}
                        />
                      </label>
                      <small className="fieldHelp" id={`activity-edit-energy-help-${entry.id}`}>
                        History only; this does not change goals or remaining calories.
                      </small>
                      <label className="formField">
                        <span>Local date</span>
                        <input
                          disabled={controlsDisabled}
                          onChange={(event) => changeEdit("localDate", event.target.value)}
                          required
                          type="date"
                          value={edit.localDate}
                        />
                      </label>
                      <label className="formField">
                        <span>Local time</span>
                        <input
                          disabled={controlsDisabled}
                          onChange={(event) => changeEdit("localTime", event.target.value)}
                          required
                          type="time"
                          value={edit.localTime}
                        />
                      </label>
                      <small className="fieldHelp">
                        Moving an entry uses the profile time zone shown at the top of this page.
                      </small>
                      <div className="entryActions">
                        <button className="buttonPrimary" disabled={controlsDisabled} type="submit">
                          Save activity
                        </button>
                        <button
                          className="buttonQuiet"
                          disabled={controlsDisabled}
                          onClick={() => {
                            if (canUseControls() && editRef.current === edit) setEdit(null);
                          }}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div>
                        <strong>{entry.name}</strong>
                        <small>
                          {entry.durationMinutes.toLocaleString("en-US")} min ·{" "}
                          {entry.selfReportedEnergyKilocalories
                            ? `${entry.selfReportedEnergyKilocalories} kcal (self-reported) · `
                            : "No calorie estimate · "}
                          <time dateTime={entry.occurredAt}>{entry.localTime.slice(0, 5)}</time> ·{" "}
                          {entry.timeZone}
                        </small>
                      </div>
                      <div className="entryActions">
                        <button
                          aria-label={`Reuse details from ${entry.name}`}
                          className="buttonQuiet"
                          disabled={createDisabled || edit !== null}
                          onClick={() => reuseEntry(entry)}
                          type="button"
                        >
                          Reuse details
                        </button>
                        <button
                          className="buttonQuiet"
                          disabled={controlsDisabled}
                          onClick={() => beginEdit(entry)}
                          type="button"
                        >
                          Edit activity
                        </button>
                        <button
                          className="buttonDanger"
                          disabled={controlsDisabled}
                          onClick={() => void deleteEntry(entry)}
                          type="button"
                        >
                          Delete {entry.name}
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : state === "ready" ? (
            <p className="activityEmpty">No activity entries for this local day.</p>
          ) : null}
        </section>
      </section>
    </>
  );
}
