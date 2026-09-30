import { readFileSync } from "node:fs";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { registerErrorHandling } from "../src/http/error-handler.js";
import { publicIngressLimits, registerPublicIngressLimits } from "../src/http/public-ingress.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function testApp(now: () => number = Date.now): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: false });
  registerErrorHandling(app);
  registerPublicIngressLimits(app, now);
  apps.push(app);
  return app;
}

function latch(): { promise: Promise<void>; release(): void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("public API request admission", () => {
  it("bounds anonymous search across forwarding headers, IPs and credentials", async () => {
    let calls = 0;
    let now = 1_000;
    const app = testApp(() => now);
    app.get("/v1/foods/search", async () => {
      calls += 1;
      return { ok: true };
    });
    for (let index = 0; index < publicIngressLimits.foods.maximumAttempts; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/foods/search?query=apple",
        remoteAddress: `192.0.2.${(index % 250) + 1}`,
        headers: {
          "x-forwarded-for": `198.51.100.${(index % 250) + 1}`,
          authorization: `Bearer fake-${index}`,
        },
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "GET", url: "/v1/foods/search?query=banana" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(calls).toBe(180);
    now += publicIngressLimits.windowMs;
    expect(
      (await app.inject({ method: "GET", url: "/v1/foods/search?query=apple" })).statusCode,
    ).toBe(200);
  });

  it("shares auth capacity across anonymous routes but keeps food capacity separate", async () => {
    const app = testApp();
    for (const route of [
      "login",
      "register",
      "password-recovery/request",
      "password-recovery/confirm",
      "email-verification/confirm",
    ]) {
      app.post(`/v1/auth/${route}`, async () => ({ ok: true }));
    }
    app.get("/v1/foods/autocomplete", async () => ({ ok: true }));
    for (let index = 0; index < 30; index += 1) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/auth/${index % 2 === 0 ? "login" : "register"}`,
          })
        ).statusCode,
      ).toBe(200);
    }
    for (const route of [
      "login",
      "password-recovery/request",
      "password-recovery/confirm",
      "email-verification/confirm",
    ]) {
      expect((await app.inject({ method: "POST", url: `/v1/auth/${route}` })).statusCode).toBe(429);
    }
    expect((await app.inject({ method: "GET", url: "/v1/foods/autocomplete" })).statusCode).toBe(
      200,
    );
  });

  it("does not let new requests enter while four search operations remain pending", async () => {
    const app = testApp();
    const pending = latch();
    const allStarted = latch();
    let started = 0;
    app.get("/v1/foods/barcodes/:gtin", async () => {
      started += 1;
      if (started === 4) allStarted.release();
      await pending.promise;
      return { ok: true };
    });
    const requests = Array.from({ length: 4 }, () =>
      app.inject({ method: "GET", url: "/v1/foods/barcodes/0123456789012" }),
    );
    const completed = Promise.all(requests);
    await allStarted.promise;
    const denied = await app.inject({ method: "GET", url: "/v1/foods/barcodes/00000000" });
    expect(denied.statusCode).toBe(429);
    expect(started).toBe(4);
    pending.release();
    expect((await completed).every((response) => response.statusCode === 200)).toBe(true);
    expect(
      (await app.inject({ method: "GET", url: "/v1/foods/barcodes/00000000" })).statusCode,
    ).toBe(200);
  });

  it("holds auth admission through handler failure and releases settled slots", async () => {
    const app = testApp();
    const pending = latch();
    const allStarted = latch();
    let started = 0;
    app.post("/v1/auth/login", async () => {
      started += 1;
      if (started === 2) allStarted.release();
      await pending.promise;
      throw new Error("private-auth-error");
    });
    const completed = Promise.all([
      app.inject({ method: "POST", url: "/v1/auth/login" }),
      app.inject({ method: "POST", url: "/v1/auth/login" }),
    ]);
    await allStarted.promise;
    expect((await app.inject({ method: "POST", url: "/v1/auth/login" })).statusCode).toBe(429);
    pending.release();
    expect((await completed).every((response) => response.statusCode === 500)).toBe(true);
    const after = await app.inject({ method: "POST", url: "/v1/auth/login" });
    expect(after.statusCode).toBe(500);
    expect(after.body).not.toContain("private-auth-error");
  });

  it("keeps the actual app forwarding identity untrusted and rejects an oversized login body", async () => {
    const app = buildApp({
      config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      logger: false,
    });
    apps.push(app);
    app.get("/test-ip", async (request) => ({ ip: request.ip }));
    const response = await app.inject({
      method: "GET",
      url: "/test-ip",
      remoteAddress: "192.0.2.1",
      headers: { "x-forwarded-for": "203.0.113.1", forwarded: "for=203.0.113.1" },
    });
    expect(response.json()).toEqual({ ip: "192.0.2.1" });
    const oversized = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "a".repeat(1_048_576) },
    });
    expect(oversized.statusCode).toBe(413);
  });

  it("covers actual registered application routes with exact Caddy method/path patterns", async () => {
    const caddy = readFileSync(
      new URL("../../../infra/azure/files/Caddyfile", import.meta.url),
      "utf8",
    );
    const patterns = new Map(
      [...caddy.matchAll(/path_regexp application(Get|Post|Put|Patch|Delete) (.+)/gu)].map(
        (match) => [match[1]?.toUpperCase(), new RegExp(match[2] ?? "^$")],
      ),
    );
    const app = buildApp({
      config: loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      logger: false,
    });
    apps.push(app);
    const routes: { method: string; url: string }[] = [];
    app.addHook("onRoute", (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method])
        routes.push({ method, url: route.url });
    });
    await app.ready();
    const applicationRoutes = routes.filter(
      ({ method, url }) => method !== "HEAD" && url.startsWith("/v1/") && url !== "/v1/",
    );
    expect(applicationRoutes.length).toBeGreaterThan(60);
    for (const { method, url } of applicationRoutes) {
      const concrete = url
        .replace(/:(date|localDate)/gu, "2026-09-29")
        .replace(":gtin", "0123456789012")
        .replace(":format", "json")
        .replace(":platform", "apple_healthkit")
        .replace(/:[A-Za-z]+/gu, "11111111-1111-4111-8111-111111111111");
      expect(patterns.get(method)?.test(concrete), `${method} ${url}`).toBe(true);
    }
  });
});
