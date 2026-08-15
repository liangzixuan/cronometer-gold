export interface WorkerRuntimeOptions {
  readonly pollIntervalMs: number;
  readonly shutdownGraceMs: number;
  readonly onPoll: (signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
}

export class WorkerShutdownTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Worker poll did not drain within ${timeoutMs} milliseconds.`);
    this.name = "WorkerShutdownTimeoutError";
  }
}

export async function runWorker(options: WorkerRuntimeOptions): Promise<void> {
  while (!options.signal.aborted) {
    const completed = await runAbortablePoll(
      options.onPoll,
      options.signal,
      options.shutdownGraceMs,
    );
    if (!completed) return;
    await waitForNextPoll(options.pollIntervalMs, options.signal);
  }
}

async function runAbortablePoll(
  onPoll: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  shutdownGraceMs: number,
): Promise<boolean> {
  if (signal.aborted) return false;

  let finishAbort!: () => void;
  const aborted = new Promise<"aborted">((resolve) => {
    finishAbort = () => resolve("aborted");
    signal.addEventListener("abort", finishAbort, { once: true });
  });
  const poll = Promise.resolve().then(() => onPoll(signal));

  try {
    const outcome = await Promise.race([poll.then(() => "completed" as const), aborted]);
    if (outcome === "completed") return !signal.aborted;

    await drainWithin(poll, shutdownGraceMs);
    return false;
  } finally {
    signal.removeEventListener("abort", finishAbort);
  }
}

async function drainWithin(poll: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new WorkerShutdownTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    await Promise.race([poll, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function waitForNextPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
