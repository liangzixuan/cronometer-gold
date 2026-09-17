import {
  type DayNote,
  isDayNoteText,
  matchesDayNoteMutation,
  parseDayNoteMutationResponse,
  parseDayNoteResponse,
} from "@nutrition-tracker/contracts";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { apiUrl, authenticatedHeaders, jsonBody } from "../api/private-api";
import { newOperationId } from "../auth/operation-id";
import { palette } from "../theme";
import { isLocalDate, type ProfileSummary, parseSession } from "./diary";
import { savedNotePrefix } from "./saved-note-preview";

interface Props {
  readonly apiBase: URL;
  readonly accessToken: string;
  readonly ownerUserId: string;
  readonly sessionEpoch: number;
  readonly localDate: string;
  readonly profileTimeZone: string;
  readonly profileBusy: boolean;
  readonly isSessionCurrent: (owner: string, epoch: number) => boolean;
  readonly isDateCurrent: (date: string) => boolean;
  readonly onReturn: (date: string) => void;
  readonly onProfileUpdated: (profile: ProfileSummary) => void;
  readonly onUnauthorized: () => Promise<void>;
}

interface Draft {
  readonly baseline: DayNote;
  readonly raw: string;
  readonly zone: string;
  readonly phase: "editing" | "conflict" | "review" | "reconciling";
  readonly latest: DayNote | null;
}
interface Operation {
  readonly operationId: string;
  readonly ownerUserId: string;
  readonly localDate: string;
  readonly expectedRevision: string;
  readonly expectedProfileTimeZone: string;
  readonly note: string | null;
  readonly noteId: string | null;
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}
interface NoteRead {
  readonly date: string;
  readonly status: "loading" | "ready" | "error";
  readonly note: DayNote | null;
}
interface Model {
  readonly read: NoteRead;
  readonly draft: Draft | null;
  readonly operation: Operation | null;
  readonly message: string;
}
const empty = (date: string): Model => ({
  read: { date, status: "loading", note: null },
  draft: null,
  operation: null,
  message: "",
});
function problemCode(body: unknown): string | null {
  return typeof body === "object" &&
    body !== null &&
    "code" in body &&
    typeof body.code === "string"
    ? body.code
    : null;
}
function noteFromRaw(raw: string): string | null {
  if (raw === "") return null;
  if (!isDayNoteText(raw)) {
    throw new Error("Use up to 2,000 characters without invalid text characters.");
  }
  return raw;
}

