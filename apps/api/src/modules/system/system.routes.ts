import { probeResponseSchema, problemDetailsSchema } from "@nutrition-tracker/contracts";
import type { FastifyPluginAsync } from "fastify";

import { HttpProblem } from "../../http/problem.js";
import { safeErrorName } from "../../logging.js";

export type ReadinessCheck = (signal: AbortSignal) => boolean | Promise<boolean>;

export interface SystemRoutesOptions {
  readinessCheck: ReadinessCheck;
  readinessTimeoutMs: number;
}

const readinessTimedOut = Symbol("readinessTimedOut");

function createReadinessRunner(
  check: ReadinessCheck,
  timeoutMs: number,
): () => Promise<boolean | typeof readinessTimedOut> {
  let active: { readonly response: Promise<boolean | typeof readinessTimedOut> } | undefined;

  return () => {
    if (active) return active.response;

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const checkPromise = Promise.resolve().then(() => check(controller.signal));
    const deadline = new Promise<typeof readinessTimedOut>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort("readiness-timeout");
        resolve(readinessTimedOut);
      }, timeoutMs);
    });
    const current = {
      response: Promise.race([checkPromise, deadline]).finally(() => {
        if (timeout) clearTimeout(timeout);
      }),
    };
    active = current;

    // Keep a timed-out check single-flight until its adapter actually drains.
    void checkPromise
      .finally(() => {
        if (active === current) active = undefined;
      })
      .catch(() => undefined);

    return current.response;
  };
}

export const systemRoutes: FastifyPluginAsync<SystemRoutesOptions> = async (app, options) => {
  const runReadinessCheck = createReadinessRunner(
    options.readinessCheck,
    options.readinessTimeoutMs,
  );

  app.get(
    "/health",
    {
      schema: {
        response: { 200: probeResponseSchema },
      },
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return { status: "ok" as const };
    },
  );

  app.get(
    "/ready",
    {
      schema: {
        response: {
          200: probeResponseSchema,
          503: problemDetailsSchema,
        },
      },
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      let ready = false;

      try {
        const result = await runReadinessCheck();
        if (result === readinessTimedOut) {
          app.log.warn(
            { event: "api.readiness.check_timed_out", timeoutMs: options.readinessTimeoutMs },
            "Readiness check timed out",
          );
        } else {
          ready = result;
        }
      } catch (error) {
        app.log.warn(
          {
            event: "api.readiness.check_failed",
            errorType: safeErrorName(error),
          },
          "Readiness check failed",
        );
        ready = false;
      }

      if (!ready) {
        throw new HttpProblem({
          statusCode: 503,
          code: "SERVICE_NOT_READY",
          title: "Service Unavailable",
          detail: "The service is not ready to accept traffic.",
          expose: true,
        });
      }

      return { status: "ok" as const };
    },
  );
};
