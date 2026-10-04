"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createOperationId,
  isLocalDate,
  localDateInTimeZone,
  parseProfileResponse,
  parseSession,
  quoteRevision,
  type SessionSummary,
} from "../../lib/diary";
import { formatNutrientAmount } from "../../lib/nutrition-display";
import {
  type GoalProgressView,
  type GoalView,
  goalWriteBody,
  isGoalDecimal,
  isRecipePositiveDecimal,
  isSignedGoalDecimal,
  nutrientProgressPresentation,
  parseCurrentGoal,
  parseGoalMutation,
  parseGoalProgress,
  parseTargetableNutrients,
  prepareStableMutation,
  type StableMutation,
  type TargetableNutrient,
} from "../../lib/recipes-goals";
import {
  appliedReferenceMatchesGoal,
  appliedReferenceSetForDisplay,
  carriedReferenceSet,
  parseReferenceTargetSets,
  type ReferenceTargetSelection,
  type ReferenceTargetSet,
  type ReferenceTargetSetList,
  referenceAvailabilityMessage,
  referenceTargetSectionVisible,
  referenceTargetSelection,
  referenceTargetsForDraft,
} from "../../lib/reference-targets";
import { AppNavigation } from "../ui/AppNavigation";
import { Icon } from "../ui/Icon";

interface TargetDraft {
  readonly definition: TargetableNutrient;
  readonly minimumAmount: string;
  readonly targetAmount: string;
  readonly maximumAmount: string;
  readonly sourceLabel: string;
  readonly sourceVersion: string;
  readonly rationale: string;
}

interface GoalBuilder {
  readonly goalId: string | null;
  readonly revision: string | null;
  readonly effectiveFrom: string;
  readonly energyMode: "derived" | "fixed";
  readonly fixedKcal: string;
  readonly activityLevelCode: "" | "sedentary_or_light" | "active_or_moderate" | "vigorous";
  readonly activityFactor: string;
  readonly palAcknowledged: boolean;
  readonly adjustmentKcal: string;
  readonly rationale: string;
  readonly targets: readonly TargetDraft[];
  readonly reference: {
    readonly selection: ReferenceTargetSelection;
    readonly expectedProfileRevision: string;
    readonly policyDigest: string;
  } | null;
}

interface SavedGoalCopySource {
  readonly goal: GoalView;
  readonly session: SessionSummary;
  readonly route: { readonly requestedDate: string | null };
  readonly progressDate: string;
  readonly scope: string | null;
  readonly readGeneration: number;
}

interface GoalDraftChoice {
  readonly action: "copy" | "new" | "date" | "reload";
  readonly source: SavedGoalCopySource | null;
  readonly builder: GoalBuilder;
  readonly session: SessionSummary;
  readonly route: SavedGoalCopySource["route"];
  readonly readGeneration: number;
  readonly actionGeneration: number;
  readonly date: string;
  readonly targetDate: string;
}

interface GoalConflict {
  readonly kind: "revision" | "eligibility";
}

export function emptyGoal(date: string): GoalBuilder {
  return {
    goalId: null,
    revision: null,
    effectiveFrom: date,
    energyMode: "fixed",
    fixedKcal: "",
    activityLevelCode: "",
    activityFactor: "",
    palAcknowledged: false,
    adjustmentKcal: "0",
    rationale: "",
    targets: [],
    reference: null,
  };
}

export function goalBuilderFromGoal(goal: GoalView): GoalBuilder {
  return {
    goalId: goal.id,
    revision: goal.revision,
    effectiveFrom: goal.effectiveFrom,
    energyMode: goal.energy.mode,
    fixedKcal: goal.energy.targetKcal,
    activityLevelCode:
      goal.energy.mode === "derived"
        ? (goal.energy.activityLevelCode as GoalBuilder["activityLevelCode"])
        : "",
    activityFactor: goal.energy.mode === "derived" ? goal.energy.activityFactor : "",
    palAcknowledged: goal.energy.mode === "derived",
    adjustmentKcal: goal.energy.mode === "derived" ? goal.energy.adjustmentKcal : "0",
    rationale: goal.energy.rationale,
    targets: goal.targets.map((target) => ({
      definition: target,
      minimumAmount: target.minimumAmount ?? "",
      targetAmount: target.targetAmount ?? "",
      maximumAmount: target.maximumAmount ?? "",
      sourceLabel: target.targetSource,
      sourceVersion: target.targetSourceVersion ?? "",
      rationale: target.rationale ?? "",
    })),
    reference: null,
  };
}

export function goalBuilderIsHistorical(
  goal: GoalView | null,
  builder: Pick<GoalBuilder, "goalId">,
): boolean {
  return builder.goalId !== null && goal?.id === builder.goalId && goal.effectiveTo !== null;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const candidate = (value as Record<string, unknown>).error;
  return typeof candidate === "string" && candidate.length <= 500 ? candidate : fallback;
}

function responseCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>).code;
  return typeof candidate === "string" ? candidate : null;
}

function palRange(code: Exclude<GoalBuilder["activityLevelCode"], "">): readonly [number, number] {
  if (code === "sedentary_or_light") return [1.4, 1.69];
  if (code === "active_or_moderate") return [1.7, 1.99];
  return [2, 2.4];
}

export function goalBody(builder: GoalBuilder, expectedOwnerUserId?: string) {
  if (!isLocalDate(builder.effectiveFrom))
    throw new RangeError("Effective date must be a real YYYY-MM-DD local date.");
  const rationale = builder.rationale;
  if (!rationale.normalize("NFKC").trim() || rationale.length > 1_000)
    throw new RangeError("Explain why you selected this energy target.");
  const energy =
    builder.energyMode === "fixed"
      ? (() => {
          if (!isRecipePositiveDecimal(builder.fixedKcal))
            throw new RangeError("Fixed energy must be a positive calorie amount.");
          return { mode: "fixed" as const, targetKcal: builder.fixedKcal, rationale };
        })()
      : (() => {
          if (
            !builder.palAcknowledged ||
            !builder.activityLevelCode ||
            !isRecipePositiveDecimal(builder.activityFactor) ||
            !isSignedGoalDecimal(builder.adjustmentKcal)
          )
            throw new RangeError("Choose and acknowledge a reviewed PAL category and factor.");
          const [minimum, maximum] = palRange(builder.activityLevelCode);
          const factor = Number(builder.activityFactor);
          if (factor < minimum || factor > maximum)
            throw new RangeError("The PAL factor is outside the selected reviewed category.");
          return {
            mode: "derived" as const,
            activityLevelCode: builder.activityLevelCode,
            activityFactor: builder.activityFactor,
            adjustmentKcal: builder.adjustmentKcal,
            rationale,
          };
        })();
  if (builder.targets.length > 256)
    throw new RangeError("A goal supports at most 256 nutrient targets.");
  if (builder.reference !== null) {
    if (!expectedOwnerUserId) {
      throw new RangeError("Refresh this account before publishing a source-verified candidate.");
    }
    const base = goalWriteBody(builder.goalId, builder.effectiveFrom, energy, [] as const);
    return {
      ...base,
      expectedOwnerUserId,
      expectedProfileRevision: builder.reference.expectedProfileRevision,
      referenceTargetSet: builder.reference.selection,
    };
  }
  const nutrientTargets = builder.targets.map((target) => {
    const minimumAmount = target.minimumAmount || null;
    const targetAmount = target.targetAmount || null;
    const maximumAmount = target.maximumAmount || null;
    if (
      (minimumAmount !== null && !isGoalDecimal(minimumAmount)) ||
      (targetAmount !== null && !isGoalDecimal(targetAmount)) ||
      (maximumAmount !== null && !isGoalDecimal(maximumAmount)) ||
      (minimumAmount === null && targetAmount === null && maximumAmount === null)
    )
      throw new RangeError(`${target.definition.name} needs at least one valid threshold.`);
    const sourceLabel = target.sourceLabel;
    if (!sourceLabel.normalize("NFKC").trim() || sourceLabel.length > 160)
      throw new RangeError(`${target.definition.name} needs a target source label.`);
    const sourceVersion = target.sourceVersion || null;
    const targetRationale = target.rationale || null;
    if (
      (sourceVersion !== null && sourceVersion.length > 100) ||
      (targetRationale !== null && targetRationale.length > 1_000)
    )
      throw new RangeError(`${target.definition.name} source metadata is too long.`);
    return {
      nutrientId: target.definition.nutrientId,
      minimumAmount,
      targetAmount,
      maximumAmount,
      source: { label: sourceLabel, version: sourceVersion },
      rationale: targetRationale,
    };
  });
  return {
    ...goalWriteBody(builder.goalId, builder.effectiveFrom, energy, nutrientTargets),
    ...(expectedOwnerUserId ? { expectedOwnerUserId } : {}),
  };
}

