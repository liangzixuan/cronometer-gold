import type { ChangeEventHandler } from "react";

import { type DiaryGroup, diaryEntryNoteCharacterCount, type MealSlot } from "../../lib/diary";

interface DiaryEntryEditorFormProps {
  readonly entryId: string;
  readonly entryName: string;
  readonly editor: {
    readonly quantity: string;
    readonly mealSlot: MealSlot;
    readonly localDate: string;
    readonly localTime: string;
    readonly note: string;
    readonly originTimeZone: string;
  };
  readonly diaryGroups: readonly DiaryGroup[];
  readonly entryEditorControlsDisabled: boolean;
  readonly clearDisabled: boolean;
  readonly saveDisabled: boolean;
  readonly saveLabel: string;
  readonly onQuantityChange: ChangeEventHandler<HTMLInputElement>;
  readonly onMealChange: ChangeEventHandler<HTMLSelectElement>;
  readonly onLocalDateChange: ChangeEventHandler<HTMLInputElement>;
  readonly onLocalTimeChange: ChangeEventHandler<HTMLInputElement>;
  readonly onNoteChange: ChangeEventHandler<HTMLTextAreaElement>;
  readonly onClearNote: () => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}

export function DiaryEntryEditorForm({
  entryId,
  entryName,
  editor,
  diaryGroups,
  entryEditorControlsDisabled,
  clearDisabled,
  saveDisabled,
  saveLabel,
  onQuantityChange,
  onMealChange,
  onLocalDateChange,
  onLocalTimeChange,
  onNoteChange,
  onClearNote,
  onSave,
  onCancel,
}: DiaryEntryEditorFormProps) {
  return (
    <div className="entryEditor">
      <label>
        Quantity
        <input
          disabled={entryEditorControlsDisabled}
          inputMode="decimal"
          maxLength={18}
          onChange={onQuantityChange}
          value={editor.quantity}
        />
      </label>
      <label>
        Meal
        <select
          disabled={entryEditorControlsDisabled}
          onChange={onMealChange}
          value={editor.mealSlot}
        >
          {diaryGroups.map((groupOption) => (
            <option key={groupOption.mealSlot} value={groupOption.mealSlot}>
              {groupOption.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Local date
        <input
          disabled={entryEditorControlsDisabled}
          onChange={onLocalDateChange}
          type="date"
          value={editor.localDate}
        />
      </label>
      <label>
        Local time
        <input
          disabled={entryEditorControlsDisabled}
          onChange={onLocalTimeChange}
          type="time"
          value={editor.localTime}
        />
      </label>
      <label className="entryNoteField" htmlFor={`entry-note-${entryId}`}>
        Private note
        <textarea
          disabled={entryEditorControlsDisabled}
          aria-describedby={`entry-note-help-${entryId}`}
          id={`entry-note-${entryId}`}
          maxLength={4_000}
          onChange={onNoteChange}
          rows={4}
          value={editor.note}
        />
      </label>
      <small className="entryNoteHint" id={`entry-note-help-${entryId}`}>
        Clear the field and save to remove this note from the current display only. Immutable prior
        revisions remain in your private account export until whole-account erasure. Character
        count: {diaryEntryNoteCharacterCount(editor.note)}
        of 2,000.
      </small>
      <small className="entryTimeHint">
        Changed date and time are interpreted in {editor.originTimeZone}.
      </small>
      <div className="entryActions">
        <button
          aria-label={`Clear note field for ${entryName}`}
          disabled={clearDisabled}
          onClick={onClearNote}
          type="button"
        >
          Clear field
        </button>
        <button
          aria-label={`Save changes to ${entryName}`}
          disabled={saveDisabled}
          onClick={onSave}
          type="button"
        >
          {saveLabel}
        </button>
        <button
          aria-label={`Cancel editing ${entryName}`}
          disabled={entryEditorControlsDisabled}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
