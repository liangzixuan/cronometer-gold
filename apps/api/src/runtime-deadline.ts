import type { Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import { ConfigValidationError } from "./config.js";

/** One original host-monotonic deadline; a restart cannot renew this transport lifetime. */
export function hostedRuntimeDeadline(environment: NodeJS.ProcessEnv): (() => number) | null {
  const fields = ["NOURISHING_RUNTIME_NOT_AFTER_UTC", "NOURISHING_RUNTIME_DEADLINE_NS"] as const;
  if (fields.every((field) => environment[field] === undefined)) return null;
  const invalid = () =>
    new ConfigValidationError(
      fields.map((field) => ({
        field,
        message: "An explicit finite hosted-development deadline is required",
      })),
    );
  for (const field of [...fields, "NODE_ENV", "NOURISHING_API_PROFILE"])
    if (!Object.hasOwn(environment, field) || environment[field] === undefined) throw invalid();
  if (
    environment.NODE_ENV !== "development" ||
    environment.NOURISHING_API_PROFILE !== "hosted-development"
  )
    throw invalid();
  const text = environment.NOURISHING_RUNTIME_DEADLINE_NS;
  const utc = environment.NOURISHING_RUNTIME_NOT_AFTER_UTC;
  if (typeof text !== "string" || typeof utc !== "string" || !/^[1-9][0-9]{0,24}$/u.test(text))
    throw invalid();
  const end = Date.parse(utc),
    deadline = BigInt(text);
  if (!Number.isFinite(end) || new Date(end).toISOString() !== utc) throw invalid();
  const remaining = () => {
    const wall = end - Date.now();
    const monotonic = Number((deadline - process.hrtime.bigint()) / 1_000_000n);
    if (
      wall <= 0 ||
      monotonic <= 0 ||
      wall > 14_400_000 ||
      monotonic > 14_400_000 ||
      Math.abs(wall - monotonic) > 1000
    )
      throw invalid();
    return Math.min(wall, monotonic);
  };
  remaining();
  return remaining;
}

/** Socket destruction ends transport only. Already-issued database work can still settle. */
export function enforceHostedRuntimeDeadline(
  app: FastifyInstance,
  remaining: () => number,
  closeApplication: () => Promise<void>,
): () => void {
  remaining();
  const sockets = new Set<Socket>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const connection = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  app.server.on("connection", connection);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    app.server.off("connection", connection);
  };
  const expire = () => {
    if (disposed) return;
    dispose();
    app.server.close(() => {});
    for (const socket of sockets) socket.destroy();
    void closeApplication().catch(() => {
      app.log.fatal(
        { event: "api.runtime_expiry.cleanup_failed" },
        "Runtime expiry cleanup failed",
      );
      process.exitCode = 1;
    });
  };
  const check = () => {
    if (disposed) return;
    try {
      timer = setTimeout(check, Math.max(1, Math.min(1000, remaining())));
      timer.unref();
    } catch {
      expire();
    }
  };
  check();
  return dispose;
}
