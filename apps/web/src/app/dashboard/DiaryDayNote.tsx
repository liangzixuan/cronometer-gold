"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  type DayNote,
  type DayNoteOperation,
  dayNotePath,
  dayNoteText,
  prepareDayNoteOperation,
  readDayNote,
  readDayNoteMutation,
} from "../../lib/day-notes";
import { isLocalDate, parseSession, type SessionSummary } from "../../lib/diary";

export interface DiaryDayNoteProps {
  readonly session: SessionSummary;
  readonly localDate: string;
  readonly privateGeneration: number;
  readonly isPrivateCurrent: () => boolean;
  readonly isViewCurrent: () => boolean;
  readonly onUnauthorized: () => void;
  readonly onReturn: (date: string) => void;
}

interface Draft {
  readonly base: DayNote;
  readonly raw: string;
}
interface Snapshot {
  readonly date: string;
  readonly phase: "loading" | "ready" | "error";
  readonly note: DayNote | null;
}
interface Conflict {
  readonly date: string;
  readonly ready: {
    readonly note: DayNote;
    readonly zone: string;
    readonly source: SessionSummary;
  } | null;
}
interface Acknowledgement {
  readonly date: string;
  readonly failed: boolean;
}
interface NoteState {
  readonly snapshot: Snapshot;
  readonly draft: Draft | null;
  readonly operation: DayNoteOperation | null;
  readonly busy: boolean;
  readonly conflict: Conflict | null;
  readonly acknowledgement: Acknowledgement | null;
  readonly message: string;
}
const initial = (date: string): NoteState => ({
  snapshot: { date, phase: "loading", note: null },
  draft: null,
  operation: null,
  busy: false,
  conflict: null,
  acknowledgement: null,
  message: "Loading your day note…",
});
async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
function code(value: unknown): string | null {
  return value && typeof value === "object" && "code" in value && typeof value.code === "string"
    ? value.code
    : null;
}

