import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiUrl, authenticatedHeaders, jsonBody, responseError } from "../api/private-api";
import { newOperationId } from "../auth/operation-id";
import {
  isLocalDate,
  localDateInTimeZone,
  type ProfileSummary,
  parseProfileResponse,
  profileRequestIdentityMatches,
} from "../diary/diary";
import { palette } from "../theme";
import {
  type GoalProgressRowView,
  type GoalProgressView,
  type GoalView,
  goalSelectionIsHistorical,
  goalWriteBody,
  nutrientProgressPresentation,
  parseCurrentGoal,
  parseGoalMutation,
  parseGoalProgress,
  parseTargetableNutrients,
  prepareStableMutation,
  type StableMutation,
  type TargetableNutrient,
} from "./recipes-goals";
import {
  type NativeReferenceTargetList,
  type NativeReferenceTargetSet,
  nativeAppliedReferenceMatchesGoal,
  nativeAppliedReferenceSetForDisplay,
  nativeCarriedReferenceSet,
  nativeReferenceAvailability,
  nativeReferenceDraftTargets,
  nativeReferenceGoalRequest,
  nativeReferenceSelection,
  nativeReferenceTargetSectionVisible,
  parseNativeReferenceTargetSets,
} from "./reference-targets";

type PalCode = "" | "sedentary_or_light" | "active_or_moderate" | "vigorous";

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
  readonly mode: "fixed" | "derived";
  readonly fixedKcal: string;
  readonly activityLevelCode: PalCode;
  readonly activityFactor: string;
  readonly adjustmentKcal: string;
  readonly palAcknowledged: boolean;
  readonly rationale: string;
  readonly targets: readonly TargetDraft[];
  readonly reference: {
    readonly selection: ReturnType<typeof nativeReferenceSelection>;
    readonly expectedProfileRevision: string;
    readonly policyDigest: string;
  } | null;
}

interface Props {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly profileTimeZone: string;
  readonly profileRevision: string;
  readonly profileBirthDate: string | null;
  readonly profileSexAtBirth: string | null;
  readonly expectedOwnerUserId: string;
  readonly sessionEpoch: number;
  readonly onProfileUpdated: (profile: ProfileSummary) => void;
  readonly onUnauthorized: () => Promise<void>;
  readonly onRecipes: () => void;
  readonly onDiary: (date: string) => void;
}

const ENERGY_INPUT = /^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/u;
const SIGNED_ENERGY_INPUT = /^-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/u;
const TARGET_INPUT = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,12})?$/u;

function problemCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

export function emptyGoal(date: string): GoalBuilder {
  return {
    goalId: null,
    revision: null,
    effectiveFrom: date,
    mode: "fixed",
    fixedKcal: "",
    activityLevelCode: "",
    activityFactor: "",
    adjustmentKcal: "0",
    palAcknowledged: false,
    rationale: "",
    targets: [],
    reference: null,
  };
}

