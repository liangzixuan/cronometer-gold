import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { BoundedAuthRateLimiter } from "../modules/auth/rate-limiter.js";
import { HttpProblem } from "./problem.js";

const anonymousAuthRoutes = new Set([
  "/v1/auth/register",
  "/v1/auth/login",
  "/v1/auth/email-verification/confirm",
  "/v1/auth/password-recovery/request",
  "/v1/auth/password-recovery/confirm",
]);
const anonymousFoodRoutes = new Set([
  "/v1/foods/search",
  "/v1/foods/autocomplete",
  "/v1/foods/barcodes/:gtin",
]);

// Fixed process-wide buckets also bound traffic from many IPs or one shared BFF.
// Qualification permits one API instance. Multiple replicas need shared limits.
export const publicIngressLimits = {
  auth: { maximumAttempts: 30, maximumConcurrent: 2 },
  foods: { maximumAttempts: 180, maximumConcurrent: 4 },
  windowMs: 60_000,
} as const;

type Family = "auth" | "foods";

function family(request: FastifyRequest): Family | undefined {
  const route = request.routeOptions.url?.replace(/\/$/u, "");
  if (route === undefined) return undefined;
  if (request.method === "POST" && anonymousAuthRoutes.has(route)) return "auth";
  if (request.method === "GET" && anonymousFoodRoutes.has(route)) return "foods";
  return undefined;
}

export function registerPublicIngressLimits(
  app: FastifyInstance,
  now: () => number = Date.now,
): void {
  const buckets = {
    auth: new BoundedAuthRateLimiter({
      maximumKeys: 1,
      maximumAttempts: publicIngressLimits.auth.maximumAttempts,
      windowMs: publicIngressLimits.windowMs,
    }),
    foods: new BoundedAuthRateLimiter({
      maximumKeys: 1,
      maximumAttempts: publicIngressLimits.foods.maximumAttempts,
      windowMs: publicIngressLimits.windowMs,
    }),
  };
  const active = { auth: 0, foods: 0 };
  const admitted = new WeakMap<FastifyRequest, Family>();
  function limited(reply: FastifyReply): never {
    reply.header("retry-after", "60");
    throw new HttpProblem({
      statusCode: 429,
      code: "RATE_LIMITED",
      title: "Too Many Requests",
      detail: "Too many requests. Try again later.",
      expose: true,
    });
  }
  app.addHook("onRequest", async (request, reply) => {
    const selected = family(request);
    if (selected !== undefined && !buckets[selected].consume(selected, now())) limited(reply);
  });
  // Schema validation precedes service-work admission. Invalid input preserves
  // its existing response and never occupies an expensive-operation slot.
  app.addHook("preHandler", async (request, reply) => {
    const selected = family(request);
    if (selected === undefined) return;
    if (active[selected] >= publicIngressLimits[selected].maximumConcurrent) limited(reply);
    active[selected] += 1;
    admitted.set(request, selected);
  });
  // Release when a response is prepared, after the handler has settled. An
  // aborted caller cannot free a slot while its backend operation is pending.
  app.addHook("onSend", async (request, _reply, payload) => {
    const selected = admitted.get(request);
    if (selected !== undefined) {
      admitted.delete(request);
      active[selected] -= 1;
    }
    return payload;
  });
}