export function DiaryDayNote(props: Props) {
  const [, redraw] = useState(0);
  const propsRef = useRef(props);
  propsRef.current = props;
  const scopeKey = JSON.stringify([
    props.apiBase.href,
    props.ownerUserId,
    props.sessionEpoch,
    props.isSessionCurrent(props.ownerUserId, props.sessionEpoch),
  ]);
  const scope = useRef({ key: scopeKey });
  const model = useRef<Model>(empty(props.localDate));
  const view = useRef({ date: props.localDate });
  const lifecycle = useRef({
    mounted: false,
    active: AppState.currentState === "active",
    epoch: 0,
  });
  const reads = useRef<{ view: AbortController | null; recovery: AbortController | null }>({
    view: null,
    recovery: null,
  });
  const flight = useRef<{ operation: Operation; controller: AbortController } | null>(null);
  const recovery = useRef(false);
  const expansion = useRef({ key: "", expanded: false });
  if (scope.current.key !== scopeKey) {
    scope.current = { key: scopeKey };
    model.current = empty(props.localDate);
    reads.current.view?.abort();
    reads.current.recovery?.abort();
    flight.current?.controller.abort();
    flight.current = null;
    recovery.current = false;
  }
  if (view.current.date !== props.localDate) view.current = { date: props.localDate };
  const renderedScope = scope.current;
  const renderedView = view.current;
  const renderedEpoch = lifecycle.current.epoch;
  const renderedModel = model.current;
  const renderedDraft = renderedModel.draft;

  function currentPrivate() {
    const current = propsRef.current;
    return (
      lifecycle.current.mounted &&
      scope.current === renderedScope &&
      current.isSessionCurrent(current.ownerUserId, current.sessionEpoch)
    );
  }
  function currentView() {
    return (
      currentPrivate() &&
      lifecycle.current.active &&
      lifecycle.current.epoch === renderedEpoch &&
      view.current === renderedView &&
      propsRef.current.isDateCurrent(renderedView.date)
    );
  }
  function publish(next: Model) {
    if (!currentPrivate()) return;
    model.current = next;
    redraw((value) => value + 1);
  }
  function canUseDraft() {
    return (
      currentView() &&
      model.current.draft === renderedDraft &&
      !propsRef.current.profileBusy &&
      !flight.current &&
      !recovery.current
    );
  }
  async function closePrivate() {
    if (!currentPrivate()) return;
    model.current = empty("");
    reads.current.view?.abort();
    reads.current.recovery?.abort();
    flight.current?.controller.abort();
    flight.current = null;
    redraw((value) => value + 1);
    await propsRef.current.onUnauthorized();
  }

  async function load(
    date: string,
    purpose: "view" | "reconcile" | "review" = "view",
    expectedDraft = model.current.draft,
  ) {
    if (!currentPrivate() || !lifecycle.current.active || !isLocalDate(date)) return;
    if (purpose === "view" && !propsRef.current.isDateCurrent(date)) return;
    const channel = purpose === "view" ? "view" : "recovery";
    if (purpose === "review") {
      reads.current.view?.abort();
      reads.current.view = null;
    }
    reads.current[channel]?.abort();
    const controller = new AbortController();
    reads.current[channel] = controller;
    const requestView = view.current;
    const requestEpoch = lifecycle.current.epoch;
    const ownsRead = () =>
      currentPrivate() &&
      !controller.signal.aborted &&
      reads.current[channel] === controller &&
      lifecycle.current.epoch === requestEpoch &&
      lifecycle.current.active &&
      (purpose !== "view" ||
        (view.current === requestView && propsRef.current.isDateCurrent(date))) &&
      (purpose === "view" || model.current.draft === expectedDraft);
    if (purpose === "view")
      publish({ ...model.current, read: { date, status: "loading", note: null } });
    else {
      recovery.current = true;
      redraw((value) => value + 1);
    }
    try {
      let zone = propsRef.current.profileTimeZone;
      if (purpose === "review") {
        const sessionResponse = await fetch(apiUrl(props.apiBase, "/v1/auth/me").toString(), {
          headers: authenticatedHeaders(propsRef.current.accessToken),
          signal: controller.signal,
        });
        if (!ownsRead()) return;
        if (sessionResponse.status === 401) return await closePrivate();
        const sessionBody = await jsonBody(sessionResponse);
        if (!ownsRead()) return;
        if (!sessionResponse.ok)
          throw new Error(
            "Your current profile could not be verified. Try loading the note again.",
          );
        const session = parseSession(sessionBody);
        if (session.user.id !== propsRef.current.ownerUserId) return await closePrivate();
        zone = session.profile.timeZone;
        propsRef.current.onProfileUpdated(session.profile);
      }
      const response = await fetch(
        apiUrl(props.apiBase, `/v1/diary/day-notes/${date}`).toString(),
        {
          headers: authenticatedHeaders(propsRef.current.accessToken, {
            "x-expected-owner-user-id": props.ownerUserId,
          }),
          signal: controller.signal,
        },
      );
      if (!ownsRead()) return;
      if (response.status === 401) return await closePrivate();
      const body = await jsonBody(response);
      if (!ownsRead()) return;
      if (response.status === 409 && problemCode(body) === "DAY_NOTE_OWNER_CHANGED")
        return await closePrivate();
      if (!response.ok) throw new Error("The day note could not be loaded. Try again.");
      let note = parseDayNoteResponse(body).data;
      if (
        note.ownerUserId !== props.ownerUserId ||
        note.localDate !== date ||
        response.headers.get("etag") !== `"${note.revision}"`
      )
        throw new Error("The day note could not be verified. Try loading it again.");
      if (!ownsRead()) return;
      const next = model.current;
      if (
        next.read.note?.localDate === date &&
        BigInt(next.read.note.revision) > BigInt(note.revision)
      )
        note = next.read.note;
      const read =
        view.current.date === date ? { date, status: "ready" as const, note } : next.read;
      publish({
        ...next,
        read,
        ...(purpose === "review" && expectedDraft
          ? {
              draft: { ...expectedDraft, phase: "review" as const, latest: note, zone },
              message:
                "Review the latest saved note. Keeping your draft means the next Save will replace that text.",
            }
          : purpose === "reconcile"
            ? {
                draft: null,
                message: `Saved note for ${date} checked against its current version.`,
              }
            : next.draft?.latest?.localDate === date && next.draft.latest.revision !== note.revision
              ? {
                  draft: { ...next.draft, phase: "conflict" as const, latest: null },
                  message:
                    "The saved note changed again. Reload it before choosing which note to keep.",
                }
              : {}),
      });
    } catch {
      if (!ownsRead()) return;
      publish({
        ...model.current,
        ...(purpose === "view" ? { read: { date, status: "error", note: null } } : {}),
        message:
          purpose === "reconcile"
            ? `Your save for ${date} was accepted. Reload the saved note to see its current text.`
            : "The day note could not be loaded. Your draft has been kept. Try again.",
      });
    } finally {
      if (reads.current[channel] === controller) {
        reads.current[channel] = null;
        if (channel === "recovery") recovery.current = false;
        if (currentPrivate()) redraw((value) => value + 1);
      }
    }
  }

  async function save() {
    if (!canUseDraft() || !renderedDraft || renderedDraft.baseline.localDate !== props.localDate)
      return;
    const existing = model.current.operation;
    if (!existing && renderedDraft.phase !== "editing") return;
    let operation = existing;
    if (!operation) {
      if (renderedDraft.zone !== propsRef.current.profileTimeZone) {
        publish({
          ...model.current,
          draft: { ...renderedDraft, phase: "conflict" },
          message:
            "Your profile time zone changed. Reload the current note before reviewing your draft.",
        });
        return;
      }
      let note: string | null;
      try {
        note = noteFromRaw(renderedDraft.raw);
      } catch (error) {
        publish({
          ...model.current,
          message: error instanceof Error ? error.message : "Check your note text.",
        });
        return;
      }
      if (note === renderedDraft.baseline.note) return;
      let operationId: string;
      try {
        operationId = newOperationId();
      } catch {
        publish({
          ...model.current,
          message: "The save could not be started. Your draft has been kept.",
        });
        return;
      }
      operation = {
        operationId,
        ownerUserId: props.ownerUserId,
        localDate: renderedDraft.baseline.localDate,
        expectedRevision: renderedDraft.baseline.revision,
        expectedProfileTimeZone: renderedDraft.zone,
        note,
        noteId: renderedDraft.baseline.id,
        url: apiUrl(
          props.apiBase,
          `/v1/diary/day-notes/${renderedDraft.baseline.localDate}`,
        ).toString(),
        body: JSON.stringify({ note }),
        headers: {
          "content-type": "application/json",
          "x-expected-owner-user-id": props.ownerUserId,
          "x-expected-profile-time-zone": renderedDraft.zone,
          "if-match": `"${renderedDraft.baseline.revision}"`,
          "idempotency-key": operationId,
        },
      };
      publish({ ...model.current, operation });
    }
    const captured = operation;
    const controller = new AbortController();
    const attempt = { operation: captured, controller };
    flight.current = attempt;
    publish({ ...model.current, message: `Saving your note for ${captured.localDate}…` });
    const ownsOperation = () => currentPrivate() && model.current.operation === captured;
    try {
      const response = await fetch(captured.url, {
        method: "PUT",
        headers: authenticatedHeaders(propsRef.current.accessToken, captured.headers),
        body: captured.body,
        signal: controller.signal,
      });
      if (!ownsOperation()) return;
      if (response.status === 401) return await closePrivate();
      const body = await jsonBody(response);
      if (!ownsOperation()) return;
      const code = problemCode(body);
      if (response.status === 409 && code === "DAY_NOTE_OWNER_CHANGED") return await closePrivate();
      if (
        (response.status === 412 && code === "DAY_NOTE_REVISION_CONFLICT") ||
        (response.status === 409 && code === "DAY_NOTE_TIME_ZONE_CHANGED")
      ) {
        publish({
          ...model.current,
          operation: null,
          draft: { ...renderedDraft, phase: "conflict" },
          message:
            "The saved note or your time zone changed. Reload the current note, then review your draft before saving.",
        });
        return;
      }
      if (response.status !== 200) throw new Error("Unverified save");
      const mutation = parseDayNoteMutationResponse(body);
      if (
        !matchesDayNoteMutation(mutation, captured) ||
        response.headers.get("etag") !== `"${mutation.data.note.revision}"`
      )
        throw new Error("Unverified save");
      if (!ownsOperation()) return;
      const draft: Draft = { ...renderedDraft, phase: "reconciling" };
      if (view.current.date === captured.localDate) reads.current.view?.abort();
      publish({
        ...model.current,
        operation: null,
        draft,
        message: `Your note for ${captured.localDate} was saved. Checking its current text…`,
      });
      await load(captured.localDate, "reconcile", draft);
    } catch {
      if (ownsOperation())
        publish({
          ...model.current,
          message: `The save for ${captured.localDate} could not be confirmed. Retry the same save; your exact text has been kept.`,
        });
    } finally {
      if (flight.current === attempt) {
        flight.current = null;
        if (currentPrivate()) redraw((value) => value + 1);
      }
    }
  }

  useEffect(() => {
    lifecycle.current.mounted = true;
    lifecycle.current.active = AppState.currentState === "active";
    const subscription = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      if (active === lifecycle.current.active) return;
      lifecycle.current.active = active;
      lifecycle.current.epoch += 1;
      reads.current.view?.abort();
      reads.current.recovery?.abort();
      recovery.current = false;
      redraw((value) => value + 1);
    });
    return () => {
      lifecycle.current.mounted = false;
      lifecycle.current.epoch += 1;
      reads.current.view?.abort();
      reads.current.recovery?.abort();
      flight.current?.controller.abort();
      flight.current = null;
      model.current = empty("");
      subscription.remove();
    };
  }, []);
  const currentLoad = useRef(load);
  currentLoad.current = load;
  const readIdentity = JSON.stringify([
    scopeKey,
    props.localDate,
    props.isDateCurrent(props.localDate),
    props.accessToken,
    props.profileTimeZone,
    renderedEpoch,
  ]);
  useEffect(() => {
    void readIdentity;
    void currentLoad.current(propsRef.current.localDate);
    return () => reads.current.view?.abort();
  }, [readIdentity]);

  if (
    !props.isSessionCurrent(props.ownerUserId, props.sessionEpoch) ||
    !props.isDateCurrent(props.localDate) ||
    !lifecycle.current.active ||
    !isLocalDate(props.localDate)
  )
    return null;
  const draft = renderedDraft;
  const head =
    renderedModel.read.date === props.localDate && renderedModel.read.status === "ready"
      ? renderedModel.read.note
      : null;
  const away = draft !== null && draft.baseline.localDate !== props.localDate;
  const busy = flight.current !== null || recovery.current || props.profileBusy;
  const canEdit =
    draft !== null && draft.phase === "editing" && renderedModel.operation === null && !busy;
  const previewKey = JSON.stringify([
    scopeKey,
    renderedEpoch,
    props.localDate,
    head?.id,
    head?.revision,
  ]);
  if (expansion.current.key !== previewKey)
    expansion.current = { key: previewKey, expanded: false };
  const renderedExpansion = expansion.current;
  const prefix = head?.note == null ? null : savedNotePrefix(head.note);
  const shortened = prefix !== null && prefix !== head?.note;
  const button = (label: string, action: () => void, disabled = false, expanded?: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, ...(expanded === undefined ? {} : { expanded }) }}
      disabled={disabled}
      onPress={() => {
        if (!disabled && currentView()) action();
      }}
      style={[styles.button, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={styles.card} accessibilityLabel={`Private day note for ${props.localDate}`}>
      <Text accessibilityRole="header" style={styles.title}>
        Private day note
      </Text>
      <Text style={styles.help}>
        For {props.localDate}. A note never changes your food or nutrition totals.
      </Text>
      {head ? (
        <>
          <Text style={styles.saved}>
            {shortened && !renderedExpansion.expanded
              ? `${prefix}…`
              : (head.note ??
                (head.revision === "0"
                  ? "No note for this day yet."
                  : "The note for this day was cleared."))}
          </Text>
          {shortened
            ? button(
                renderedExpansion.expanded ? "Show less" : "Show full note",
                () => {
                  if (model.current !== renderedModel || expansion.current !== renderedExpansion)
                    return;
                  expansion.current = {
                    ...renderedExpansion,
                    expanded: !renderedExpansion.expanded,
                  };
                  redraw((value) => value + 1);
                },
                false,
                renderedExpansion.expanded,
              )
            : null}
          {head.recordedTimeZone ? (
            <Text style={styles.help}>
              Saved in {head.recordedTimeZone}. Current time zone: {props.profileTimeZone}.
            </Text>
          ) : null}
        </>
      ) : renderedModel.read.date !== props.localDate || renderedModel.read.status === "loading" ? (
        <ActivityIndicator
          accessibilityLabel={`Loading day note for ${props.localDate}`}
          color={palette.forest}
        />
      ) : (
        <Text style={styles.help}>Day notes are unavailable. Try loading again.</Text>
      )}
      {renderedModel.message ? (
        <Text accessibilityLiveRegion="polite" style={styles.status}>
          {renderedModel.message}
        </Text>
      ) : null}
      {away && draft ? (
        <>
          <Text style={styles.help}>
            Your {renderedModel.operation ? "unconfirmed save" : "draft"} belongs to{" "}
            {draft.baseline.localDate}. Return to finish it before starting another note.
          </Text>
          {button(
            `Return to note for ${draft.baseline.localDate}`,
            () => {
              if (currentView() && model.current.draft === draft && !propsRef.current.profileBusy)
                propsRef.current.onReturn(draft.baseline.localDate);
            },
            props.profileBusy,
          )}
          {!renderedModel.operation && draft.phase !== "reconciling"
            ? button(
                "Discard note draft",
                () => {
                  if (canUseDraft())
                    publish({ ...model.current, draft: null, message: "Note draft discarded." });
                },
                busy,
              )
            : null}
        </>
      ) : draft ? (
        <>
          <Text style={styles.label}>Your note for {draft.baseline.localDate}</Text>
          <TextInput
            accessibilityLabel={`Day note text for ${draft.baseline.localDate}`}
            accessibilityHint="Changes are saved only when you choose Save note."
            multiline
            editable={canEdit}
            onChangeText={(raw) => {
              if (canUseDraft() && canEdit && raw !== draft.raw)
                publish({ ...model.current, draft: { ...draft, raw }, message: "" });
            }}
            value={draft.raw}
            style={styles.input}
            textAlignVertical="top"
          />
          <Text style={styles.help}>
            {[...draft.raw].length.toLocaleString()} / 2,000 characters. Save context: {draft.zone}.
          </Text>
          <Text style={styles.help}>
            Clearing and saving hides current text. Earlier text stays in your private account
            export until account erasure.
          </Text>
          {draft.phase === "review" && draft.latest ? (
            <>
              <Text style={styles.label}>Latest saved note</Text>
              <Text style={styles.saved}>{draft.latest.note ?? "No current text."}</Text>
              {button(
                "Keep my draft",
                () => {
                  if (canUseDraft() && draft.latest)
                    publish({
                      ...model.current,
                      draft: { ...draft, baseline: draft.latest, phase: "editing", latest: null },
                      message: "Your draft is kept. Save note will replace the latest saved text.",
                    });
                },
                busy,
              )}
              {button(
                "Use saved note",
                () => {
                  if (canUseDraft())
                    publish({
                      ...model.current,
                      draft: null,
                      message: "Showing the latest saved note.",
                    });
                },
                busy,
              )}
            </>
          ) : draft.phase === "conflict" ? (
            button(
              "Reload current note",
              () => {
                if (canUseDraft()) void load(draft.baseline.localDate, "review", draft);
              },
              busy,
            )
          ) : draft.phase === "reconciling" ? (
            button(
              "Reload saved note",
              () => {
                if (canUseDraft()) void load(draft.baseline.localDate, "reconcile", draft);
              },
              busy,
            )
          ) : (
            <>
              {button(
                renderedModel.operation ? "Retry same note save" : "Save note",
                () => void save(),
                busy || (!renderedModel.operation && draft.raw === (draft.baseline.note ?? "")),
              )}
              {button(
                "Clear note field",
                () => {
                  if (canUseDraft() && canEdit && draft.raw !== "")
                    publish({
                      ...model.current,
                      draft: { ...draft, raw: "" },
                      message: "Field cleared. Choose Save note to clear the saved text.",
                    });
                },
                !canEdit || draft.raw === "",
              )}
            </>
          )}
          {!renderedModel.operation && draft.phase !== "reconciling"
            ? button(
                "Cancel note editing",
                () => {
                  if (canUseDraft())
                    publish({ ...model.current, draft: null, message: "Note changes cancelled." });
                },
                busy,
              )
            : null}
        </>
      ) : head ? (
        button(
          head.note === null ? "Add day note" : "Edit day note",
          () => {
            if (currentView() && model.current === renderedModel && !propsRef.current.profileBusy)
              publish({
                ...model.current,
                draft: {
                  baseline: head,
                  raw: head.note ?? "",
                  zone: propsRef.current.profileTimeZone,
                  phase: "editing",
                  latest: null,
                },
                message: "",
              });
          },
          busy,
        )
      ) : null}
      {!draft
        ? button(
            "Reload day note",
            () => {
              if (currentView() && model.current === renderedModel && !flight.current)
                void load(props.localDate);
            },
            busy ||
              (renderedModel.read.date === props.localDate &&
                renderedModel.read.status === "loading"),
          )
        : null}
      <Text style={styles.help}>
        Online only. Unsaved changes and unconfirmed saves are kept only while this diary stays
        open.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.white,
    borderColor: palette.line,
    borderWidth: 1,
    borderRadius: 18,
    padding: 18,
    gap: 10,
    marginVertical: 18,
  },
  title: { color: palette.ink, fontSize: 20, fontWeight: "700" },
  label: { color: palette.ink, fontSize: 14, fontWeight: "700" },
  help: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  saved: { color: palette.ink, fontSize: 15, lineHeight: 22 },
  status: { color: palette.forest, fontSize: 14, lineHeight: 20 },
  input: {
    borderColor: palette.line,
    borderWidth: 1,
    borderRadius: 12,
    backgroundColor: palette.white,
    color: palette.ink,
    padding: 12,
    minHeight: 120,
    fontSize: 15,
    lineHeight: 22,
  },
  button: {
    borderColor: palette.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
  },
  buttonText: { color: palette.forest, fontSize: 14, fontWeight: "700" },
  disabled: { opacity: 0.45 },
});