export function nativeGoalBuilderFromGoal(goal: GoalView): GoalBuilder {
  return {
    goalId: goal.id,
    revision: goal.revision,
    effectiveFrom: goal.effectiveFrom,
    mode: goal.energy.mode,
    fixedKcal: goal.energy.targetKcal,
    activityLevelCode:
      goal.energy.mode === "derived" ? (goal.energy.activityLevelCode as PalCode) : "",
    activityFactor: goal.energy.mode === "derived" ? goal.energy.activityFactor : "",
    adjustmentKcal: goal.energy.mode === "derived" ? goal.energy.adjustmentKcal : "0",
    palAcknowledged: goal.energy.mode === "derived",
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

function palRange(code: Exclude<PalCode, "">): readonly [number, number] {
  if (code === "sedentary_or_light") return [1.4, 1.69];
  if (code === "active_or_moderate") return [1.7, 1.99];
  return [2, 2.4];
}

export function nativeGoalRequest(builder: GoalBuilder, expectedOwnerUserId?: string) {
  if (!isLocalDate(builder.effectiveFrom))
    throw new RangeError("Effective date must be a real YYYY-MM-DD local date.");
  const rationale = builder.rationale;
  if (!rationale.normalize("NFKC").trim() || rationale.length > 1_000)
    throw new RangeError("Explain why you selected this energy target.");
  const energy =
    builder.mode === "fixed"
      ? (() => {
          if (!ENERGY_INPUT.test(builder.fixedKcal))
            throw new RangeError("Enter your explicit positive energy target.");
          return { mode: "fixed" as const, targetKcal: builder.fixedKcal, rationale };
        })()
      : (() => {
          if (
            !builder.activityLevelCode ||
            !builder.palAcknowledged ||
            !ENERGY_INPUT.test(builder.activityFactor) ||
            !SIGNED_ENERGY_INPUT.test(builder.adjustmentKcal)
          )
            throw new RangeError(
              "Choose a PAL category, enter its factor, and acknowledge total-activity semantics.",
            );
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
    return nativeReferenceGoalRequest(
      builder.goalId,
      builder.effectiveFrom,
      energy,
      expectedOwnerUserId,
      builder.reference.expectedProfileRevision,
      builder.reference.selection,
    );
  }
  const nutrientTargets = builder.targets.map((target) => {
    const minimumAmount = target.minimumAmount || null;
    const targetAmount = target.targetAmount || null;
    const maximumAmount = target.maximumAmount || null;
    if (
      (minimumAmount !== null && !TARGET_INPUT.test(minimumAmount)) ||
      (targetAmount !== null && !TARGET_INPUT.test(targetAmount)) ||
      (maximumAmount !== null && !TARGET_INPUT.test(maximumAmount)) ||
      (minimumAmount === null && targetAmount === null && maximumAmount === null)
    )
      throw new RangeError(`${target.definition.name} needs at least one valid threshold.`);
    const sourceLabel = target.sourceLabel;
    if (!sourceLabel.normalize("NFKC").trim() || sourceLabel.length > 160)
      throw new RangeError(`${target.definition.name} needs an explicit source label.`);
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

export function GoalsScreen({
  apiBase,
  accessToken,
  profileTimeZone,
  profileRevision,
  profileBirthDate,
  profileSexAtBirth,
  expectedOwnerUserId,
  sessionEpoch,
  onProfileUpdated,
  onUnauthorized,
  onRecipes,
  onDiary,
}: Props) {
  const [date, setDate] = useState(() => localDateInTimeZone(new Date(), profileTimeZone));
  const [goal, setGoal] = useState<GoalView | null>(null);
  const [progress, setProgress] = useState<GoalProgressView | null>(null);
  const [definitions, setDefinitions] = useState<readonly TargetableNutrient[]>([]);
  const [builder, setBuilder] = useState<GoalBuilder>(() => emptyGoal(date));
  const [nutrientQuery, setNutrientQuery] = useState("");
  const [message, setMessage] = useState("Loading versioned goals…");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [referenceSets, setReferenceSets] = useState<NativeReferenceTargetList | null>(null);
  const [templatesSupported, setTemplatesSupported] = useState(true);
  const [selectedReferenceGroup, setSelectedReferenceGroup] = useState("");
  const [referenceAcknowledged, setReferenceAcknowledged] = useState(false);
  const [referenceCustomized, setReferenceCustomized] = useState(false);
  const [birthDateDraft, setBirthDateDraft] = useState(profileBirthDate ?? "");
  const [sexAtBirthDraft, setSexAtBirthDraft] = useState(profileSexAtBirth ?? "");
  const pending = useRef(new Map<string, StableMutation<ReturnType<typeof nativeGoalRequest>>>());
  const ownerRef = useRef(expectedOwnerUserId);
  ownerRef.current = expectedOwnerUserId;
  const epochRef = useRef(sessionEpoch);
  epochRef.current = sessionEpoch;
  const profileRevisionRef = useRef(profileRevision);
  profileRevisionRef.current = profileRevision;
  const dateRef = useRef(date);
  const effectiveDateRef = useRef(builder.effectiveFrom);
  const generation = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const profileController = useRef<AbortController | null>(null);
  const candidateController = useRef<AbortController | null>(null);
  const candidateGeneration = useRef(0);
  const historicalGoal = goalSelectionIsHistorical(goal, builder.goalId);
  const selectedReferenceSet = referenceSets?.sets.find(
    (candidate) => candidate.groupCode === selectedReferenceGroup,
  );
  const verifiedApplied = nativeAppliedReferenceMatchesGoal(referenceSets?.applied ?? null, goal);
  const appliedReferenceSet = nativeAppliedReferenceSetForDisplay(referenceSets, goal);
  const appliedProfileDrift =
    verifiedApplied &&
    referenceSets?.applied?.appliedProfileRevision !== referenceSets?.profileRevision;
  const referenceLocked = !referenceCustomized && (builder.reference !== null || verifiedApplied);

  const load = useCallback(
    async (localDate: string) => {
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      const requestGeneration = generation.current + 1;
      generation.current = requestGeneration;
      const initiatingOwner = expectedOwnerUserId;
      const initiatingEpoch = sessionEpoch;
      const initiatingProfileRevision = profileRevisionRef.current;
      dateRef.current = localDate;
      const requestIsCurrent = () =>
        loadController.current === controller &&
        !controller.signal.aborted &&
        generation.current === requestGeneration &&
        dateRef.current === localDate &&
        profileRequestIdentityMatches(
          ownerRef.current,
          epochRef.current,
          initiatingOwner,
          initiatingEpoch,
        );
      setLoading(true);
      try {
        const currentUrl = apiUrl(apiBase, "/v1/goals/current");
        currentUrl.searchParams.set("date", localDate);
        const progressUrl = apiUrl(apiBase, "/v1/goals/progress");
        progressUrl.searchParams.set("date", localDate);
        const referenceUrl = apiUrl(apiBase, "/v1/goals/reference-target-sets");
        referenceUrl.searchParams.set("date", localDate);
        const [currentResponse, progressResponse, definitionsResponse, referenceResponse] =
          await Promise.all([
            fetch(currentUrl.toString(), {
              headers: authenticatedHeaders(accessToken),
              signal: controller.signal,
            }),
            fetch(progressUrl.toString(), {
              headers: authenticatedHeaders(accessToken),
              signal: controller.signal,
            }),
            fetch(apiUrl(apiBase, "/v1/nutrients/targetable").toString(), {
              headers: authenticatedHeaders(accessToken),
              signal: controller.signal,
            }),
            fetch(referenceUrl.toString(), {
              headers: authenticatedHeaders(accessToken),
              signal: controller.signal,
            }),
          ]);
        if (!requestIsCurrent()) return;
        if (
          [currentResponse, progressResponse, definitionsResponse, referenceResponse].some(
            (response) => response.status === 401,
          )
        )
          return onUnauthorized();
        const [currentBody, progressBody, definitionsBody, referenceBody] = await Promise.all([
          jsonBody(currentResponse),
          jsonBody(progressResponse),
          jsonBody(definitionsResponse),
          jsonBody(referenceResponse),
        ]);
        if (!requestIsCurrent()) return;
        if (!currentResponse.ok)
          throw new Error(responseError(currentBody, "The current goal could not be loaded."));
        if (!progressResponse.ok)
          throw new Error(responseError(progressBody, "Goal progress could not be loaded."));
        if (!definitionsResponse.ok)
          throw new Error(
            responseError(definitionsBody, "Targetable nutrients could not be loaded."),
          );
        const nextGoal = parseCurrentGoal(currentBody);
        const candidateDate = nextGoal?.effectiveFrom ?? localDate;
        let effectiveReferenceResponse = referenceResponse;
        let effectiveReferenceBody = referenceBody;
        if (candidateDate !== localDate && referenceResponse.status !== 404) {
          const effectiveReferenceUrl = apiUrl(apiBase, "/v1/goals/reference-target-sets");
          effectiveReferenceUrl.searchParams.set("date", candidateDate);
          effectiveReferenceResponse = await fetch(effectiveReferenceUrl.toString(), {
            headers: authenticatedHeaders(accessToken),
            signal: controller.signal,
          });
          if (!requestIsCurrent()) return;
          if (effectiveReferenceResponse.status === 401) return onUnauthorized();
          effectiveReferenceBody = await jsonBody(effectiveReferenceResponse);
          if (!requestIsCurrent()) return;
        }
        let nextReferenceSets: NativeReferenceTargetList | null = null;
        let candidateWarning = "";
        if (effectiveReferenceResponse.status === 404) {
          candidateWarning =
            " Candidate templates are unavailable on this API; manual goals still work.";
        } else if (!effectiveReferenceResponse.ok) {
          throw new Error(
            responseError(effectiveReferenceBody, "Candidate targets could not be loaded."),
          );
        } else {
          const parsed = parseNativeReferenceTargetSets(effectiveReferenceBody);
          if (
            parsed.date !== candidateDate ||
            parsed.profileRevision !== initiatingProfileRevision
          ) {
            candidateWarning =
              " Candidate targets were withheld because the profile changed; refresh to retry.";
          } else {
            nextReferenceSets = parsed;
          }
        }
        if (!requestIsCurrent()) return;
        setGoal(nextGoal);
        setProgress(parseGoalProgress(progressBody));
        setDefinitions(parseTargetableNutrients(definitionsBody));
        let nextBuilder = nextGoal ? nativeGoalBuilderFromGoal(nextGoal) : emptyGoal(localDate);
        const applied = nextReferenceSets?.applied ?? null;
        const appliedSet = nextReferenceSets
          ? nativeCarriedReferenceSet(nextReferenceSets, nextGoal)
          : null;
        if (nextReferenceSets && appliedSet) {
          nextBuilder = {
            ...nextBuilder,
            targets: nativeReferenceDraftTargets(appliedSet),
            reference: {
              selection: nativeReferenceSelection(nextReferenceSets, appliedSet),
              expectedProfileRevision: nextReferenceSets.profileRevision,
              policyDigest: appliedSet.policyDigest,
            },
          };
        }
        effectiveDateRef.current = nextBuilder.effectiveFrom;
        setBuilder(nextBuilder);
        setTemplatesSupported(effectiveReferenceResponse.status !== 404);
        setReferenceSets(nextReferenceSets);
        setSelectedReferenceGroup(appliedSet?.groupCode ?? "");
        setReferenceAcknowledged(false);
        setReferenceCustomized(false);
        setMessage(
          nextGoal
            ? `Goal version ${nextGoal.versionNumber} applies on ${localDate}.${nativeAppliedReferenceMatchesGoal(applied, nextGoal) ? " Its source-verified candidate provenance was confirmed." : ""}${candidateWarning}`
            : `No active goal applies to this local day.${candidateWarning}`,
        );
      } catch (caught) {
        if (!requestIsCurrent()) return;
        setMessage(caught instanceof Error ? caught.message : "Goals could not be loaded.");
      } finally {
        if (loadController.current === controller) {
          loadController.current = null;
          setLoading(false);
        }
      }
    },
    [accessToken, apiBase, expectedOwnerUserId, onUnauthorized, sessionEpoch],
  );

  useEffect(() => {
    const localDate = localDateInTimeZone(new Date(), profileTimeZone);
    dateRef.current = localDate;
    setDate(localDate);
    void load(localDate);
    return () => {
      generation.current += 1;
      loadController.current?.abort();
      writeController.current?.abort();
      profileController.current?.abort();
      candidateController.current?.abort();
      pending.current.clear();
    };
  }, [load, profileTimeZone]);

  const loadCandidates = useCallback(
    async (effectiveFrom: string, expectedProfileRevision: string) => {
      if (!isLocalDate(effectiveFrom)) {
        setMessage("Choose a real effective date before loading candidate targets.");
        return;
      }
      candidateController.current?.abort();
      const controller = new AbortController();
      candidateController.current = controller;
      const requestGeneration = candidateGeneration.current + 1;
      candidateGeneration.current = requestGeneration;
      const initiatingOwner = expectedOwnerUserId;
      const initiatingEpoch = sessionEpoch;
      const requestIsCurrent = () =>
        candidateController.current === controller &&
        !controller.signal.aborted &&
        candidateGeneration.current === requestGeneration &&
        effectiveDateRef.current === effectiveFrom &&
        profileRevisionRef.current === expectedProfileRevision &&
        profileRequestIdentityMatches(
          ownerRef.current,
          epochRef.current,
          initiatingOwner,
          initiatingEpoch,
        );
      try {
        const url = apiUrl(apiBase, "/v1/goals/reference-target-sets");
        url.searchParams.set("date", effectiveFrom);
        const response = await fetch(url.toString(), {
          headers: authenticatedHeaders(accessToken),
          signal: controller.signal,
        });
        if (!requestIsCurrent()) return;
        if (response.status === 401) return onUnauthorized();
        if (response.status === 404) {
          setTemplatesSupported(false);
          setReferenceSets(null);
          setSelectedReferenceGroup("");
          setReferenceAcknowledged(false);
          setMessage("Candidate templates are unavailable on this API; manual goals still work.");
          return;
        }
        const body = await jsonBody(response);
        if (!requestIsCurrent()) return;
        if (!response.ok) {
          throw new Error(responseError(body, "Candidate targets could not be loaded."));
        }
        const parsed = parseNativeReferenceTargetSets(body);
        if (parsed.date !== effectiveFrom || parsed.profileRevision !== expectedProfileRevision) {
          throw new Error("The effective date or profile changed while candidates were loading.");
        }
        if (!requestIsCurrent()) return;
        setTemplatesSupported(true);
        setReferenceSets(parsed);
        setSelectedReferenceGroup("");
        setReferenceAcknowledged(false);
        setReferenceCustomized(false);
        const nextMessage = parsed.availability.available
          ? "Source-verified candidate loaded. Review it before applying anything to the draft."
          : nativeReferenceAvailability(parsed.availability.reasonCodes);
        setMessage(nextMessage);
        AccessibilityInfo.announceForAccessibility(nextMessage);
      } catch (caught) {
        if (!requestIsCurrent()) return;
        setMessage(
          caught instanceof Error ? caught.message : "Candidate targets could not be loaded.",
        );
      } finally {
        if (candidateController.current === controller) candidateController.current = null;
      }
    },
    [accessToken, apiBase, expectedOwnerUserId, onUnauthorized, sessionEpoch],
  );

  async function refreshProfileAfterConflict(
    controller: AbortController,
    initiatingOwner: string,
    initiatingEpoch: number,
  ): Promise<void> {
    const current = () =>
      profileController.current === controller &&
      !controller.signal.aborted &&
      profileRequestIdentityMatches(
        ownerRef.current,
        epochRef.current,
        initiatingOwner,
        initiatingEpoch,
      );
    const response = await fetch(apiUrl(apiBase, "/v1/profile").toString(), {
      headers: authenticatedHeaders(accessToken),
      signal: controller.signal,
    });
    if (!current()) return;
    if (response.status === 401) return onUnauthorized();
    const body = await jsonBody(response);
    if (!current()) return;
    if (!response.ok)
      throw new Error(responseError(body, "Fresh profile values could not be loaded."));
    const profile = parseProfileResponse(body);
    if (!current()) return;
    profileRevisionRef.current = profile.revision;
    setBirthDateDraft(typeof profile.birthDate === "string" ? profile.birthDate : "");
    setSexAtBirthDraft(typeof profile.sexAtBirth === "string" ? profile.sexAtBirth : "");
    onProfileUpdated(profile);
    await loadCandidates(effectiveDateRef.current, profile.revision);
  }

  async function saveProfilePrerequisites() {
    if (profileSaving || profileController.current) return;
    if (birthDateDraft !== "" && !isLocalDate(birthDateDraft)) {
      setMessage("Birth date must be a real YYYY-MM-DD date.");
      return;
    }
    if (!["female", "male", "intersex", "not_specified"].includes(sexAtBirthDraft)) {
      setMessage("Choose a profile sex-at-birth value before saving.");
      return;
    }
    const initiatingOwner = expectedOwnerUserId;
    const initiatingEpoch = sessionEpoch;
    const requestGeneration = generation.current;
    const controller = new AbortController();
    profileController.current = controller;
    const requestIsCurrent = () =>
      profileController.current === controller &&
      !controller.signal.aborted &&
      generation.current === requestGeneration &&
      profileRequestIdentityMatches(
        ownerRef.current,
        epochRef.current,
        initiatingOwner,
        initiatingEpoch,
      );
    setProfileSaving(true);
    setMessage("Saving the profile fields used to check candidate eligibility…");
    try {
      const response = await fetch(apiUrl(apiBase, "/v1/profile").toString(), {
        method: "PATCH",
        headers: authenticatedHeaders(accessToken, {
          "content-type": "application/json",
          "if-match": `"${profileRevisionRef.current}"`,
        }),
        body: JSON.stringify({
          expectedOwnerUserId: initiatingOwner,
          birthDate: birthDateDraft || null,
          sexAtBirth: sexAtBirthDraft,
        }),
        signal: controller.signal,
      });
      if (!requestIsCurrent()) return;
      if (response.status === 401) return onUnauthorized();
      const body = await jsonBody(response);
      if (!requestIsCurrent()) return;
      if (response.status === 409 && problemCode(body) === "PROFILE_OWNER_CHANGED") {
        return onUnauthorized();
      }
      if (response.status === 409 || response.status === 412) {
        await refreshProfileAfterConflict(controller, initiatingOwner, initiatingEpoch);
        if (requestIsCurrent()) {
          setMessage("Your profile changed elsewhere. Fresh values were loaded for review.");
        }
        return;
      }
      if (!response.ok) {
        throw new Error(responseError(body, "The eligibility profile fields could not be saved."));
      }
      const profile = parseProfileResponse(body);
      if (!requestIsCurrent()) return;
      profileRevisionRef.current = profile.revision;
      setBirthDateDraft(typeof profile.birthDate === "string" ? profile.birthDate : "");
      setSexAtBirthDraft(typeof profile.sexAtBirth === "string" ? profile.sexAtBirth : "");
      onProfileUpdated(profile);
      await loadCandidates(effectiveDateRef.current, profile.revision);
    } catch (caught) {
      if (!requestIsCurrent()) return;
      setMessage(
        `${caught instanceof Error ? caught.message : "Profile fields could not be saved."} Review fresh values before retrying.`,
      );
    } finally {
      if (profileController.current === controller) {
        profileController.current = null;
        setProfileSaving(false);
      }
    }
  }

  function applyReferenceDraft(set: NativeReferenceTargetSet) {
    if (!referenceSets || !referenceAcknowledged) {
      setMessage("Review and accept the exact eligibility acknowledgement before applying.");
      return;
    }
    if (
      referenceSets.date !== builder.effectiveFrom ||
      referenceSets.profileRevision !== profileRevisionRef.current ||
      set.groupCode !== selectedReferenceGroup
    ) {
      setMessage(
        "The profile, group, or effective date changed. Reload the candidate before applying.",
      );
      return;
    }
    setBuilder({
      ...builder,
      targets: nativeReferenceDraftTargets(set),
      reference: {
        selection: nativeReferenceSelection(referenceSets, set),
        expectedProfileRevision: referenceSets.profileRevision,
        policyDigest: set.policyDigest,
      },
    });
    setReferenceCustomized(false);
    const nextMessage =
      "Candidate values are now in a read-only unsaved draft. Create or Publish is still required.";
    setMessage(nextMessage);
    AccessibilityInfo.announceForAccessibility(nextMessage);
  }

  function customizeReferenceDraft(set?: NativeReferenceTargetSet) {
    const targets = set
      ? nativeReferenceDraftTargets(set, true)
      : builder.targets.map((target) => ({
          ...target,
          sourceLabel: `User-customized copy of ${target.sourceLabel}`.slice(0, 160),
          rationale: "User-editable copy; verified reference-template identity cleared.",
        }));
    setBuilder({ ...builder, targets, reference: null });
    setReferenceAcknowledged(false);
    setReferenceCustomized(true);
    const nextMessage =
      "Editable custom targets created; verified template provenance was cleared.";
    setMessage(nextMessage);
    AccessibilityInfo.announceForAccessibility(nextMessage);
  }

  function patchTarget(index: number, patch: Partial<TargetDraft>) {
    if (referenceLocked) return;
    setBuilder({
      ...builder,
      targets: builder.targets.map((target, candidate) =>
        candidate === index ? { ...target, ...patch } : target,
      ),
    });
  }

  function addTarget(definition: TargetableNutrient) {
    if (referenceLocked) return;
    if (
      builder.targets.some((target) => target.definition.nutrientId === definition.nutrientId) ||
      builder.targets.length >= 256
    )
      return;
    setBuilder({
      ...builder,
      targets: [
        ...builder.targets,
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
    });
  }

  async function save() {
    if (verifiedApplied && builder.reference === null && !referenceCustomized) {
      setMessage(
        "Choose Customize explicitly before publishing custom rows from this verified goal.",
      );
      return;
    }
    if (saving || writeController.current) return;
    let body: ReturnType<typeof nativeGoalRequest>;
    try {
      body = nativeGoalRequest(builder, templatesSupported ? expectedOwnerUserId : undefined);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Review the goal fields.");
      return;
    }
    const key = `${builder.goalId ?? "create"}:${builder.revision ?? "new"}:${JSON.stringify(body)}`;
    const operation = prepareStableMutation(pending.current, key, () => body, newOperationId);
    pending.current.set(key, operation);
    const initiatingOwner = expectedOwnerUserId;
    const initiatingEpoch = sessionEpoch;
    const requestGeneration = generation.current;
    const savedDate = date;
    const controller = new AbortController();
    writeController.current = controller;
    const requestIsCurrent = () =>
      writeController.current === controller &&
      !controller.signal.aborted &&
      generation.current === requestGeneration &&
      dateRef.current === savedDate &&
      profileRequestIdentityMatches(
        ownerRef.current,
        epochRef.current,
        initiatingOwner,
        initiatingEpoch,
      );
    setSaving(true);
    setMessage(builder.goalId ? "Publishing an immutable goal revision…" : "Creating goal…");
    try {
      const path = builder.goalId ? `/v1/goals/${builder.goalId}/revisions` : "/v1/goals";
      const response = await fetch(apiUrl(apiBase, path).toString(), {
        method: "POST",
        headers: authenticatedHeaders(accessToken, {
          "content-type": "application/json",
          "idempotency-key": operation.operationId,
          ...(builder.revision ? { "if-match": `"${builder.revision}"` } : {}),
        }),
        body: JSON.stringify(operation.body),
        signal: controller.signal,
      });
      if (!requestIsCurrent()) return;
      if (response.status === 401) return onUnauthorized();
      const responseBody = await jsonBody(response);
      if (!requestIsCurrent()) return;
      if (
        response.status === 409 &&
        ["PROFILE_OWNER_CHANGED", "GOAL_OWNER_CHANGED"].includes(problemCode(responseBody) ?? "")
      ) {
        return onUnauthorized();
      }
      if (response.status === 409 || response.status === 412) {
        pending.current.delete(key);
        const profileResponse = await fetch(apiUrl(apiBase, "/v1/profile").toString(), {
          headers: authenticatedHeaders(accessToken),
          signal: controller.signal,
        });
        if (!requestIsCurrent()) return;
        if (profileResponse.status === 401) return onUnauthorized();
        const profileBody = await jsonBody(profileResponse);
        if (!requestIsCurrent()) return;
        if (profileResponse.ok) {
          const profile = parseProfileResponse(profileBody);
          profileRevisionRef.current = profile.revision;
          setBirthDateDraft(typeof profile.birthDate === "string" ? profile.birthDate : "");
          setSexAtBirthDraft(typeof profile.sexAtBirth === "string" ? profile.sexAtBirth : "");
          onProfileUpdated(profile);
        }
        await load(savedDate);
        if (
          profileRequestIdentityMatches(
            ownerRef.current,
            epochRef.current,
            initiatingOwner,
            initiatingEpoch,
          )
        ) {
          setMessage(
            "The goal or eligibility profile changed elsewhere. Fresh values were loaded for review.",
          );
        }
        return;
      }
      if (!response.ok)
        throw new Error(responseError(responseBody, "The goal could not be saved."));
      const mutation = parseGoalMutation(responseBody);
      if (!requestIsCurrent()) return;
      pending.current.delete(key);
      setGoal(mutation.goal);
      setBuilder(nativeGoalBuilderFromGoal(mutation.goal));
      await load(savedDate);
      setMessage(
        mutation.replayed
          ? "The earlier goal save was confirmed safely."
          : `Goal version ${mutation.goal.versionNumber} published.`,
      );
    } catch (caught) {
      if (!requestIsCurrent()) return;
      setMessage(
        `${caught instanceof Error ? caught.message : "The goal could not be saved."} Press Save again to retry safely.`,
      );
    } finally {
      if (writeController.current === controller) {
        writeController.current = null;
        setSaving(false);
      }
    }
  }

  function beginNewGoal() {
    if (!isLocalDate(date)) {
      setMessage("Choose a real progress date before starting a new goal.");
      return;
    }
    const next = emptyGoal(date);
    effectiveDateRef.current = next.effectiveFrom;
    setBuilder(next);
    setReferenceAcknowledged(false);
    setReferenceCustomized(false);
    setMessage("New goal draft started. Choose its effective date and explicit targets.");
  }

  const available = definitions
    .filter(
      (definition) =>
        !builder.targets.some((target) => target.definition.nutrientId === definition.nutrientId) &&
        `${definition.name} ${definition.code}`
          .toLowerCase()
          .includes(nutrientQuery.trim().toLowerCase()),
    )
    .slice(0, 20);

  return (
    <SafeAreaView edges={["left", "right", "bottom"]} style={styles.screen}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.nav}>
          <Pressable accessibilityRole="button" onPress={onRecipes}>
            <Text style={styles.link}>← Recipes</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => onDiary(date)}>
            <Text style={styles.link}>Diary →</Text>
          </Pressable>
        </View>
        <Text style={styles.kicker}>EXPLAINABLE DAILY TARGETS</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Goals
        </Text>
        <Text style={styles.help}>General wellness estimate; not medical advice.</Text>
        <Text accessibilityLiveRegion="polite" style={styles.status}>
          {message}
        </Text>
        {loading ? <ActivityIndicator color={palette.forest} /> : null}
        {!loading ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void load(date)}
            style={styles.refresh}
          >
            <Text style={styles.link}>Refresh goals and progress</Text>
          </Pressable>
        ) : null}
        <View style={styles.panel}>
          {builder.goalId ? (
            <Pressable
              accessibilityRole="button"
              disabled={saving}
              onPress={beginNewGoal}
              style={styles.refresh}
            >
              <Text style={styles.link}>Start a new goal</Text>
            </Pressable>
          ) : null}
          <Field
            editable={builder.goalId === null && !historicalGoal}
            label="Effective from YYYY-MM-DD"
            value={builder.effectiveFrom}
            maxLength={10}
            onChange={(effectiveFrom) => {
              effectiveDateRef.current = effectiveFrom;
              candidateController.current?.abort();
              setReferenceSets(null);
              setSelectedReferenceGroup("");
              setReferenceAcknowledged(false);
              setBuilder({
                ...builder,
                effectiveFrom,
                ...(builder.reference ? { targets: [], reference: null } : {}),
              });
            }}
            onEnd={() => {
              if (isLocalDate(builder.effectiveFrom)) {
                void loadCandidates(builder.effectiveFrom, profileRevisionRef.current);
              } else {
                setMessage("Effective date must be a real YYYY-MM-DD local date.");
              }
            }}
          />
          {builder.goalId ? (
            <Text style={styles.help}>
              {historicalGoal
                ? "This closed goal is immutable history. Start a new goal to make changes."
                : "A revision keeps the original effective date. Create a new goal to choose another date."}
            </Text>
          ) : null}
          <Text style={styles.sectionTitle}>Energy method</Text>
          <View accessibilityRole="radiogroup" style={styles.row}>
            <Choice
              active={builder.mode === "fixed"}
              disabled={historicalGoal}
              label="Fixed target"
              onPress={() =>
                setBuilder({
                  ...builder,
                  mode: "fixed",
                  fixedKcal: builder.mode === "derived" ? "" : builder.fixedKcal,
                })
              }
            />
            <Choice
              active={builder.mode === "derived"}
              disabled={historicalGoal}
              label="Profile-derived estimate"
              onPress={() =>
                setBuilder({
                  ...builder,
                  mode: "derived",
                  activityLevelCode: builder.mode === "fixed" ? "" : builder.activityLevelCode,
                  activityFactor: builder.mode === "fixed" ? "" : builder.activityFactor,
                  palAcknowledged: builder.mode === "fixed" ? false : builder.palAcknowledged,
                })
              }
            />
          </View>
          {builder.mode === "fixed" ? (
            <Field
              editable={!historicalGoal}
              label="Your selected daily energy (kcal)"
              value={builder.fixedKcal}
              maxLength={19}
              numeric
              onChange={(fixedKcal) => setBuilder({ ...builder, fixedKcal })}
            />
          ) : (
            <View>
              <Text style={styles.label}>PAL category</Text>
              <View style={styles.row}>
                <Choice
                  active={builder.activityLevelCode === "sedentary_or_light"}
                  disabled={historicalGoal}
                  label="Light 1.40–1.69"
                  onPress={() =>
                    setBuilder({
                      ...builder,
                      activityLevelCode: "sedentary_or_light",
                      activityFactor: "",
                      palAcknowledged: false,
                    })
                  }
                />
                <Choice
                  active={builder.activityLevelCode === "active_or_moderate"}
                  disabled={historicalGoal}
                  label="Moderate 1.70–1.99"
                  onPress={() =>
                    setBuilder({
                      ...builder,
                      activityLevelCode: "active_or_moderate",
                      activityFactor: "",
                      palAcknowledged: false,
                    })
                  }
                />
                <Choice
                  active={builder.activityLevelCode === "vigorous"}
                  disabled={historicalGoal}
                  label="Vigorous 2.00–2.40"
                  onPress={() =>
                    setBuilder({
                      ...builder,
                      activityLevelCode: "vigorous",
                      activityFactor: "",
                      palAcknowledged: false,
                    })
                  }
                />
              </View>
              <Field
                editable={!historicalGoal}
                label="PAL factor"
                value={builder.activityFactor}
                maxLength={19}
                numeric
                onChange={(activityFactor) =>
                  setBuilder({ ...builder, activityFactor, palAcknowledged: false })
                }
              />
              <Field
                editable={!historicalGoal}
                label="Adjustment kcal"
                value={builder.adjustmentKcal}
                maxLength={20}
                numeric
                onChange={(adjustmentKcal) => setBuilder({ ...builder, adjustmentKcal })}
              />
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: builder.palAcknowledged, disabled: historicalGoal }}
                disabled={historicalGoal}
                onPress={() =>
                  setBuilder({ ...builder, palAcknowledged: !builder.palAcknowledged })
                }
                style={styles.check}
              >
                <Text style={styles.checkText}>
                  {builder.palAcknowledged ? "☑" : "☐"} PAL represents habitual total activity;
                  ordinary exercise is already included.
                </Text>
              </Pressable>
              <Text style={styles.help}>
                Estimated daily energy = estimated resting energy × PAL + adjustment. It is neither
                measured nor a recommendation.
              </Text>
            </View>
          )}
          <Field
            editable={!historicalGoal}
            label="Why this energy target?"
            value={builder.rationale}
            maxLength={1_000}
            multiline
            onChange={(rationale) => setBuilder({ ...builder, rationale })}
          />
          {nativeReferenceTargetSectionVisible(templatesSupported, referenceSets) ? (
            <View style={styles.candidate}>
              <Text style={styles.kicker}>OPTIONAL SOURCE-VERIFIED CANDIDATE</Text>
              <Text accessibilityRole="header" style={styles.sectionTitle}>
                U.S.–Canada population references
              </Text>
              {verifiedApplied ? <Text style={styles.badge}>Verified on this goal</Text> : null}
              <Text style={styles.help}>
                Choosing a group changes nothing. Apply copies 12 values into this unsaved draft;
                Create or Publish remains a separate action.
              </Text>
              {verifiedApplied && referenceSets?.applied && appliedReferenceSet ? (
                <View accessibilityLiveRegion="polite">
                  <Text style={styles.help}>
                    <Text style={styles.targetTitle}>Applied reference snapshot: </Text>
                    {appliedReferenceSet.title}. Template {appliedReferenceSet.templateVersion}
                    {"; acknowledgement accepted "}
                    {referenceSets.applied.acknowledgement.acceptedAt}. Eligible through the day
                    before {appliedReferenceSet.eligibleThroughExclusive}.
                  </Text>
                  {appliedProfileDrift ? (
                    <Text style={styles.help}>
                      Your profile changed after this snapshot was applied. Its saved values and
                      sources remain visible, but its acknowledgement is not reused. Select the
                      current group, acknowledge it, and Apply again—or choose Customize.
                    </Text>
                  ) : null}
                  {appliedProfileDrift || !selectedReferenceSet ? (
                    <NativeReferenceRows
                      label="Applied 12-value source snapshot"
                      set={appliedReferenceSet}
                    />
                  ) : null}
                </View>
              ) : null}
              {templatesSupported ? (
                <>
                  <Text style={styles.label}>Profile fields used for eligibility</Text>
                  <Field
                    editable={!profileSaving && !saving}
                    label="Birth date YYYY-MM-DD"
                    value={birthDateDraft}
                    maxLength={10}
                    onChange={setBirthDateDraft}
                  />
                  <Text style={styles.label}>Sex at birth</Text>
                  <View accessibilityRole="radiogroup" style={styles.row}>
                    {[
                      ["female", "Female"],
                      ["male", "Male"],
                      ["intersex", "Intersex"],
                      ["not_specified", "Prefer not to specify"],
                    ].map(([value, label]) => (
                      <Choice
                        active={sexAtBirthDraft === value}
                        disabled={profileSaving || saving}
                        key={value}
                        label={label ?? value ?? ""}
                        onPress={() => setSexAtBirthDraft(value ?? "")}
                      />
                    ))}
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: profileSaving || saving }}
                    disabled={profileSaving || saving}
                    onPress={() => void saveProfilePrerequisites()}
                    style={styles.secondary}
                  >
                    <Text style={styles.secondaryText}>
                      {profileSaving ? "Saving profile…" : "Save profile and check eligibility"}
                    </Text>
                  </Pressable>
                  {referenceSets ? (
                    <>
                      <Text style={styles.help}>{referenceSets.notice}</Text>
                      {referenceSets.availability.available ? (
                        <>
                          <Text style={styles.label}>Choose the matching source group</Text>
                          <View accessibilityRole="radiogroup" style={styles.row}>
                            {referenceSets.sets.map((candidate) => (
                              <Choice
                                active={selectedReferenceGroup === candidate.groupCode}
                                disabled={
                                  historicalGoal ||
                                  saving ||
                                  (referenceLocked && !appliedProfileDrift)
                                }
                                key={candidate.groupCode}
                                label={candidate.title}
                                onPress={() => {
                                  setSelectedReferenceGroup(candidate.groupCode);
                                  setReferenceAcknowledged(false);
                                  const nextMessage = `${candidate.title} selected for preview. The goal draft is unchanged.`;
                                  setMessage(nextMessage);
                                  AccessibilityInfo.announceForAccessibility(nextMessage);
                                }}
                              />
                            ))}
                          </View>
                        </>
                      ) : (
                        <Text style={styles.help}>
                          {nativeReferenceAvailability(referenceSets.availability.reasonCodes)}
                        </Text>
                      )}
                      {selectedReferenceSet ? (
                        <View accessibilityLiveRegion="polite">
                          <Text style={styles.help}>
                            This candidate expires on your 51st birthday (
                            {selectedReferenceSet.eligibleThroughExclusive}); the day before is the
                            final eligible day.
                          </Text>
                          <NativeReferenceRows
                            label="12-value candidate preview"
                            set={selectedReferenceSet}
                          />
                          <Pressable
                            accessibilityRole="checkbox"
                            accessibilityState={{
                              checked: referenceAcknowledged,
                              disabled:
                                historicalGoal ||
                                saving ||
                                (referenceLocked && !appliedProfileDrift),
                            }}
                            disabled={
                              historicalGoal || saving || (referenceLocked && !appliedProfileDrift)
                            }
                            onPress={() => setReferenceAcknowledged(!referenceAcknowledged)}
                            style={styles.check}
                          >
                            <Text style={styles.checkText}>
                              {referenceAcknowledged ? "☑" : "☐"}{" "}
                              {referenceSets.acknowledgementPolicy.text}
                            </Text>
                          </Pressable>
                          <Pressable
                            accessibilityLabel="Apply 12 source-verified values to unsaved draft"
                            accessibilityRole="button"
                            accessibilityState={{
                              disabled:
                                historicalGoal ||
                                saving ||
                                (referenceLocked && !appliedProfileDrift) ||
                                !referenceAcknowledged,
                            }}
                            disabled={
                              historicalGoal ||
                              saving ||
                              (referenceLocked && !appliedProfileDrift) ||
                              !referenceAcknowledged
                            }
                            onPress={() => applyReferenceDraft(selectedReferenceSet)}
                            style={styles.secondary}
                          >
                            <Text style={styles.secondaryText}>
                              Apply 12 values to unsaved draft
                            </Text>
                          </Pressable>
                        </View>
                      ) : null}
                      {referenceLocked ? (
                        <Pressable
                          accessibilityRole="button"
                          disabled={historicalGoal || saving}
                          onPress={() =>
                            customizeReferenceDraft(
                              verifiedApplied
                                ? (appliedReferenceSet ?? undefined)
                                : selectedReferenceSet,
                            )
                          }
                          style={styles.secondary}
                        >
                          <Text style={styles.secondaryText}>
                            Customize editable copy and clear verified provenance
                          </Text>
                        </Pressable>
                      ) : null}
                      <Text style={styles.label}>Official sources</Text>
                      {[
                        ["Overview", referenceSets.sources.overviewUrl],
                        ["Macronutrients", referenceSets.sources.macronutrientsUrl],
                        ["Elements", referenceSets.sources.elementsUrl],
                        ["Vitamins", referenceSets.sources.vitaminsUrl],
                        ["Reports", referenceSets.sources.reportListUrl],
                      ].map(([label, url]) => (
                        <Pressable
                          accessibilityRole="link"
                          key={label}
                          onPress={() => void Linking.openURL(url ?? "")}
                        >
                          <Text style={styles.link}>{label}</Text>
                        </Pressable>
                      ))}
                      <Text style={styles.help}>
                        Source snapshot {referenceSets.sources.version}, checked{" "}
                        {referenceSets.sources.reviewedOn}.
                      </Text>
                      <Text style={styles.label}>Important cautions</Text>
                      {referenceSets.cautions.map((caution) => (
                        <Text key={caution.code} style={styles.help}>
                          • {caution.text}
                        </Text>
                      ))}
                    </>
                  ) : (
                    <Text style={styles.help}>
                      Save the profile fields or reload this effective date to check eligibility.
                    </Text>
                  )}
                </>
              ) : (
                <Text style={styles.help}>
                  Candidate templates are not supported by this API version. Manual nutrient goals
                  remain available.
                </Text>
              )}
            </View>
          ) : null}
          <Text style={styles.sectionTitle}>
            Nutrient thresholds ({builder.targets.length}/256)
          </Text>
          {referenceLocked ? (
            <Text style={styles.help}>
              These source-verified candidate rows are read-only. Choose Customize to make an
              editable copy and clear verified provenance.
            </Text>
          ) : (
            <>
              <Field
                editable={!historicalGoal}
                label="Find a nutrient"
                value={nutrientQuery}
                maxLength={100}
                onChange={setNutrientQuery}
              />
              {available.map((definition) => (
                <Pressable
                  accessibilityLabel={`Add ${definition.name} target`}
                  accessibilityRole="button"
                  disabled={historicalGoal}
                  key={definition.nutrientId}
                  onPress={() => addTarget(definition)}
                  style={styles.addRow}
                >
                  <Text style={styles.addName}>{definition.name}</Text>
                  <Text style={styles.link}>Add</Text>
                </Pressable>
              ))}
            </>
          )}
          {builder.targets.map((target, index) => (
            <View key={target.definition.nutrientId} style={styles.target}>
              <Text style={styles.targetTitle}>
                {target.definition.name} ({target.definition.unit})
              </Text>
              <Field
                editable={!historicalGoal && !referenceLocked}
                label={`${target.definition.name} minimum`}
                value={target.minimumAmount}
                maxLength={31}
                numeric
                onChange={(minimumAmount) => patchTarget(index, { minimumAmount })}
              />
              <Field
                editable={!historicalGoal && !referenceLocked}
                label={`${target.definition.name} target`}
                value={target.targetAmount}
                maxLength={31}
                numeric
                onChange={(targetAmount) => patchTarget(index, { targetAmount })}
              />
              <Field
                editable={!historicalGoal && !referenceLocked}
                label={`${target.definition.name} maximum`}
                value={target.maximumAmount}
                maxLength={31}
                numeric
                onChange={(maximumAmount) => patchTarget(index, { maximumAmount })}
              />
              <Field
                editable={!historicalGoal && !referenceLocked}
                label={`${target.definition.name} source (required)`}
                value={target.sourceLabel}
                maxLength={160}
                onChange={(sourceLabel) => patchTarget(index, { sourceLabel })}
              />
              <Field
                editable={!historicalGoal && !referenceLocked}
                label={`${target.definition.name} source version`}
                value={target.sourceVersion}
                maxLength={100}
                onChange={(sourceVersion) => patchTarget(index, { sourceVersion })}
              />
              <Field
                editable={!historicalGoal && !referenceLocked}
                label={`${target.definition.name} rationale`}
                value={target.rationale}
                maxLength={1_000}
                multiline
                onChange={(rationale) => patchTarget(index, { rationale })}
              />
              <Pressable
                accessibilityLabel={`Remove ${target.definition.name} target`}
                accessibilityRole="button"
                disabled={historicalGoal || referenceLocked}
                onPress={() =>
                  setBuilder({
                    ...builder,
                    targets: builder.targets.filter((_, candidate) => candidate !== index),
                  })
                }
              >
                <Text style={styles.danger}>Remove target</Text>
              </Pressable>
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            disabled={
              saving ||
              historicalGoal ||
              (verifiedApplied && builder.reference === null && !referenceCustomized)
            }
            onPress={() => void save()}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>
              {historicalGoal
                ? "Closed goal history is read-only"
                : saving
                  ? "Saving…"
                  : builder.goalId
                    ? "Publish goal revision"
                    : "Create goal"}
            </Text>
          </Pressable>
        </View>
        {goal?.energy.mode === "derived" ? <DerivedEnergy energy={goal.energy} /> : null}
        <View style={styles.panel}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Current-day progress
          </Text>
          <Field
            label="Progress date YYYY-MM-DD"
            value={date}
            maxLength={10}
            onChange={(nextDate) => {
              dateRef.current = nextDate;
              loadController.current?.abort();
              setDate(nextDate);
            }}
            onEnd={() => {
              if (isLocalDate(date)) void load(date);
              else setMessage("Progress date must be a real YYYY-MM-DD local date.");
            }}
          />
          {progress?.energy ? (
            <Progress row={progress.energy} />
          ) : (
            <Text style={styles.help}>No energy comparison is available.</Text>
          )}
          {progress?.nutrients.map((row) => (
            <Progress key={row.nutrientId} row={row} />
          ))}
          <Text style={styles.help}>
            {progress?.notice ?? "General wellness estimate; not medical advice."} Incomplete intake
            is a lower bound, never a measured zero.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function NativeReferenceRows({
  label,
  set,
}: {
  readonly label: string;
  readonly set: NativeReferenceTargetSet;
}) {
  return (
    <View>
      <Text accessibilityRole="header" style={styles.label}>
        {label}
      </Text>
      {set.targets.map((target) => (
        <View key={target.definition.nutrientId} style={styles.previewRow}>
          <Text style={styles.targetTitle}>{target.definition.name}</Text>
          <Text style={styles.help}>
            {target.basis.referenceType.toUpperCase()} target {target.targetAmount}{" "}
            {target.definition.unit}
            {target.maximumAmount
              ? ` · UL ${target.maximumAmount} ${target.definition.unit}`
              : " · no compatible UL copied"}
          </Text>
          <Text style={styles.help}>
            {target.source.version} · {target.source.table}
          </Text>
          <Pressable
            accessibilityLabel={`Open official source for ${target.definition.name}`}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(target.source.url)}
          >
            <Text style={styles.link}>Official source</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function DerivedEnergy({
  energy,
}: {
  readonly energy: Extract<GoalView["energy"], { readonly mode: "derived" }>;
}) {
  return (
    <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Explainable energy estimate
      </Text>
      <Text style={styles.estimate}>{energy.targetKcal} kcal estimated daily energy</Text>
      <Text style={styles.help}>
        {energy.bmrKcal} kcal estimated resting energy; profile revision {energy.profileRevision},
        age {energy.ageYears}, {energy.heightCm} cm, {energy.weightKg} kg, PAL{" "}
        {energy.activityFactor}, adjustment {energy.adjustmentKcal} kcal. Ordinary exercise is
        already represented.
      </Text>
      <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(energy.sourceUrl)}>
        <Text style={styles.link}>{energy.equationLabel}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="link"
        onPress={() => void Linking.openURL(energy.activitySourceUrl)}
      >
        <Text style={styles.link}>Reviewed PAL source</Text>
      </Pressable>
    </View>
  );
}

function Progress({ row }: { readonly row: GoalProgressRowView }) {
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
    <View accessible accessibilityLabel={view.accessibilityLabel} style={styles.progress}>
      <View style={styles.progressHead}>
        <Text style={styles.progressName}>{row.name}</Text>
        <Text style={styles.progressValue}>{view.valueText}</Text>
      </View>
      {view.progressPercent !== null ? (
        <View accessibilityElementsHidden style={styles.track}>
          <View style={[styles.fill, { width: `${view.progressPercent}%` }]} />
        </View>
      ) : null}
      <Text style={styles.help}>
        {view.targetText} · {view.coverageText}
        {row.minimum ? ` · minimum ${row.minimum.state}` : ""}
        {row.maximum ? ` · maximum ${row.maximum.state}` : ""}
      </Text>
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  maxLength,
  numeric = false,
  multiline = false,
  onEnd,
  editable = true,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly maxLength: number;
  readonly numeric?: boolean;
  readonly multiline?: boolean;
  readonly onEnd?: () => void;
  readonly editable?: boolean;
}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        editable={editable}
        keyboardType={numeric ? "decimal-pad" : "default"}
        maxLength={maxLength}
        multiline={multiline}
        onChangeText={onChange}
        onEndEditing={onEnd}
        style={[styles.input, multiline && styles.multiline, !editable && styles.readonly]}
        value={value}
      />
    </View>
  );
}

function Choice({
  active,
  disabled = false,
  label,
  onPress,
}: {
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.choice, active && styles.choiceActive]}
    >
      <Text style={[styles.choiceText, active && styles.choiceTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  addName: { color: palette.ink, flex: 1, fontSize: 14, fontWeight: "700" },
  addRow: {
    alignItems: "center",
    borderBottomColor: palette.line,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 10,
    paddingVertical: 11,
  },
  badge: {
    alignSelf: "flex-start",
    backgroundColor: "#e7f1df",
    borderRadius: 999,
    color: palette.forest,
    fontSize: 11,
    fontWeight: "800",
    marginTop: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  candidate: {
    backgroundColor: "#f7f8f3",
    borderColor: palette.line,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 20,
    padding: 14,
  },
  check: { borderColor: palette.line, borderRadius: 9, borderWidth: 1, marginTop: 14, padding: 12 },
  checkText: { color: palette.ink, fontSize: 13, lineHeight: 19 },
  choice: {
    borderColor: palette.line,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  choiceActive: { backgroundColor: palette.forest, borderColor: palette.forest },
  choiceText: { color: palette.muted, fontSize: 12, fontWeight: "700" },
  choiceTextActive: { color: palette.white },
  content: { padding: 22, paddingBottom: 72 },
  danger: { color: "#8a3128", fontSize: 13, fontWeight: "800", marginTop: 10 },
  estimate: { color: palette.ink, fontSize: 19, fontWeight: "800" },
  fill: { backgroundColor: palette.lime, borderRadius: 999, height: 8 },
  help: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 8 },
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
  kicker: { color: palette.forest, fontSize: 11, fontWeight: "800", letterSpacing: 1.4 },
  label: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: "800",
    marginBottom: 6,
    marginTop: 13,
    textTransform: "uppercase",
  },
  link: { color: palette.forest, fontSize: 13, fontWeight: "800", textDecorationLine: "underline" },
  multiline: { minHeight: 82, paddingTop: 12, textAlignVertical: "top" },
  nav: { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
  panel: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 24,
    padding: 18,
  },
  primary: {
    alignSelf: "flex-start",
    backgroundColor: palette.forest,
    borderRadius: 9,
    marginTop: 18,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  primaryText: { color: palette.white, fontSize: 13, fontWeight: "800" },
  progress: { borderTopColor: palette.line, borderTopWidth: 1, paddingVertical: 13 },
  progressHead: { flexDirection: "row", gap: 10, justifyContent: "space-between" },
  progressName: { color: palette.ink, flex: 1, fontSize: 14, fontWeight: "700" },
  progressValue: { color: palette.ink, fontSize: 13, fontWeight: "800" },
  previewRow: { borderTopColor: palette.line, borderTopWidth: 1, paddingVertical: 10 },
  readonly: { backgroundColor: "#f0f1ec", color: palette.muted },
  refresh: { alignSelf: "flex-start", paddingVertical: 6 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  screen: { backgroundColor: palette.paper, flex: 1 },
  secondary: {
    alignSelf: "flex-start",
    borderColor: palette.forest,
    borderRadius: 9,
    borderWidth: 1,
    marginTop: 14,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  secondaryText: { color: palette.forest, fontSize: 12, fontWeight: "800" },
  sectionTitle: {
    color: palette.ink,
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.5,
    marginBottom: 8,
    marginTop: 18,
  },
  status: { color: palette.muted, fontSize: 14, lineHeight: 20, marginVertical: 16 },
  target: { borderTopColor: palette.line, borderTopWidth: 1, marginTop: 16, paddingTop: 14 },
  targetTitle: { color: palette.ink, fontSize: 17, fontWeight: "800" },
  title: { color: palette.ink, fontSize: 42, fontWeight: "700", letterSpacing: -1.6, marginTop: 8 },
  track: {
    backgroundColor: "#e4e7df",
    borderRadius: 999,
    height: 8,
    marginTop: 8,
    overflow: "hidden",
  },
});