export function DiaryDayNote(props: DiaryDayNoteProps) {
  const [rendered, setRendered] = useState(() => initial(props.localDate));
  const stateRef = useRef(rendered);
  const propsRef = useRef(props);
  propsRef.current = props;
  const key = `${props.session.user.id}:${props.privateGeneration}`;
  const scopeRef = useRef({ key, ownerUserId: props.session.user.id });
  const mounted = useRef(false);
  const visible = useRef(true);
  const lifecycle = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const viewRead = useRef<object | null>(null);
  const zoneOverride = useRef<{ readonly source: SessionSummary; readonly zone: string } | null>(
    null,
  );
  const input = useRef<HTMLTextAreaElement | null>(null);
  const pendingFocus = useRef<{
    readonly state: NoteState;
    readonly props: DiaryDayNoteProps;
    readonly epoch: number;
  } | null>(null);
  if (scopeRef.current.key !== key) {
    scopeRef.current = { key, ownerUserId: props.session.user.id };
    stateRef.current = initial(props.localDate);
    zoneOverride.current = null;
    pendingFocus.current = null;
    viewRead.current = null;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
  }
  const scope = scopeRef.current;
  const state = stateRef.current;
  const epoch = lifecycle.current;
  const viewCurrent = props.isViewCurrent();
  const install = useCallback((next: NoteState) => {
    stateRef.current = next;
    setRendered(next);
  }, []);
  const privateCurrent = useCallback(
    () => mounted.current && scopeRef.current === scope && propsRef.current.isPrivateCurrent(),
    [scope],
  );
  function canInteract() {
    return (
      privateCurrent() &&
      propsRef.current === props &&
      props.isViewCurrent() &&
      lifecycle.current === epoch &&
      visible.current &&
      (typeof document === "undefined" || document.visibilityState !== "hidden")
    );
  }
  function currentState() {
    return canInteract() && stateRef.current === state;
  }
  const closeIfCurrent = useCallback(() => {
    if (privateCurrent()) propsRef.current.onUnauthorized();
  }, [privateCurrent]);

  const load = useCallback(
    async (date: string, acknowledgement: Acknowledgement | null = null) => {
      if (!privateCurrent() || !isLocalDate(date)) return;
      const controller = new AbortController();
      controllers.current.add(controller);
      const ticket = {};
      const displaysDate = propsRef.current.localDate === date;
      if (displaysDate) {
        viewRead.current = ticket;
        install({ ...stateRef.current, snapshot: { date, phase: "loading", note: null } });
      }
      const eligible = () =>
        privateCurrent() &&
        !controller.signal.aborted &&
        (acknowledgement
          ? stateRef.current.acknowledgement === acknowledgement
          : viewRead.current === ticket &&
            propsRef.current.localDate === date &&
            propsRef.current.isViewCurrent());
      try {
        const response = await fetch(dayNotePath(date), {
          headers: { accept: "application/json", "x-expected-owner-user-id": scope.ownerUserId },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!eligible()) return;
        if (response.status === 401) return closeIfCurrent();
        const body = await json(response);
        if (!eligible()) return;
        if (response.status === 409 && code(body) === "DAY_NOTE_OWNER_CHANGED")
          return closeIfCurrent();
        if (response.status !== 200) throw new Error("Note unavailable.");
        const note = readDayNote(body, response.headers.get("etag"), scope.ownerUserId, date);
        const current = stateRef.current;
        const mayInstall =
          viewRead.current === ticket &&
          propsRef.current.localDate === date &&
          propsRef.current.isViewCurrent();
        install({
          ...current,
          ...(current.conflict?.date === date &&
          current.conflict.ready &&
          current.conflict.ready.note.revision !== note.revision
            ? {
                conflict: { date, ready: null },
                message:
                  "The saved note changed again. Review it before choosing which note to keep.",
              }
            : {}),
          ...(mayInstall ? { snapshot: { date, phase: "ready", note } as const } : {}),
          ...(acknowledgement
            ? {
                acknowledgement: null,
                message: `Note saved for ${date}. Current saved state checked.`,
              }
            : !current.draft && !current.operation && !current.conflict && !current.acknowledgement
              ? {
                  message:
                    note.revision === "0"
                      ? "No day note saved yet."
                      : note.note === null
                        ? "This day note was cleared."
                        : "Saved day note loaded.",
                }
              : {}),
        });
      } catch {
        if (!eligible()) return;
        install({
          ...stateRef.current,
          ...(viewRead.current === ticket && propsRef.current.localDate === date
            ? { snapshot: { date, phase: "error", note: null } as const }
            : {}),
          ...(acknowledgement
            ? {
                acknowledgement: { date, failed: true },
                message: `Your save for ${date} was acknowledged. The current note could not be reloaded; retry the read.`,
              }
            : {
                message:
                  "The day note could not be loaded. Your existing diary is still available.",
              }),
        });
      } finally {
        controllers.current.delete(controller);
      }
    },
    [privateCurrent, scope, install, closeIfCurrent],
  );

  useEffect(() => {
    mounted.current = true;
    const update = () => {
      visible.current = document.visibilityState !== "hidden";
      lifecycle.current += 1;
      if (mounted.current) setRendered({ ...stateRef.current });
    };
    const hide = () => {
      visible.current = false;
      lifecycle.current += 1;
      if (mounted.current) setRendered({ ...stateRef.current });
    };
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", update);
    return () => {
      mounted.current = false;
      pendingFocus.current = null;
      lifecycle.current += 1;
      viewRead.current = null;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", update);
    };
  }, []);

  useEffect(() => {
    if (viewCurrent) void load(props.localDate);
    return () => {
      viewRead.current = null;
    };
  }, [load, props.localDate, viewCurrent]);

  const snapshot = state.snapshot.date === props.localDate ? state.snapshot : null;
  const draft = state.draft;
  const away = !!draft && draft.base.localDate !== props.localDate;
  const raw = draft?.raw ?? snapshot?.note?.note ?? "";
  let validation: string | null = null;
  try {
    dayNoteText(raw);
  } catch {
    validation = "Use up to 2,000 characters without invalid or null characters.";
  }
  const blocked = state.busy || !!state.operation || !!state.conflict || !!state.acknowledgement;
  const editable = !blocked && !away && snapshot?.phase === "ready" && !!snapshot.note;
  const base = draft?.base ?? snapshot?.note;
  const changed = !!base && raw !== (base.note ?? "");

  useLayoutEffect(() => {
    const request = pendingFocus.current;
    pendingFocus.current = null;
    const target = input.current;
    if (
      request?.state === state &&
      request.props === props &&
      request.epoch === epoch &&
      currentState() &&
      editable &&
      target &&
      !target.disabled
    )
      target.focus();
  });

  function installForEditing(next: NoteState) {
    pendingFocus.current = { state: next, props, epoch };
    install(next);
  }

  function change(raw: string) {
    if (!currentState() || !editable || !base || raw === (state.draft?.raw ?? base.note ?? ""))
      return;
    install({
      ...state,
      draft: raw === (base.note ?? "") ? null : { base, raw },
      message: "Unsaved day note.",
    });
  }
  function cancel() {
    if (!currentState() || state.busy || state.operation || state.acknowledgement || !draft) return;
    const fresh = state.conflict?.ready?.note;
    installForEditing({
      ...state,
      draft: null,
      conflict: null,
      message: "Note draft cancelled.",
      ...(fresh?.localDate === props.localDate
        ? { snapshot: { date: props.localDate, phase: "ready", note: fresh } as const }
        : {}),
    });
  }
  async function send(operation: DayNoteOperation) {
    if (!privateCurrent() || stateRef.current.operation !== operation || stateRef.current.busy)
      return;
    install({
      ...stateRef.current,
      busy: true,
      message: `Saving note for ${operation.identity.localDate}…`,
    });
    const eligible = () => privateCurrent() && stateRef.current.operation === operation;
    try {
      const response = await fetch(operation.url, {
        method: "PUT",
        headers: operation.headers,
        body: operation.serializedBody,
        cache: "no-store",
      });
      if (!eligible()) return;
      if (response.status === 401) return closeIfCurrent();
      const body = await json(response);
      if (!eligible()) return;
      const failure = code(body);
      if (response.status === 409 && failure === "DAY_NOTE_OWNER_CHANGED") return closeIfCurrent();
      if (
        (response.status === 412 && failure === "DAY_NOTE_REVISION_CONFLICT") ||
        (response.status === 409 && failure === "DAY_NOTE_TIME_ZONE_CHANGED")
      ) {
        install({
          ...stateRef.current,
          operation: null,
          busy: false,
          conflict: { date: operation.identity.localDate, ready: null },
          message:
            "Your note was not saved because the saved revision or profile time zone changed. Review the current note before saving your draft again.",
        });
        return;
      }
      if (response.status !== 200) throw new Error("Ambiguous note result.");
      readDayNoteMutation(body, response.headers.get("etag"), operation);
      const acknowledgement = { date: operation.identity.localDate, failed: false };
      // The historical receipt resolves only this operation. A separate read
      // establishes the current head, which may already have advanced elsewhere.
      install({
        ...stateRef.current,
        operation: null,
        busy: false,
        draft: null,
        conflict: null,
        acknowledgement,
        message: `Save acknowledged for ${acknowledgement.date}. Checking the current note…`,
      });
      await load(acknowledgement.date, acknowledgement);
    } catch {
      if (!eligible()) return;
      install({
        ...stateRef.current,
        busy: false,
        message:
          "The save was not confirmed. Retry this exact request; your note may already have been saved.",
      });
    }
  }
  function save(clear: boolean) {
    if (!currentState() || !editable || !base || validation) return;
    const nextRaw = clear ? "" : raw;
    const zone =
      zoneOverride.current?.source === props.session
        ? zoneOverride.current.zone
        : props.session.profile.timeZone;
    const operation = prepareDayNoteOperation(base, nextRaw, zone);
    if (!operation) return;
    install({ ...state, draft: { base, raw: nextRaw }, operation });
    void send(operation);
  }
  function retry() {
    if (!currentState() || state.busy || !state.operation) return;
    void send(state.operation);
  }
  async function review() {
    if (!currentState() || !state.conflict || state.busy || !draft || away) return;
    const conflict = state.conflict;
    viewRead.current = null;
    const controller = new AbortController();
    controllers.current.add(controller);
    install({
      ...state,
      busy: true,
      message: "Loading the saved note and current profile for review…",
    });
    const eligible = () =>
      privateCurrent() && stateRef.current.conflict === conflict && !controller.signal.aborted;
    try {
      const [noteResponse, sessionResponse] = await Promise.all([
        fetch(dayNotePath(conflict.date), {
          headers: {
            accept: "application/json",
            "x-expected-owner-user-id": props.session.user.id,
          },
          cache: "no-store",
          signal: controller.signal,
        }),
        fetch("/api/diary/day-notes/profile", {
          headers: {
            accept: "application/json",
            "x-expected-owner-user-id": props.session.user.id,
          },
          cache: "no-store",
          signal: controller.signal,
        }),
      ]);
      if (!eligible()) return;
      if (noteResponse.status === 401 || sessionResponse.status === 401) return closeIfCurrent();
      const [noteBody, sessionBody] = await Promise.all([
        json(noteResponse),
        json(sessionResponse),
      ]);
      if (!eligible()) return;
      if (noteResponse.status === 409 && code(noteBody) === "DAY_NOTE_OWNER_CHANGED")
        return closeIfCurrent();
      if (noteResponse.status !== 200 || sessionResponse.status !== 200)
        throw new Error("Review unavailable.");
      const note = readDayNote(
        noteBody,
        noteResponse.headers.get("etag"),
        props.session.user.id,
        conflict.date,
      );
      const verified = parseSession(sessionBody);
      if (verified.user.id !== props.session.user.id) return closeIfCurrent();
      if (propsRef.current.session !== props.session)
        throw new Error("Profile changed during review.");
      install({
        ...stateRef.current,
        busy: false,
        conflict: {
          date: conflict.date,
          ready: { note, zone: verified.profile.timeZone, source: props.session },
        },
        ...(propsRef.current.localDate === conflict.date && propsRef.current.isViewCurrent()
          ? { snapshot: { date: conflict.date, phase: "ready", note } as const }
          : {}),
        message:
          "Review the current saved note below. Keep my draft prepares your text to replace it on the next Save note. Use saved note discards your unsaved text.",
      });
    } catch {
      if (eligible())
        install({
          ...stateRef.current,
          busy: false,
          message:
            "The current note could not be reviewed. Your draft is unchanged; retry the review.",
        });
    } finally {
      controllers.current.delete(controller);
    }
  }
  function rebase() {
    const ready = state.conflict?.ready;
    if (!currentState() || state.busy || away || !draft || !ready || ready.source !== props.session)
      return;
    zoneOverride.current = { source: props.session, zone: ready.zone };
    installForEditing({
      ...state,
      conflict: null,
      snapshot: { date: props.localDate, phase: "ready", note: ready.note },
      draft: draft.raw === (ready.note.note ?? "") ? null : { base: ready.note, raw: draft.raw },
      message:
        "Your draft is kept. The next Save note replaces the saved text you reviewed; nothing has been written yet.",
    });
  }

  if (!props.isPrivateCurrent()) return null;
  return (
    <section className="diaryGroupSettings" aria-labelledby="day-note-title">
      <h2 id="day-note-title">Day note</h2>
      <p className="fieldHelp">
        Private context for {props.localDate}, even when no foods are logged.
      </p>
      <p className="fieldHelp">
        Drafts and unconfirmed requests stay in this open diary only. Closing or reloading it can
        lose them.
      </p>
      <p role="status" aria-live="polite">
        {state.message}
      </p>
      {away ? (
        <div>
          <p>Your draft belongs to {draft.base.localDate}. Return to edit or resolve it.</p>
          <button
            type="button"
            onClick={() => {
              if (currentState()) props.onReturn(draft.base.localDate);
            }}
          >
            Return to note date
          </button>
          {snapshot?.phase === "ready" ? (
            <p>
              Saved note for {props.localDate}: {snapshot.note?.note ?? "No current note."}
            </p>
          ) : null}
        </div>
      ) : null}
      {snapshot?.phase === "error" && !state.acknowledgement ? (
        <button
          type="button"
          onClick={() => {
            if (currentState()) void load(props.localDate);
          }}
        >
          Retry note load
        </button>
      ) : null}
      <div className="formField">
        <label htmlFor="day-note-input">
          {away ? `Unsaved note for ${draft.base.localDate}` : "Note for this day"}
        </label>
        <textarea
          id="day-note-input"
          ref={input}
          rows={4}
          value={raw}
          disabled={!editable}
          aria-describedby="day-note-help"
          onChange={(event) => change(event.currentTarget.value)}
        />
      </div>
      <p id="day-note-help" className="fieldHelp">
        {[...raw].length} / 2,000 characters. Saved note history remains in your private account
        export after clearing.
      </p>
      {validation ? <p role="alert">{validation}</p> : null}
      <div className="entryActions">
        <button
          type="button"
          className="buttonPrimary"
          disabled={!editable || !changed || !!validation}
          onClick={() => save(false)}
        >
          Save note
        </button>
        <button
          type="button"
          disabled={!editable || !base?.note || !!validation}
          onClick={() => save(true)}
        >
          Clear and save note
        </button>
        <button
          type="button"
          disabled={!draft || state.busy || !!state.operation || !!state.acknowledgement}
          onClick={cancel}
        >
          Cancel note draft
        </button>
        {state.operation ? (
          <button type="button" disabled={state.busy} onClick={retry}>
            {state.busy ? "Saving note…" : "Retry note save"}
          </button>
        ) : null}
      </div>
      {state.conflict ? (
        <div>
          <button type="button" disabled={state.busy || away} onClick={() => void review()}>
            Review current note
          </button>
          {state.conflict.ready ? (
            <>
              <p>
                Current saved note (revision {state.conflict.ready.note.revision}, profile zone{" "}
                {state.conflict.ready.zone}):
              </p>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {state.conflict.ready.note.note ?? "No current note."}
              </pre>
              <button
                type="button"
                disabled={state.busy || away || state.conflict.ready.source !== props.session}
                onClick={rebase}
              >
                Keep my draft
              </button>
              <button
                type="button"
                disabled={state.busy || away || state.conflict.ready.source !== props.session}
                onClick={() => {
                  if (
                    state.conflict?.ready &&
                    !away &&
                    state.conflict.ready.source === props.session
                  )
                    cancel();
                }}
              >
                Use saved note
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {state.acknowledgement?.failed ? (
        <button
          type="button"
          onClick={() => {
            if (!currentState() || !state.acknowledgement) return;
            const acknowledgement = { date: state.acknowledgement.date, failed: false };
            install({ ...state, acknowledgement });
            void load(acknowledgement.date, acknowledgement);
          }}
        >
          Reload saved note
        </button>
      ) : null}
      {!draft && snapshot?.note?.recordedTimeZone ? (
        <p className="fieldHelp">
          Saved in {snapshot.note.recordedTimeZone}; revision {snapshot.note.revision}.
        </p>
      ) : null}
    </section>
  );
}