export function GoalsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedDate = searchParams.get("date");
  const [date, setDate] = useState(
    requestedDate && isLocalDate(requestedDate) ? requestedDate : "",
  );
  const [builder, setBuilderState] = useState<GoalBuilder>(() => emptyGoal(""));
  const builderRef = useRef(builder);
  const baselineRef = useRef(builder);
  const actionGeneration = useRef(0);
  const privateClosed = useRef(false);
  const [dateDraft, setDateDraft] = useState(date);
  const dateDraftRef = useRef(date);
  const dateProposalPending = useRef(false);
  const [conflict, setConflictState] = useState<GoalConflict | null>(null);
  const conflictRef = useRef<GoalConflict | null>(null);
  const setConflict = useCallback((next: GoalConflict | null) => {
    conflictRef.current = next;
    setConflictState(next);
  }, []);
  const [copySource, setCopySourceState] = useState<SavedGoalCopySource | null>(null);
  const copySourceRef = useRef<SavedGoalCopySource | null>(null);
  const [draftChoice, setDraftChoice] = useState<GoalDraftChoice | null>(null);
  const draftChoiceRef = useRef<GoalDraftChoice | null>(null);
  const draftKeepButton = useRef<HTMLButtonElement | null>(null);
  const clearDraftChoice = useCallback(() => {
    draftChoiceRef.current = null;
    setDraftChoice(null);
  }, []);
  useEffect(() => {
    if (draftChoice && draftChoiceRef.current === draftChoice) draftKeepButton.current?.focus();
  }, [draftChoice]);

  const setBuilder = useCallback(
    (change: GoalBuilder | ((current: GoalBuilder) => GoalBuilder)) => {
      const current = builderRef.current;
      const next = typeof change === "function" ? change(current) : change;
      if (next === current) return;
      // Keep local actions aware of raw edits before React paints. Functional
      // changes remain pure; confirmation and ref updates happen outside them.
      builderRef.current = next;
      actionGeneration.current += 1;
      clearDraftChoice();
      setBuilderState(next);
    },
    [clearDraftChoice],
  );
  const setCopySource = useCallback(
    (next: SavedGoalCopySource | null) => {
      copySourceRef.current = next;
      clearDraftChoice();
      setCopySourceState(next);
    },
    [clearDraftChoice],
  );
  const [definitions, setDefinitions] = useState<readonly TargetableNutrient[]>([]);
  const [selectedNutrientId, setSelectedNutrientId] = useState("");
  const [nutrientQuery, setNutrientQuery] = useState("");
  const nutrientQueryRef = useRef("");
  const nutrientSelectionRef = useRef("");
  const pickerGeneration = useRef(0);
  const pickerScope = useRef<string | null>(null);
  const pickerMounted = useRef(false);
  const pickerRoute = useRef({ requestedDate });
  if (pickerRoute.current.requestedDate !== requestedDate) {
    pickerRoute.current = { requestedDate };
  }
  const loadedPickerRoute = useRef<typeof pickerRoute.current | null>(null);
  const pickerDefinitions = useRef<readonly TargetableNutrient[]>([]);
  const [goal, setGoal] = useState<GoalView | null>(null);
  const [progress, setProgress] = useState<GoalProgressView | null>(null);
  const [referenceSets, setReferenceSets] = useState<ReferenceTargetSetList | null>(null);
  const [templatesSupported, setTemplatesSupported] = useState(true);
  const [selectedReferenceGroup, setSelectedReferenceGroup] = useState("");
  const [referenceAcknowledged, setReferenceAcknowledged] = useState(false);
  const [referenceCustomized, setReferenceCustomized] = useState(false);
  const [profileBirthDate, setProfileBirthDate] = useState("");
  const [profileSexAtBirth, setProfileSexAtBirth] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("Loading your versioned goals…");
  const [busy, setBusy] = useState(false);
  const pending = useRef(new Map<string, StableMutation<ReturnType<typeof goalBody>>>());
  const sessionRef = useRef<SessionSummary | null>(null);
  const selectedDateRef = useRef(date);
  const generation = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const authController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const profileController = useRef<AbortController | null>(null);
  const candidateController = useRef<AbortController | null>(null);
  const candidateGeneration = useRef(0);
  const effectiveDateRef = useRef(builder.effectiveFrom);

  const resetNutrientPicker = useCallback(() => {
    pickerGeneration.current += 1;
    nutrientQueryRef.current = "";
    nutrientSelectionRef.current = "";
    setNutrientQuery("");
    setSelectedNutrientId("");
  }, []);

  const installPickerScope = useCallback(
    (ownerSession: SessionSummary, localDate: string) => {
      const nextScope = JSON.stringify([ownerSession.user.id, ownerSession.profile, localDate]);
      if (pickerScope.current !== nextScope) {
        resetNutrientPicker();
        pickerScope.current = nextScope;
      }
    },
    [resetNutrientPicker],
  );

  const signInAgain = useCallback(() => {
    privateClosed.current = true;
    actionGeneration.current += 1;
    setConflict(null);
    setCopySource(null);
    resetNutrientPicker();
    pickerScope.current = null;
    loadedPickerRoute.current = null;
    generation.current += 1;
    loadController.current?.abort();
    authController.current?.abort();
    writeController.current?.abort();
    profileController.current?.abort();
    candidateController.current?.abort();
    pending.current.clear();
    sessionRef.current = null;
    setGoal(null);
    setProgress(null);
    setBuilder(emptyGoal(""));
    setDefinitions([]);
    pickerDefinitions.current = [];
    setProfileBirthDate("");
    setProfileSexAtBirth("");
    setReferenceSets(null);
    router.replace("/login");
    router.refresh();
  }, [router, resetNutrientPicker, setCopySource, setConflict, setBuilder]);

  const load = useCallback(
    async (
      localDate: string,
      ownerSession: SessionSummary,
      mode: "auto" | "replace" | "preserve" = "auto",
    ) => {
      if (privateClosed.current || !pickerMounted.current) return;
      const readBuilder = builderRef.current;
      const replace =
        mode === "replace" ||
        (mode === "auto" && JSON.stringify(readBuilder) === JSON.stringify(baselineRef.current));
      actionGeneration.current += 1;
      setCopySource(null);
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      const requestGeneration = generation.current + 1;
      generation.current = requestGeneration;
      const requestRoute = pickerRoute.current;
      setState("loading");
      const requestIsCurrent = () =>
        pickerMounted.current &&
        !privateClosed.current &&
        pickerRoute.current === requestRoute &&
        loadController.current === controller &&
        !controller.signal.aborted &&
        generation.current === requestGeneration &&
        sessionRef.current === ownerSession;
      try {
        const [currentResponse, progressResponse, nutrientResponse, referenceResponse] =
          await Promise.all([
            fetch(`/api/goals/current?date=${encodeURIComponent(localDate)}`, {
              headers: { accept: "application/json" },
              cache: "no-store",
              signal: controller.signal,
            }),
            fetch(`/api/goals/progress?date=${encodeURIComponent(localDate)}`, {
              headers: { accept: "application/json" },
              cache: "no-store",
              signal: controller.signal,
            }),
            fetch("/api/nutrients/targetable", {
              headers: { accept: "application/json" },
              cache: "no-store",
              signal: controller.signal,
            }),
            fetch(`/api/goals/reference-target-sets?date=${encodeURIComponent(localDate)}`, {
              headers: { accept: "application/json" },
              cache: "no-store",
              signal: controller.signal,
            }),
          ]);
        if (!requestIsCurrent()) return;
        if (
          [currentResponse, progressResponse, nutrientResponse, referenceResponse].some(
            (response) => response.status === 401,
          )
        )
          return signInAgain();
        const [currentBody, progressBody, nutrientBody, referenceBody] = await Promise.all([
          json(currentResponse),
          json(progressResponse),
          json(nutrientResponse),
          json(referenceResponse),
        ]);
        if (!requestIsCurrent()) return;
        if (!currentResponse.ok)
          throw new Error(errorMessage(currentBody, "The current goal could not be loaded."));
        if (!progressResponse.ok)
          throw new Error(errorMessage(progressBody, "Goal progress could not be loaded."));
        if (!nutrientResponse.ok)
          throw new Error(errorMessage(nutrientBody, "Targetable nutrients could not be loaded."));
        const nextGoal = parseCurrentGoal(currentBody);
        const nextProgress = parseGoalProgress(progressBody);
        const nextDefinitions = parseTargetableNutrients(nutrientBody);
        const candidateDate = replace
          ? (nextGoal?.effectiveFrom ?? localDate)
          : readBuilder.effectiveFrom;
        let effectiveReferenceResponse = referenceResponse;
        let effectiveReferenceBody = referenceBody;
        if (
          isLocalDate(candidateDate) &&
          candidateDate !== localDate &&
          referenceResponse.status !== 404
        ) {
          effectiveReferenceResponse = await fetch(
            `/api/goals/reference-target-sets?date=${encodeURIComponent(candidateDate)}`,
            {
              headers: { accept: "application/json" },
              cache: "no-store",
              signal: controller.signal,
            },
          );
          if (!requestIsCurrent()) return;
          if (effectiveReferenceResponse.status === 401) return signInAgain();
          effectiveReferenceBody = await json(effectiveReferenceResponse);
          if (!requestIsCurrent()) return;
        }
        const nextReferenceSets =
          effectiveReferenceResponse.status === 404
            ? null
            : (() => {
                if (!effectiveReferenceResponse.ok) {
                  throw new Error(
                    errorMessage(
                      effectiveReferenceBody,
                      "Source-verified candidate targets could not be loaded.",
                    ),
                  );
                }
                const parsed = parseReferenceTargetSets(effectiveReferenceBody);
                if (parsed.date !== candidateDate) {
                  throw new Error("Candidate targets were returned for the wrong effective date.");
                }
                return parsed;
              })();
        if (
          nextReferenceSets !== null &&
          nextReferenceSets.profileRevision !== ownerSession.profile.revision
        ) {
          throw new Error("Your profile changed while candidate targets were loading. Refresh.");
        }
        if (!requestIsCurrent()) return;
        const replaceEditor = replace && builderRef.current === readBuilder;
        if (replaceEditor) setGoal(nextGoal);
        setProgress(nextProgress);
        selectedDateRef.current = localDate;
        dateProposalPending.current = false;
        dateDraftRef.current = localDate;
        setDate(localDate);
        setDateDraft(localDate);
        installPickerScope(ownerSession, localDate);
        pickerDefinitions.current = nextDefinitions;
        loadedPickerRoute.current = requestRoute;
        setCopySource(
          replaceEditor &&
            nextGoal?.energy.mode === "fixed" &&
            (nextGoal.status === "active" || nextGoal.status === "archived") &&
            nextReferenceSets?.applied === null
            ? {
                goal: nextGoal,
                session: ownerSession,
                route: requestRoute,
                progressDate: localDate,
                scope: pickerScope.current,
                readGeneration: requestGeneration,
              }
            : null,
        );
        setDefinitions(nextDefinitions);
        let nextBuilder = nextGoal ? goalBuilderFromGoal(nextGoal) : emptyGoal(localDate);
        const appliedSet = nextReferenceSets
          ? carriedReferenceSet(nextReferenceSets, nextGoal)
          : null;
        if (nextReferenceSets && appliedSet) {
          nextBuilder = {
            ...nextBuilder,
            targets: referenceTargetsForDraft(appliedSet),
            reference: {
              selection: referenceTargetSelection(nextReferenceSets, appliedSet),
              expectedProfileRevision: nextReferenceSets.profileRevision,
              policyDigest: appliedSet.policyDigest,
            },
          };
        }
        if (replaceEditor) {
          effectiveDateRef.current = nextBuilder.effectiveFrom;
          baselineRef.current = nextBuilder;
          setBuilder(nextBuilder);
          setConflict(null);
          setTemplatesSupported(effectiveReferenceResponse.status !== 404);
          setReferenceSets(nextReferenceSets);
          setSelectedReferenceGroup(appliedSet?.groupCode ?? "");
          setReferenceAcknowledged(false);
          setReferenceCustomized(false);
        } else if (
          builderRef.current === readBuilder &&
          candidateDate === readBuilder.effectiveFrom
        ) {
          setTemplatesSupported(effectiveReferenceResponse.status !== 404);
          setReferenceSets(nextReferenceSets);
          setSelectedReferenceGroup("");
          setReferenceAcknowledged(false);
        }
        setState("ready");
        setMessage(
          !replaceEditor
            ? `Progress refreshed for ${localDate}. Your unsaved goal draft is still here, effective ${builderRef.current.effectiveFrom || "date not chosen"}; its saved view may be out of date.`
            : nextGoal
              ? `Goal version ${nextGoal.versionNumber} applies on ${localDate}.${
                  nextReferenceSets &&
                  appliedReferenceMatchesGoal(nextReferenceSets.applied, nextGoal)
                    ? " Its source-verified candidate provenance was confirmed."
                    : ""
                }`
              : "No active goal applies to this local day. Create one below.",
        );
        return true;
      } catch (caught) {
        if (!requestIsCurrent()) return;
        setState("error");
        setMessage(caught instanceof Error ? caught.message : "Goals could not be loaded.");
      } finally {
        if (loadController.current === controller) loadController.current = null;
      }
    },
    [signInAgain, installPickerScope, setCopySource, setBuilder, setConflict],
  );

  const refreshSessionAndGoals = useCallback(
    async (
      preferredDate?: string,
      expectedOwnerUserId?: string,
      mode: "auto" | "replace" | "preserve" = "auto",
    ) => {
      if (!pickerMounted.current || privateClosed.current) return;
      actionGeneration.current += 1;
      clearDraftChoice();
      const requestRoute = pickerRoute.current;
      const initiatingOwner = expectedOwnerUserId ?? sessionRef.current?.user.id;
      const initiatingBuilder = builderRef.current;
      authController.current?.abort();
      const controller = new AbortController();
      authController.current = controller;
      const requestIsCurrent = () =>
        authController.current === controller &&
        !controller.signal.aborted &&
        pickerMounted.current &&
        !privateClosed.current &&
        pickerRoute.current === requestRoute;
      setState("loading");
      try {
        const response = await fetch("/api/auth/me", {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!requestIsCurrent()) return;
        if (response.status === 401) return signInAgain();
        const body = await json(response);
        if (!response.ok) {
          throw new Error(errorMessage(body, "Your private goal session could not be verified."));
        }
        if (!requestIsCurrent()) return;
        const nextSession = parseSession(body);
        if (initiatingOwner && nextSession.user.id !== initiatingOwner) {
          return signInAgain();
        }
        if (!requestIsCurrent()) return;
        sessionRef.current = nextSession;
        setProfileBirthDate(nextSession.profile.birthDate ?? "");
        setProfileSexAtBirth(nextSession.profile.sexAtBirth ?? "");
        const localDate =
          preferredDate && isLocalDate(preferredDate)
            ? preferredDate
            : localDateInTimeZone(new Date(), nextSession.profile.timeZone);
        installPickerScope(nextSession, localDate);
        return await load(
          localDate,
          nextSession,
          builderRef.current === initiatingBuilder ? mode : "preserve",
        );
      } catch (caught) {
        if (!requestIsCurrent()) return;
        setState("error");
        setMessage(
          caught instanceof Error
            ? caught.message
            : "Your private goal session could not be verified.",
        );
      } finally {
        if (authController.current === controller) authController.current = null;
      }
    },
    [load, signInAgain, installPickerScope, clearDraftChoice],
  );

  useEffect(() => {
    pickerMounted.current = true;
    privateClosed.current = false;
    actionGeneration.current += 1;
    clearDraftChoice();
    void refreshSessionAndGoals(
      requestedDate && isLocalDate(requestedDate) ? requestedDate : undefined,
    );
    return () => {
      pickerMounted.current = false;
      actionGeneration.current += 1;
      draftChoiceRef.current = null;
      pickerGeneration.current += 1;
      authController.current?.abort();
      loadController.current?.abort();
      writeController.current?.abort();
      profileController.current?.abort();
      candidateController.current?.abort();
      generation.current += 1;
    };
  }, [refreshSessionAndGoals, requestedDate, clearDraftChoice]);

  const loadCandidates = useCallback(
    async (effectiveFrom: string, ownerSession: SessionSummary) => {
      if (!isLocalDate(effectiveFrom)) {
        setMessage("Choose a real effective date before loading candidate targets.");
        return;
      }
      actionGeneration.current += 1;
      clearDraftChoice();
      setCandidateBusy(true);
      candidateController.current?.abort();
      const controller = new AbortController();
      candidateController.current = controller;
      const requestGeneration = candidateGeneration.current + 1;
      candidateGeneration.current = requestGeneration;
      const requestRoute = pickerRoute.current;
      const requestIsCurrent = () =>
        candidateController.current === controller &&
        !controller.signal.aborted &&
        candidateGeneration.current === requestGeneration &&
        effectiveDateRef.current === effectiveFrom &&
        pickerMounted.current &&
        !privateClosed.current &&
        pickerRoute.current === requestRoute &&
        sessionRef.current === ownerSession;
      try {
        const response = await fetch(
          `/api/goals/reference-target-sets?date=${encodeURIComponent(effectiveFrom)}`,
          {
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!requestIsCurrent()) return;
        if (response.status === 401) return signInAgain();
        if (response.status === 404) {
          pickerGeneration.current += 1;
          setTemplatesSupported(false);
          setReferenceSets(null);
          setSelectedReferenceGroup("");
          setReferenceAcknowledged(false);
          setReferenceCustomized(false);
          setMessage("Candidate templates are unavailable on this API; manual goals still work.");
          return;
        }
        const body = await json(response);
        if (!requestIsCurrent()) return;
        if (!response.ok) {
          throw new Error(errorMessage(body, "Candidate targets could not be loaded."));
        }
        const parsed = parseReferenceTargetSets(body);
        if (
          parsed.date !== effectiveFrom ||
          parsed.profileRevision !== ownerSession.profile.revision
        ) {
          throw new Error("Your effective date or profile changed while candidates were loading.");
        }
        if (!requestIsCurrent()) return;
        pickerGeneration.current += 1;
        setTemplatesSupported(true);
        setReferenceSets(parsed);
        setSelectedReferenceGroup("");
        setReferenceAcknowledged(false);
        setReferenceCustomized(false);
        setMessage(
          parsed.availability.available
            ? "Source-verified candidate loaded. Review it before applying anything to the draft."
            : referenceAvailabilityMessage(parsed.availability.reasonCodes),
        );
      } catch (caught) {
        if (!requestIsCurrent()) return;
        setMessage(
          caught instanceof Error ? caught.message : "Candidate targets could not be loaded.",
        );
      } finally {
        if (candidateController.current === controller) {
          candidateController.current = null;
          if (pickerMounted.current && !privateClosed.current) setCandidateBusy(false);
        }
      }
    },
    [signInAgain, clearDraftChoice],
  );

  async function saveProfilePrerequisites() {
    const ownerSession = sessionRef.current;
    if (!ownerSession || !canUseGoalControls()) return;
    if (profileBirthDate !== "" && !isLocalDate(profileBirthDate)) {
      setMessage("Birth date must be a real YYYY-MM-DD date.");
      return;
    }
    if (!["female", "male", "intersex", "not_specified"].includes(profileSexAtBirth)) {
      setMessage("Choose a profile sex-at-birth value before saving.");
      return;
    }
    actionGeneration.current += 1;
    clearDraftChoice();
    const ownerUserId = ownerSession.user.id;
    const requestGeneration = generation.current;
    const controller = new AbortController();
    profileController.current?.abort();
    profileController.current = controller;
    const requestIsCurrent = () =>
      profileController.current === controller &&
      !controller.signal.aborted &&
      generation.current === requestGeneration &&
      sessionRef.current?.user.id === ownerUserId;
    setProfileBusy(true);
    setMessage("Saving the profile fields used to check candidate eligibility…");
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "if-match": quoteRevision(ownerSession.profile.revision),
        },
        body: JSON.stringify({
          expectedOwnerUserId: ownerUserId,
          birthDate: profileBirthDate || null,
          sexAtBirth: profileSexAtBirth,
        }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!requestIsCurrent()) return;
      if (response.status === 401) return signInAgain();
      const body = await json(response);
      if (!requestIsCurrent()) return;
      if (response.status === 409 && responseCode(body) === "PROFILE_OWNER_CHANGED") {
        return signInAgain();
      }
      if (response.status === 409 || response.status === 412) {
        setConflict({
          kind: "eligibility",
        });
        const refreshed = await refreshSessionAndGoals(
          selectedDateRef.current,
          ownerUserId,
          "preserve",
        );
        if (
          pickerMounted.current &&
          !privateClosed.current &&
          sessionRef.current?.user.id === ownerUserId
        ) {
          setMessage(
            refreshed
              ? "Your profile changed elsewhere. Fresh eligibility values were loaded and your goal draft is still here. Publishing is paused until you discard and reload saved values or explicitly start a new draft."
              : "Your profile changed elsewhere and eligibility could not be refreshed. Your goal draft is still here. Retry the reload before publishing.",
          );
        }
        return;
      }
      if (!response.ok) {
        throw new Error(errorMessage(body, "The eligibility profile fields could not be saved."));
      }
      const profile = parseProfileResponse(body);
      if (!requestIsCurrent()) return;
      const nextSession = { ...ownerSession, profile };
      sessionRef.current = nextSession;
      installPickerScope(nextSession, selectedDateRef.current);
      setProfileBirthDate(profile.birthDate ?? "");
      setProfileSexAtBirth(profile.sexAtBirth ?? "");
      await loadCandidates(effectiveDateRef.current, nextSession);
    } catch (caught) {
      if (!requestIsCurrent()) return;
      setMessage(
        `${caught instanceof Error ? caught.message : "Profile fields could not be saved."} Review fresh profile values before retrying.`,
      );
    } finally {
      if (profileController.current === controller) {
        profileController.current = null;
        if (pickerMounted.current && !privateClosed.current) setProfileBusy(false);
      }
    }
  }

  function applyReferenceDraft(set: ReferenceTargetSet) {
    const ownerSession = sessionRef.current;
    if (!canUseGoalControls()) return;
    if (!ownerSession || !referenceSets || !referenceAcknowledged) {
      setMessage("Review and accept the exact eligibility acknowledgement before applying.");
      return;
    }
    if (
      referenceSets.date !== builder.effectiveFrom ||
      referenceSets.profileRevision !== ownerSession.profile.revision ||
      set.groupCode !== selectedReferenceGroup
    ) {
      setMessage(
        "The profile, group, or effective date changed. Reload the candidate before applying.",
      );
      return;
    }
    setBuilder({
      ...builder,
      targets: referenceTargetsForDraft(set),
      reference: {
        selection: referenceTargetSelection(referenceSets, set),
        expectedProfileRevision: referenceSets.profileRevision,
        policyDigest: set.policyDigest,
      },
    });
    setReferenceCustomized(false);
    setMessage(
      "Candidate values were copied into a read-only draft. Nothing is saved until you choose Create or Publish below.",
    );
  }

  function customizeReferenceDraft(set?: ReferenceTargetSet) {
    if (!canUseGoalControls()) return;
    const targets = set
      ? referenceTargetsForDraft(set, true)
      : builder.targets.map((target) => ({
          ...target,
          sourceLabel: `User-customized copy of ${target.sourceLabel}`.slice(0, 160),
          rationale: "User-editable copy; verified reference-template identity cleared.",
        }));
    setBuilder({ ...builder, targets, reference: null });
    setReferenceAcknowledged(false);
    setReferenceCustomized(true);
    setMessage(
      "Candidate values were copied into editable custom targets. Verified template provenance was cleared.",
    );
  }

  function changeNutrientQuery(raw: string) {
    if (!canUseNutrientPicker()) return;
    const next = raw.slice(0, 100);
    if (nutrientQueryRef.current === next) return;
    pickerGeneration.current += 1;
    nutrientQueryRef.current = next;
    setNutrientQuery(next);
  }

  function selectNutrient(next: string) {
    if (!canUseNutrientPicker() || !matchingNutrients.some((item) => item.nutrientId === next))
      return;
    if (effectiveNutrientId === next) return;
    pickerGeneration.current += 1;
    nutrientSelectionRef.current = next;
    setSelectedNutrientId(next);
  }

  function addTarget() {
    if (!canUseNutrientPicker()) return;
    const definition = matchingNutrients.find((item) => item.nutrientId === effectiveNutrientId);
    if (!definition || !pickerDefinitions.current.includes(definition)) return;
    setBuilder((current) => {
      if (
        current !== builder ||
        current.reference !== null ||
        current.targets.some((target) => target.definition.nutrientId === definition.nutrientId) ||
        current.targets.length >= 256
      )
        return current;
      return {
        ...current,
        targets: [
          ...current.targets,
          {
            definition,
            minimumAmount: "",
            targetAmount: "",
            maximumAmount: "",
            sourceLabel: "",
            sourceVersion: "",
            rationale: "",
          },
        ],
      };
    });
  }

  function updateTarget(index: number, patch: Partial<TargetDraft>) {
    if (builder.reference) return;
    editBuilder({
      ...builder,
      targets: builder.targets.map((target, candidate) =>
        candidate === index ? { ...target, ...patch } : target,
      ),
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const ownerSession = sessionRef.current;
    if (!ownerSession || !canUseGoalControls() || conflictRef.current?.kind === "eligibility")
      return;
    if (verifiedApplied && builder.reference === null && !referenceCustomized) {
      setMessage(
        "This goal has verified candidate provenance. Choose Customize explicitly before publishing custom rows.",
      );
      return;
    }
    if (
      builder.reference &&
      builder.reference.expectedProfileRevision !== ownerSession.profile.revision
    ) {
      setMessage(
        "Your profile changed. Reload and review the candidate, or customize its values, before publishing this draft.",
      );
      return;
    }
    let body: ReturnType<typeof goalBody>;
    try {
      body = goalBody(builder, templatesSupported ? ownerSession.user.id : undefined);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Review the goal fields.");
      return;
    }
    actionGeneration.current += 1;
    clearDraftChoice();
    const intentKey = `${builder.goalId ?? "create"}:${builder.revision ?? "new"}:${JSON.stringify(body)}`;
    const operation = prepareStableMutation(
      pending.current,
      intentKey,
      () => body,
      createOperationId,
    );
    pending.current.set(intentKey, operation);
    const ownerUserId = ownerSession.user.id;
    const requestGeneration = generation.current;
    const savedDate = date;
    const savedRoute = pickerRoute.current;
    const controller = new AbortController();
    writeController.current = controller;
    const requestIsCurrent = () =>
      writeController.current === controller &&
      !controller.signal.aborted &&
      generation.current === requestGeneration &&
      selectedDateRef.current === savedDate &&
      pickerMounted.current &&
      !privateClosed.current &&
      builderRef.current === builder &&
      sessionRef.current === ownerSession;
    setBusy(true);
    setMessage(
      builder.goalId ? "Publishing a new immutable goal revision…" : "Creating your goal…",
    );
    try {
      const path = builder.goalId
        ? `/api/goals/${encodeURIComponent(builder.goalId)}/revisions`
        : "/api/goals";
      const response = await fetch(path, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": operation.operationId,
          ...(builder.revision ? { "if-match": `"${builder.revision}"` } : {}),
        },
        body: JSON.stringify(operation.body),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!requestIsCurrent()) return;
      if (response.status === 401) return signInAgain();
      const responseBody = await json(response);
      if (!requestIsCurrent()) return;
      if (
        response.status === 409 &&
        ["PROFILE_OWNER_CHANGED", "GOAL_OWNER_CHANGED"].includes(responseCode(responseBody) ?? "")
      ) {
        return signInAgain();
      }
      if (response.status === 409 || response.status === 412) {
        pending.current.delete(intentKey);
        setConflict({
          kind: response.status === 412 ? "revision" : "eligibility",
        });
        let refreshed = true;
        if (response.status === 409) {
          refreshed = Boolean(await refreshSessionAndGoals(savedDate, ownerUserId, "preserve"));
          if (
            !pickerMounted.current ||
            privateClosed.current ||
            sessionRef.current?.user.id !== ownerUserId
          )
            return;
        }
        setMessage(
          response.status === 412
            ? "This saved goal changed elsewhere. Your edits are still here and the saved view may be out of date. Discard edits and reload the saved goal when ready; saving this draft again will still use its original revision."
            : refreshed
              ? "Your goal or eligibility profile changed elsewhere. Your edits are still here. Publishing is paused: discard edits and reload the saved goal, or explicitly start a new draft using the refreshed eligibility values."
              : "Your goal or eligibility profile changed elsewhere and eligibility could not be refreshed. Your edits are still here. Retry the reload before publishing.",
        );
        return;
      }
      if (!response.ok) throw new Error(errorMessage(responseBody, "The goal could not be saved."));
      const mutation = parseGoalMutation(responseBody);
      if (!requestIsCurrent()) return;
      pending.current.delete(intentKey);
      const savedBuilder = goalBuilderFromGoal(mutation.goal);
      setGoal(mutation.goal);
      baselineRef.current = savedBuilder;
      effectiveDateRef.current = savedBuilder.effectiveFrom;
      setBuilder(savedBuilder);
      const refreshed = await load(savedDate, ownerSession, "replace");
      if (
        !pickerMounted.current ||
        privateClosed.current ||
        controller.signal.aborted ||
        writeController.current !== controller ||
        pickerRoute.current !== savedRoute ||
        sessionRef.current !== ownerSession
      )
        return;
      const receiptMessage = mutation.replayed
        ? "The earlier goal save was confirmed safely."
        : `Goal version ${mutation.goal.versionNumber} published.`;
      setMessage(
        refreshed
          ? receiptMessage
          : `${receiptMessage} The saved view could not be refreshed. Retry loading it before making further changes.`,
      );
    } catch (caught) {
      if (!requestIsCurrent()) return;
      setMessage(
        `${caught instanceof Error ? caught.message : "The goal could not be saved."} Choose Save again to retry safely.`,
      );
    } finally {
      if (writeController.current === controller) {
        writeController.current = null;
        if (pickerMounted.current && !privateClosed.current) setBusy(false);
      }
    }
  }

  const actionRoute = pickerRoute.current;
  const actionSession = sessionRef.current;
  const renderedActionGeneration = actionGeneration.current;
  const actionReadGeneration = generation.current;
  function canUseGoalControls(allowError = false) {
    return (
      pickerMounted.current &&
      !privateClosed.current &&
      (state === "ready" || (allowError && state === "error")) &&
      !busy &&
      !profileBusy &&
      !candidateBusy &&
      actionSession !== null &&
      sessionRef.current === actionSession &&
      pickerRoute.current === actionRoute &&
      (loadedPickerRoute.current === actionRoute || (allowError && state === "error")) &&
      builderRef.current === builder &&
      actionGeneration.current === renderedActionGeneration &&
      generation.current === actionReadGeneration &&
      conflictRef.current === conflict &&
      selectedDateRef.current === date &&
      dateDraftRef.current === dateDraft &&
      !authController.current &&
      !loadController.current &&
      !writeController.current &&
      !profileController.current &&
      !candidateController.current
    );
  }

  function editBuilder(change: GoalBuilder | ((current: GoalBuilder) => GoalBuilder)) {
    if (
      !pickerMounted.current ||
      privateClosed.current ||
      !actionSession ||
      sessionRef.current !== actionSession ||
      pickerRoute.current !== actionRoute ||
      builderRef.current !== builder ||
      actionGeneration.current !== renderedActionGeneration ||
      busy ||
      profileBusy ||
      writeController.current ||
      profileController.current
    )
      return;
    setBuilder(change);
  }

  function canRetryInitialLoad() {
    return (
      pickerMounted.current &&
      !privateClosed.current &&
      state === "error" &&
      (actionSession === null || loadedPickerRoute.current === null) &&
      sessionRef.current === actionSession &&
      pickerRoute.current === actionRoute &&
      actionGeneration.current === renderedActionGeneration &&
      generation.current === actionReadGeneration &&
      !authController.current &&
      !loadController.current &&
      !writeController.current &&
      !profileController.current &&
      !candidateController.current
    );
  }

  function reloadSavedGoal() {
    if (canRetryInitialLoad())
      void refreshSessionAndGoals(
        requestedDate && isLocalDate(requestedDate) ? requestedDate : undefined,
        actionSession?.user.id,
      );
    else requestReplacement("reload", date, true);
  }

  function builderHasEdits() {
    return JSON.stringify(builderRef.current) !== JSON.stringify(baselineRef.current);
  }

  function canCopySavedGoal() {
    return (
      canUseGoalControls() &&
      !dateProposalPending.current &&
      copySource !== null &&
      copySourceRef.current === copySource &&
      goal === copySource.goal &&
      sessionRef.current === copySource.session &&
      pickerRoute.current === copySource.route &&
      pickerScope.current !== null &&
      pickerScope.current === copySource.scope &&
      date === copySource.progressDate &&
      effectiveDateRef.current === builder.effectiveFrom &&
      generation.current === copySource.readGeneration
    );
  }

  function copySavedGoalToDraft(confirmed = false) {
    if ((!confirmed && !canCopySavedGoal()) || !copySource) return;
    const next = {
      ...goalBuilderFromGoal(copySource.goal),
      goalId: null,
      revision: null,
      effectiveFrom: "",
      reference: null,
    };
    candidateController.current?.abort();
    candidateController.current = null;
    candidateGeneration.current += 1;
    effectiveDateRef.current = next.effectiveFrom;
    baselineRef.current = emptyGoal("");
    setConflict(null);
    setBuilder(next);
    setReferenceSets(null);
    setSelectedReferenceGroup("");
    setReferenceAcknowledged(false);
    setReferenceCustomized(false);
    setMessage(
      `Copied saved goal version ${copySource.goal.versionNumber} to a new draft. Choose its effective date, review the values, then Create goal. Saved values are unchanged.`,
    );
  }

  function openDraftChoice(action: GoalDraftChoice["action"], targetDate = date) {
    const session = sessionRef.current;
    if (!session) return;
    actionGeneration.current += 1;
    const choice: GoalDraftChoice = {
      action,
      targetDate,
      source: action === "copy" ? copySource : null,
      builder,
      session,
      route: actionRoute,
      readGeneration: generation.current,
      actionGeneration: actionGeneration.current,
      date,
    };
    draftChoiceRef.current = choice;
    setDraftChoice(choice);
  }

  function requestGoalCopy() {
    if (!canCopySavedGoal() || !copySource) return;
    if (JSON.stringify(builder) === JSON.stringify(goalBuilderFromGoal(copySource.goal)))
      copySavedGoalToDraft();
    else openDraftChoice("copy");
  }

  function installNewGoal() {
    const next = emptyGoal(date);
    effectiveDateRef.current = next.effectiveFrom;
    baselineRef.current = next;
    setConflict(null);
    setBuilder(next);
    setReferenceSets(null);
    setSelectedReferenceGroup("");
    setReferenceAcknowledged(false);
    setReferenceCustomized(false);
    dateProposalPending.current = false;
    dateDraftRef.current = date;
    setDateDraft(date);
    setMessage("New goal draft started. Choose its effective date and explicit targets.");
  }

  function performReplacement(action: "new" | "date" | "reload", targetDate: string) {
    clearDraftChoice();
    if (action === "new") installNewGoal();
    else if (sessionRef.current)
      void refreshSessionAndGoals(targetDate, sessionRef.current.user.id, "replace");
  }

  function requestReplacement(
    action: "new" | "date" | "reload",
    targetDate = date,
    discardConflict = false,
  ) {
    if (
      !canUseGoalControls(action !== "new") ||
      !isLocalDate(targetDate) ||
      (action === "new" && dateProposalPending.current)
    )
      return;
    if (action === "reload" && discardConflict && conflictRef.current !== null) {
      performReplacement(action, targetDate);
    } else if (builderHasEdits()) openDraftChoice(action, targetDate);
    else performReplacement(action, targetDate);
  }

  function choiceIsCurrent() {
    return (
      draftChoice !== null &&
      draftChoiceRef.current === draftChoice &&
      canUseGoalControls(draftChoice.action !== "new" && draftChoice.action !== "copy") &&
      builderRef.current === draftChoice.builder &&
      sessionRef.current === draftChoice.session &&
      pickerRoute.current === draftChoice.route &&
      generation.current === draftChoice.readGeneration &&
      actionGeneration.current === draftChoice.actionGeneration &&
      date === draftChoice.date &&
      (draftChoice.action !== "copy" ||
        (canCopySavedGoal() && copySourceRef.current === draftChoice.source))
    );
  }

  function resolveDraftChoice(discard: boolean) {
    if (!choiceIsCurrent() || !draftChoice) return;
    const choice = draftChoice;
    clearDraftChoice();
    actionGeneration.current += 1;
    if (!discard) {
      dateProposalPending.current = false;
      dateDraftRef.current = date;
      setDateDraft(date);
    } else if (choice.action === "copy") {
      // The choice consumed the current action token; its source was checked above.
      copySavedGoalToDraft(true);
    } else performReplacement(choice.action, choice.targetDate);
  }

  function changeProgressDate(value: string) {
    if (!canUseGoalControls(true) || value === dateDraft) return;
    actionGeneration.current += 1;
    clearDraftChoice();
    dateProposalPending.current = true;
    dateDraftRef.current = value;
    setDateDraft(value);
  }

  const historicalGoal = goalBuilderIsHistorical(goal, builder);
  const selectedReferenceSet = referenceSets?.sets.find(
    (candidate) => candidate.groupCode === selectedReferenceGroup,
  );
  const verifiedApplied = appliedReferenceMatchesGoal(referenceSets?.applied ?? null, goal);
  const appliedReferenceSet = appliedReferenceSetForDisplay(referenceSets, goal);
  const appliedProfileDrift =
    verifiedApplied &&
    referenceSets?.applied?.appliedProfileRevision !== referenceSets?.profileRevision;
  const referenceLocked = !referenceCustomized && (builder.reference !== null || verifiedApplied);
  const availableNutrients = definitions.filter(
    (definition) =>
      !builder.targets.some((target) => target.definition.nutrientId === definition.nutrientId),
  );
  const matchingNutrients = availableNutrients.filter((definition) =>
    `${definition.name} ${definition.code}`
      .toLowerCase()
      .includes(nutrientQuery.trim().toLowerCase()),
  );
  const effectiveNutrientId = matchingNutrients.some(
    (item) => item.nutrientId === selectedNutrientId,
  )
    ? selectedNutrientId
    : (matchingNutrients[0]?.nutrientId ?? "");
  const renderedPickerGeneration = pickerGeneration.current;
  const renderedPickerScope = pickerScope.current;
  function canUseNutrientPicker() {
    return (
      canUseGoalControls() &&
      !dateProposalPending.current &&
      !historicalGoal &&
      !referenceLocked &&
      pickerScope.current !== null &&
      pickerScope.current === renderedPickerScope &&
      effectiveDateRef.current === builder.effectiveFrom &&
      pickerGeneration.current === renderedPickerGeneration &&
      nutrientQueryRef.current === nutrientQuery &&
      nutrientSelectionRef.current === selectedNutrientId &&
      pickerDefinitions.current === definitions
    );
  }
  const pickerDisabled = !canUseNutrientPicker();

  return (
    <>
      <aside className="sidebar">
        <Link className="brand brandDark" href="/">
          <Icon name="leaf" /> Nourishing
        </Link>
        <AppNavigation active="goals" date={date} />
        <details className="ledgerAccount">
          <summary>Account</summary>
          <div className="ledgerAccountPanel">
            <Link href={`/dashboard?date=${encodeURIComponent(date)}`}>Open diary</Link>
            <p className="wellnessNote">General wellness estimates—not medical advice.</p>
          </div>
        </details>
      </aside>
      <section className="dashboard goalsDashboard">
        <header className="dashboardHeader foodPageHeader">
          <div>
            <p className="kicker">EXPLAINABLE DAILY TARGETS</p>
            <h1>Goals</h1>
          </div>
          <span className="statusPill">Versioned</span>
        </header>
        <p className="workspaceIntro">
          Choose your own fixed energy target or an eligible adult profile-derived estimate, then
          add explicit nutrient thresholds with their source.
        </p>
        <p className="workspaceStatus" data-state={state} aria-live="polite">
          {message}
        </p>
        <div className="goalWorkspace">
          <section className="workspacePanel">
            <div className="workspaceHeading">
              <div>
                <p className="kicker">
                  {builder.goalId && goal ? `GOAL REVISION ${goal.versionNumber}` : "NEW GOAL"}
                </p>
                <h2>Daily targets</h2>
              </div>
              {builder.goalId && goal ? (
                <>
                  <button
                    className="buttonSecondary"
                    disabled={!canUseGoalControls() || dateProposalPending.current}
                    onClick={() => requestReplacement("new")}
                    type="button"
                  >
                    New goal
                  </button>
                  <span className="statusPill">Effective {goal.effectiveFrom}</span>
                </>
              ) : null}
            </div>
            <button
              className="buttonSecondary"
              disabled={!canUseGoalControls(true) && !canRetryInitialLoad()}
              onClick={reloadSavedGoal}
              type="button"
            >
              {conflict
                ? "Discard edits and reload saved goal"
                : state === "error"
                  ? "Retry goals"
                  : "Reload saved goal"}
            </button>
            {copySource ? (
              <section className="workspaceSection" aria-label="Copy saved goal">
                <p className="fieldHelp">
                  Copy saved goal version {copySource.goal.versionNumber}, effective{" "}
                  {copySource.goal.effectiveFrom}, into a new dated draft. Creating it may close the
                  prior active goal period; its saved values stay intact.
                </p>
                <button
                  className="buttonSecondary"
                  disabled={!canCopySavedGoal()}
                  onClick={requestGoalCopy}
                  type="button"
                >
                  Copy saved goal to new draft
                </button>
              </section>
            ) : null}
            {draftChoice && choiceIsCurrent() ? (
              <fieldset
                aria-labelledby="goal-draft-confirmation"
                style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
              >
                <p id="goal-draft-confirmation" className="coverageCopy" aria-live="polite">
                  This editor has unsaved changes. Keep editing, or discard them to{" "}
                  {draftChoice.action === "new"
                    ? "start a new goal"
                    : draftChoice.action === "date"
                      ? `load the goal and progress for ${draftChoice.targetDate}`
                      : draftChoice.action === "copy"
                        ? `copy saved goal version ${draftChoice.source?.goal.versionNumber}`
                        : "reload the saved goal"}
                  .
                </p>
                <button
                  className="buttonQuiet"
                  onClick={() => resolveDraftChoice(false)}
                  ref={draftKeepButton}
                  type="button"
                >
                  Keep editing
                </button>{" "}
                <button
                  className="buttonSecondary"
                  onClick={() => resolveDraftChoice(true)}
                  type="button"
                >
                  {draftChoice.action === "new"
                    ? "Discard edits and start new goal"
                    : draftChoice.action === "date"
                      ? "Discard edits and change progress date"
                      : draftChoice.action === "copy"
                        ? "Discard edits and copy saved version"
                        : "Discard edits and reload saved goal"}
                </button>
              </fieldset>
            ) : null}
            <form className="workspaceForm" onSubmit={(event) => void save(event)}>
              <fieldset className="goalEditorFields" disabled={busy || historicalGoal}>
                <label className="formField">
                  <span>Effective from</span>
                  <input
                    aria-describedby={builder.goalId ? "effective-date-help" : undefined}
                    type="date"
                    onBlur={() => {
                      const ownerSession = sessionRef.current;
                      if (
                        canUseGoalControls() &&
                        ownerSession &&
                        isLocalDate(builder.effectiveFrom)
                      ) {
                        void loadCandidates(builder.effectiveFrom, ownerSession);
                      }
                    }}
                    onChange={(event) => {
                      if (!canUseGoalControls()) return;
                      const effectiveFrom = event.target.value;
                      effectiveDateRef.current = effectiveFrom;
                      candidateController.current?.abort();
                      setReferenceSets(null);
                      setSelectedReferenceGroup("");
                      setReferenceAcknowledged(false);
                      if (builder.reference) setReferenceCustomized(false);
                      editBuilder({
                        ...builder,
                        effectiveFrom,
                        ...(builder.reference ? { targets: [], reference: null } : {}),
                      });
                    }}
                    readOnly={builder.goalId !== null}
                    value={builder.effectiveFrom}
                  />
                </label>
                {builder.goalId ? (
                  <p className="fieldHelp" id="effective-date-help">
                    {historicalGoal
                      ? "This closed goal is immutable history. Start a new goal to make changes."
                      : "A revision keeps the original effective date. Create a new goal to choose another date."}
                  </p>
                ) : null}
                <fieldset className="modeChooser">
                  <legend className="fieldLegend">Energy method</legend>
                  <div className="intentControls">
                    <label
                      className={`intentOption ${builder.energyMode === "fixed" ? "active" : ""}`}
                    >
                      <input
                        checked={builder.energyMode === "fixed"}
                        name="energy-mode"
                        onChange={() =>
                          editBuilder({
                            ...builder,
                            energyMode: "fixed",
                            fixedKcal: builder.energyMode === "derived" ? "" : builder.fixedKcal,
                          })
                        }
                        type="radio"
                      />
                      <span>Fixed target</span>
                    </label>
                    <label
                      className={`intentOption ${builder.energyMode === "derived" ? "active" : ""}`}
                    >
                      <input
                        checked={builder.energyMode === "derived"}
                        name="energy-mode"
                        onChange={() => editBuilder({ ...builder, energyMode: "derived" })}
                        type="radio"
                      />
                      <span>Profile-derived estimate</span>
                    </label>
                  </div>
                </fieldset>
                {builder.energyMode === "fixed" ? (
                  <label className="formField">
                    <span>Daily energy (kcal)</span>
                    <input
                      inputMode="decimal"
                      maxLength={19}
                      onChange={(event) =>
                        editBuilder({ ...builder, fixedKcal: event.target.value })
                      }
                      placeholder="Enter your selected value"
                      value={builder.fixedKcal}
                    />
                  </label>
                ) : (
                  <div className="formGrid">
                    <label className="formField">
                      <span>PAL category</span>
                      <select
                        onChange={(event) => {
                          const code = event.target.value as GoalBuilder["activityLevelCode"];
                          editBuilder({
                            ...builder,
                            activityLevelCode: code,
                            activityFactor: "",
                            palAcknowledged: false,
                          });
                        }}
                        value={builder.activityLevelCode}
                      >
                        <option value="">Choose a category…</option>
                        <option value="sedentary_or_light">Sedentary or light (1.40–1.69)</option>
                        <option value="active_or_moderate">Active or moderate (1.70–1.99)</option>
                        <option value="vigorous">Vigorous (2.00–2.40)</option>
                      </select>
                    </label>
                    <label className="formField">
                      <span>PAL factor</span>
                      <input
                        inputMode="decimal"
                        maxLength={19}
                        onChange={(event) =>
                          editBuilder({
                            ...builder,
                            activityFactor: event.target.value,
                            palAcknowledged: false,
                          })
                        }
                        value={builder.activityFactor}
                      />
                    </label>
                    <label className="formField">
                      <span>Adjustment kcal</span>
                      <input
                        inputMode="decimal"
                        maxLength={20}
                        onChange={(event) =>
                          editBuilder({ ...builder, adjustmentKcal: event.target.value })
                        }
                        value={builder.adjustmentKcal}
                      />
                    </label>
                    <label className="formField formField--wide">
                      <span>
                        <input
                          checked={builder.palAcknowledged}
                          onChange={(event) =>
                            editBuilder({ ...builder, palAcknowledged: event.target.checked })
                          }
                          type="checkbox"
                        />{" "}
                        I understand PAL represents habitual total activity and ordinary exercise is
                        not added again.
                      </span>
                    </label>
                    <p className="fieldHelp formField--wide">
                      Estimated daily energy = estimated resting energy × PAL + adjustment. This is
                      not a measured value or recommendation.
                    </p>
                  </div>
                )}
                <label className="formField">
                  <span>Why this energy target?</span>
                  <textarea
                    maxLength={1_000}
                    onChange={(event) => editBuilder({ ...builder, rationale: event.target.value })}
                    value={builder.rationale}
                  />
                </label>
                {referenceTargetSectionVisible(templatesSupported, referenceSets) ? (
                  <section className="workspaceSection" aria-labelledby="candidate-targets-heading">
                    <div className="workspaceHeading">
                      <div>
                        <p className="kicker">OPTIONAL SOURCE-VERIFIED CANDIDATE</p>
                        <h3 id="candidate-targets-heading">U.S.–Canada population references</h3>
                      </div>
                      {verifiedApplied ? (
                        <span className="statusPill">Verified on this goal</span>
                      ) : null}
                    </div>
                    <p className="coverageCopy">
                      Choosing a group changes nothing. Applying copies its 12 values into this
                      unsaved draft; Create or Publish remains a separate action.
                    </p>
                    {verifiedApplied && referenceSets?.applied && appliedReferenceSet ? (
                      <div aria-live="polite">
                        <p className="fieldHelp">
                          <strong>Applied reference snapshot:</strong> {appliedReferenceSet.title}.{" "}
                          Template {appliedReferenceSet.templateVersion}; acknowledgement accepted{" "}
                          <time dateTime={referenceSets.applied.acknowledgement.acceptedAt}>
                            {referenceSets.applied.acknowledgement.acceptedAt}
                          </time>
                          . Eligible through the day before{" "}
                          {appliedReferenceSet.eligibleThroughExclusive}.
                        </p>
                        {appliedProfileDrift ? (
                          <p className="fieldHelp">
                            Your profile changed after this snapshot was applied. Its saved values
                            and sources remain visible, but its acknowledgement is not reused.
                            Select the current group, acknowledge it, and Apply again—or choose
                            Customize.
                          </p>
                        ) : null}
                        {appliedProfileDrift || !selectedReferenceSet ? (
                          <ReferenceTargetRows
                            legend="Applied 12-value source snapshot"
                            set={appliedReferenceSet}
                          />
                        ) : null}
                      </div>
                    ) : null}
                    {templatesSupported ? (
                      <>
                        <fieldset className="goalEditorFields">
                          <legend className="fieldLegend">
                            Profile fields used for eligibility
                          </legend>
                          <div className="formGrid">
                            <label className="formField">
                              <span>Birth date (YYYY-MM-DD)</span>
                              <input
                                disabled={profileBusy || busy}
                                maxLength={10}
                                onChange={(event) => setProfileBirthDate(event.target.value)}
                                value={profileBirthDate}
                              />
                            </label>
                            <label className="formField">
                              <span>Sex at birth</span>
                              <select
                                disabled={profileBusy || busy}
                                onChange={(event) => setProfileSexAtBirth(event.target.value)}
                                value={profileSexAtBirth}
                              >
                                <option value="">Choose…</option>
                                <option value="female">Female</option>
                                <option value="male">Male</option>
                                <option value="intersex">Intersex</option>
                                <option value="not_specified">Prefer not to specify</option>
                              </select>
                            </label>
                          </div>
                          <button
                            className="buttonSecondary"
                            disabled={profileBusy || busy}
                            onClick={() => void saveProfilePrerequisites()}
                            type="button"
                          >
                            {profileBusy ? "Saving profile…" : "Save profile and check eligibility"}
                          </button>
                        </fieldset>
                        {referenceSets ? (
                          <>
                            <p className="coverageCopy">{referenceSets.notice}</p>
                            {referenceSets.availability.available ? (
                              <fieldset className="modeChooser">
                                <legend className="fieldLegend">
                                  Choose the matching source group
                                </legend>
                                {referenceSets.sets.map((candidate) => (
                                  <label className="intentOption" key={candidate.groupCode}>
                                    <input
                                      checked={selectedReferenceGroup === candidate.groupCode}
                                      disabled={
                                        busy ||
                                        historicalGoal ||
                                        (referenceLocked && !appliedProfileDrift)
                                      }
                                      name="reference-target-group"
                                      onChange={() => {
                                        if (!canUseGoalControls()) return;
                                        actionGeneration.current += 1;
                                        clearDraftChoice();
                                        setSelectedReferenceGroup(candidate.groupCode);
                                        setReferenceAcknowledged(false);
                                      }}
                                      type="radio"
                                    />
                                    <span>{candidate.title}</span>
                                  </label>
                                ))}
                              </fieldset>
                            ) : (
                              <p className="fieldHelp">
                                {referenceAvailabilityMessage(
                                  referenceSets.availability.reasonCodes,
                                )}
                              </p>
                            )}
                            {selectedReferenceSet ? (
                              <div aria-live="polite">
                                <p className="fieldHelp">
                                  This candidate expires on your 51st birthday (
                                  {selectedReferenceSet.eligibleThroughExclusive}); the day before
                                  is the final eligible day.
                                </p>
                                <ReferenceTargetRows
                                  legend="Candidate target preview"
                                  set={selectedReferenceSet}
                                />
                                <label className="formField formField--wide">
                                  <span>
                                    <input
                                      checked={referenceAcknowledged}
                                      disabled={
                                        busy ||
                                        historicalGoal ||
                                        (referenceLocked && !appliedProfileDrift)
                                      }
                                      onChange={(event) => {
                                        if (!canUseGoalControls()) return;
                                        actionGeneration.current += 1;
                                        clearDraftChoice();
                                        setReferenceAcknowledged(event.target.checked);
                                      }}
                                      type="checkbox"
                                    />{" "}
                                    {referenceSets.acknowledgementPolicy.text}
                                  </span>
                                </label>
                                <button
                                  className="buttonSecondary"
                                  disabled={
                                    busy ||
                                    historicalGoal ||
                                    (referenceLocked && !appliedProfileDrift) ||
                                    !referenceAcknowledged
                                  }
                                  onClick={() => applyReferenceDraft(selectedReferenceSet)}
                                  type="button"
                                >
                                  Apply 12 values to unsaved draft
                                </button>
                              </div>
                            ) : null}
                            {referenceLocked ? (
                              <button
                                className="buttonSecondary"
                                disabled={busy || historicalGoal}
                                onClick={() =>
                                  customizeReferenceDraft(
                                    verifiedApplied
                                      ? (appliedReferenceSet ?? undefined)
                                      : selectedReferenceSet,
                                  )
                                }
                                type="button"
                              >
                                Customize as editable targets and clear verified provenance
                              </button>
                            ) : null}
                            <details>
                              <summary>Official sources and important cautions</summary>
                              <p className="sourceLine">
                                Source snapshot {referenceSets.sources.version}, checked{" "}
                                {referenceSets.sources.reviewedOn}:{" "}
                                <a
                                  href={referenceSets.sources.overviewUrl}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  Overview
                                </a>
                                {" · "}
                                <a
                                  href={referenceSets.sources.macronutrientsUrl}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  Macronutrients
                                </a>
                                {" · "}
                                <a
                                  href={referenceSets.sources.elementsUrl}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  Elements
                                </a>
                                {" · "}
                                <a
                                  href={referenceSets.sources.vitaminsUrl}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  Vitamins
                                </a>
                                {" · "}
                                <a
                                  href={referenceSets.sources.reportListUrl}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  Reports
                                </a>
                              </p>
                              <ul className="coverageCopy">
                                {referenceSets.cautions.map((caution) => (
                                  <li key={caution.code}>{caution.text}</li>
                                ))}
                              </ul>
                            </details>
                          </>
                        ) : (
                          <p className="fieldHelp">
                            Save the profile fields or reload this effective date to check
                            eligibility.
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="fieldHelp">
                        Candidate templates are not supported by this API version. Manual nutrient
                        goals below remain available.
                      </p>
                    )}
                  </section>
                ) : null}
                <section className="workspaceSection" aria-labelledby="targets-heading">
                  <h3 id="targets-heading">Nutrient thresholds ({builder.targets.length}/256)</h3>
                  {referenceLocked ? (
                    <p className="fieldHelp">
                      These source-verified candidate rows are read-only. Choose Customize above to
                      make an editable copy and clear verified provenance.
                    </p>
                  ) : (
                    <>
                      <label className="formField">
                        <span>Find a nutrient</span>
                        <input
                          maxLength={100}
                          value={nutrientQuery}
                          disabled={pickerDisabled}
                          onChange={(event) => changeNutrientQuery(event.target.value)}
                        />
                      </label>
                      <button
                        className="buttonSecondary"
                        disabled={pickerDisabled}
                        onClick={() => changeNutrientQuery("")}
                        type="button"
                      >
                        Clear nutrient search
                      </button>
                      <p className="fieldHelp" aria-live="polite">
                        {state === "loading"
                          ? "Loading nutrients…"
                          : `${matchingNutrients.length} matching · ${availableNutrients.length} available · ${definitions.length} loaded. Search applies only to loaded nutrients.`}
                      </p>
                      {state !== "loading" && definitions.length === 0 ? (
                        <p className="fieldHelp">
                          No nutrients are loaded. Retry goals if loading failed.
                        </p>
                      ) : state !== "loading" && availableNutrients.length === 0 ? (
                        <p className="fieldHelp">All loaded nutrients are already in this draft.</p>
                      ) : state !== "loading" && matchingNutrients.length === 0 ? (
                        <p className="fieldHelp">No available nutrients match this search.</p>
                      ) : null}
                      <div className="searchInputRow">
                        <select
                          aria-label="Nutrient to add"
                          disabled={pickerDisabled || matchingNutrients.length === 0}
                          onChange={(event) => selectNutrient(event.target.value)}
                          value={effectiveNutrientId}
                        >
                          {matchingNutrients.length === 0 ? (
                            <option value="">No available match</option>
                          ) : null}
                          {matchingNutrients.map((definition) => (
                            <option key={definition.nutrientId} value={definition.nutrientId}>
                              {definition.name} ({definition.unit})
                            </option>
                          ))}
                        </select>
                        <button
                          className="buttonSecondary"
                          disabled={
                            pickerDisabled || !effectiveNutrientId || builder.targets.length >= 256
                          }
                          onClick={addTarget}
                          type="button"
                        >
                          Add nutrient
                        </button>
                      </div>
                    </>
                  )}
                  <div className="goalTargetGrid">
                    {builder.targets.map((target, index) => (
                      <div className="goalTargetRow" key={target.definition.nutrientId}>
                        <div>
                          <strong>{target.definition.name}</strong>
                          <p className="sourceLine">
                            {target.definition.unit} · {target.definition.category}
                          </p>
                          <input
                            aria-label={`${target.definition.name} target source`}
                            maxLength={160}
                            onChange={(event) =>
                              updateTarget(index, { sourceLabel: event.target.value })
                            }
                            placeholder="Source label (required)"
                            readOnly={referenceLocked}
                            value={target.sourceLabel}
                          />
                          <input
                            aria-label={`${target.definition.name} source version`}
                            maxLength={100}
                            onChange={(event) =>
                              updateTarget(index, { sourceVersion: event.target.value })
                            }
                            placeholder="Source version (optional)"
                            readOnly={referenceLocked}
                            value={target.sourceVersion}
                          />
                          <input
                            aria-label={`${target.definition.name} rationale`}
                            maxLength={1_000}
                            onChange={(event) =>
                              updateTarget(index, { rationale: event.target.value })
                            }
                            placeholder="Rationale (optional)"
                            readOnly={referenceLocked}
                            value={target.rationale}
                          />
                        </div>
                        <input
                          aria-label={`${target.definition.name} minimum ${target.definition.unit}`}
                          inputMode="decimal"
                          maxLength={31}
                          onChange={(event) =>
                            updateTarget(index, { minimumAmount: event.target.value })
                          }
                          placeholder="Minimum"
                          readOnly={referenceLocked}
                          value={target.minimumAmount}
                        />
                        <input
                          aria-label={`${target.definition.name} target ${target.definition.unit}`}
                          inputMode="decimal"
                          maxLength={31}
                          onChange={(event) =>
                            updateTarget(index, { targetAmount: event.target.value })
                          }
                          placeholder="Target"
                          readOnly={referenceLocked}
                          value={target.targetAmount}
                        />
                        <input
                          aria-label={`${target.definition.name} maximum ${target.definition.unit}`}
                          inputMode="decimal"
                          maxLength={31}
                          onChange={(event) =>
                            updateTarget(index, { maximumAmount: event.target.value })
                          }
                          placeholder="Maximum"
                          readOnly={referenceLocked}
                          value={target.maximumAmount}
                        />
                        <button
                          className="buttonDanger"
                          disabled={referenceLocked}
                          onClick={() =>
                            editBuilder({
                              ...builder,
                              targets: builder.targets.filter(
                                (_, candidate) => candidate !== index,
                              ),
                            })
                          }
                          type="button"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              </fieldset>
              <button
                className="buttonPrimary"
                disabled={
                  busy ||
                  !canUseGoalControls() ||
                  conflict?.kind === "eligibility" ||
                  historicalGoal ||
                  (verifiedApplied && builder.reference === null && !referenceCustomized)
                }
                type="submit"
              >
                {historicalGoal
                  ? "Closed goal history is read-only"
                  : busy
                    ? "Saving…"
                    : builder.goalId
                      ? "Publish goal revision"
                      : "Create goal"}
              </button>
            </form>
            {builder.goalId && goal?.energy.mode === "derived" ? (
              <section className="workspaceSection">
                <h3>Explainable energy estimate</h3>
                <p>
                  <strong>
                    {formatNutrientAmount(goal.energy.targetKcal, "kcal")} estimated daily energy
                  </strong>{" "}
                  from {formatNutrientAmount(goal.energy.bmrKcal, "kcal")} estimated resting energy.
                </p>
                <details>
                  <summary>Calculation inputs</summary>
                  <p className="coverageCopy">
                    Profile revision {goal.energy.profileRevision}: age {goal.energy.ageYears},{" "}
                    {goal.energy.sexAtBirth} equation constant, {goal.energy.heightCm} cm,{" "}
                    {goal.energy.weightKg} kg, PAL {goal.energy.activityFactor}, adjustment{" "}
                    {goal.energy.adjustmentKcal} kcal. This is an estimate, not measured metabolism
                    or a recommendation. Ordinary exercise is already represented by PAL.
                  </p>
                </details>
                <p className="sourceLine">
                  <a href={goal.energy.sourceUrl} rel="noreferrer" target="_blank">
                    {goal.energy.equationLabel}
                  </a>{" "}
                  ·{" "}
                  <a href={goal.energy.activitySourceUrl} rel="noreferrer" target="_blank">
                    Reviewed FAO/WHO/UNU PAL policy
                  </a>
                </p>
              </section>
            ) : null}
          </section>
          <aside className="recipeRail">
            <div className="workspaceHeading">
              <div>
                <p className="kicker">LOCAL DAY</p>
                <h2>Progress</h2>
              </div>
            </div>
            <label className="formField">
              <span>Progress date</span>
              <input
                type="date"
                disabled={!canUseGoalControls(true)}
                onChange={(event) => changeProgressDate(event.target.value)}
                onBlur={() => {
                  if (conflict && dateDraft === date && !dateProposalPending.current) return;
                  requestReplacement(dateDraft === date ? "reload" : "date", dateDraft);
                }}
                value={dateDraft}
              />
            </label>
            {progress?.energy ? (
              <ProgressRow row={progress.energy} />
            ) : (
              <p className="coverageCopy">No energy comparison is available for this day.</p>
            )}
            <ul className="progressList">
              {progress?.nutrients.map((row) => (
                <li key={row.nutrientId}>
                  <ProgressRow row={row} />
                </li>
              ))}
            </ul>
            <p className="coverageCopy">
              {progress?.notice ?? "General wellness estimate; not medical advice."} Incomplete
              intake is a quantified lower bound, never a measured zero.
            </p>
          </aside>
        </div>
      </section>
    </>
  );
}

function ReferenceTargetRows({
  legend,
  set,
}: {
  readonly legend: string;
  readonly set: ReferenceTargetSet;
}) {
  return (
    <fieldset className="goalTargetGrid">
      <legend className="fieldLegend">{legend}</legend>
      {set.targets.map((target) => (
        <div className="goalTargetRow" key={target.definition.nutrientId}>
          <div>
            <strong>{target.definition.name}</strong>
            <p className="sourceLine">
              {target.basis.referenceType.toUpperCase()} · usual average daily intake ·{" "}
              {target.source.version} · {target.source.table}
            </p>
          </div>
          <span>Target {formatNutrientAmount(target.targetAmount, target.definition.unit)}</span>
          <span>
            {target.maximumAmount
              ? `UL ${formatNutrientAmount(target.maximumAmount, target.definition.unit)}`
              : "No compatible UL copied"}
          </span>
          <a href={target.source.url} rel="noreferrer" target="_blank">
            Official source
          </a>
        </div>
      ))}
    </fieldset>
  );
}

function ProgressRow({ row }: { readonly row: GoalProgressView["nutrients"][number] }) {
  const view = nutrientProgressPresentation({
    name: row.name,
    unit: row.unit,
    knownAmount: row.knownAmount,
    completeness: row.completeness,
    amountInterpretation: row.amountInterpretation,
    minimumAmount: row.minimum?.amount ?? null,
    targetAmount: row.target?.amount ?? null,
    maximumAmount: row.maximum?.amount ?? null,
    lowerBoundPercent: row.target?.lowerBoundPercent ?? null,
    percentIsExact: row.target?.percentIsExact ?? row.amountInterpretation === "exact",
  });
  return (
    <section
      aria-label={`${view.accessibilityLabel}${row.minimum ? ` Minimum ${row.minimum.amount} ${row.unit}: ${row.minimum.state}.` : ""}${row.maximum ? ` Maximum ${row.maximum.amount} ${row.unit}: ${row.maximum.state}.` : ""}`}
    >
      <div className="progressHeader">
        <strong>{row.name}</strong>
        <span>{view.valueText}</span>
      </div>
      {view.progressPercent !== null ? (
        <div aria-hidden="true" className="progressTrack">
          <span style={{ width: `${view.progressPercent}%` }} />
        </div>
      ) : null}
      <p className="coverageCopy">
        {view.targetText} · {view.coverageText}
        {row.minimum
          ? ` · minimum ${formatNutrientAmount(row.minimum.amount, row.unit)} (${row.minimum.state})`
          : ""}
        {row.maximum
          ? ` · maximum ${formatNutrientAmount(row.maximum.amount, row.unit)} (${row.maximum.state})`
          : ""}
      </p>
    </section>
  );
}
