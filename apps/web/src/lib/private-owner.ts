import type { SessionSummary } from "./diary";

export class PrivateOwnerFenceError extends Error {
  constructor() {
    super("The signed-in account changed while private data was loading.");
    this.name = "PrivateOwnerFenceError";
  }
}

/** Install private data only after the server session confirms its initiating owner. */
export async function installPrivateDataForOwner<T>(input: {
  readonly expectedOwnerUserId: string;
  readonly loadPrivateData: () => Promise<T>;
  readonly revalidateSession: () => Promise<SessionSummary>;
  readonly install: (data: T, session: SessionSummary) => void;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const data = await input.loadPrivateData();
  input.signal?.throwIfAborted();
  const session = await input.revalidateSession();
  input.signal?.throwIfAborted();
  if (session.user.id !== input.expectedOwnerUserId) throw new PrivateOwnerFenceError();
  input.install(data, session);
}
