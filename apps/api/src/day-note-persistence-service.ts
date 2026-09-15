import type { DayNote, DayNoteMutationResponse } from "@nutrition-tracker/contracts";
import {
  type createDatabaseFromEnvironment,
  DayNotePersistenceError,
  getDayNote,
  putDayNote,
} from "@nutrition-tracker/db";
import { type DayNoteService, DayNoteServiceError } from "./modules/diary/day-note.routes.js";

export class DatabaseDayNoteService implements DayNoteService {
  constructor(private readonly database: ReturnType<typeof createDatabaseFromEnvironment>) {}
  async getNote(input: Parameters<DayNoteService["getNote"]>[0]): Promise<DayNote> {
    input.signal?.throwIfAborted();
    try {
      const result = await getDayNote(this.database, input);
      input.signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (error instanceof DayNotePersistenceError) throw new DayNoteServiceError(error.code);
      throw error;
    }
  }
  async putNote(input: Parameters<DayNoteService["putNote"]>[0]): Promise<DayNoteMutationResponse> {
    input.signal?.throwIfAborted();
    try {
      const result = await putDayNote(this.database, input);
      input.signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (error instanceof DayNotePersistenceError) throw new DayNoteServiceError(error.code);
      throw error;
    }
  }
}
