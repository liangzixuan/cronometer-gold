import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { HttpProblem } from "../src/http/problem.js";

const apps: ReturnType<typeof buildApp>[] = [];
const testConfig = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });

function createTestApp(options: Parameters<typeof buildApp>[0] = {}): ReturnType<typeof buildApp> {
  const app = buildApp({ config: testConfig, logger: false, ...options });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("API platform shell", () => {
  it("reports liveness and assigns an opaque request ID", async () => {
    const app = createTestApp();
    const untrustedId = randomUUID();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": untrustedId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(response.headers["x-request-id"]).not.toBe(untrustedId);
  });

  it("reports readiness when dependencies are available", async () => {
    const app = createTestApp({ readinessCheck: async () => true });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("uses the standard problem envelope when readiness fails", async () => {
    const app = createTestApp({ readinessCheck: async () => false });
    const response = await app.inject({ method: "GET", url: "/ready" });
    const problem = response.json();

    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(problem).toEqual({
      type: "about:blank",
      title: "Service Unavailable",
      status: 503,
      code: "SERVICE_NOT_READY",
      detail: "The service is not ready to accept traffic.",
      requestId: response.headers["x-request-id"],
    });
  });

  it("bounds a readiness check that never settles", async () => {
    let observedSignal: AbortSignal | undefined;
    let checkCount = 0;
    const app = createTestApp({
      config: { ...testConfig, readinessTimeoutMs: 10 },
      readinessCheck: async (signal) => {
        checkCount += 1;
        observedSignal = signal;
        return new Promise(() => undefined);
      },
    });
    const response = await app.inject({ method: "GET", url: "/ready" });
    const repeatedResponse = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(repeatedResponse.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "SERVICE_NOT_READY" });
    expect(observedSignal?.aborted).toBe(true);
    expect(checkCount).toBe(1);
  });

  it("registers the API through the v1 module boundary", async () => {
    const app = createTestApp();
    const response = await app.inject({ method: "GET", url: "/v1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { apiVersion: "v1" } });
  });

  it("returns the problem envelope for unknown routes", async () => {
    const app = createTestApp();
    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      type: "about:blank",
      status: 404,
      code: "ROUTE_NOT_FOUND",
      requestId: response.headers["x-request-id"],
    });
  });

  it("does not expose unexpected error messages", async () => {
    const app = createTestApp();
    app.get("/explode", async () => {
      throw new Error("private-health-value-must-not-leak");
    });

    const response = await app.inject({ method: "GET", url: "/explode" });
    const body = response.body;

    expect(response.statusCode).toBe(500);
    expect(body).not.toContain("private-health-value-must-not-leak");
    expect(response.json()).toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      detail: "An unexpected error occurred.",
    });
  });

  it("does not expose internal HttpProblem metadata unless explicitly approved", async () => {
    const app = createTestApp();
    app.get("/private-problem", async () => {
      throw new HttpProblem({
        statusCode: 500,
        code: "INTERNAL_ERROR",
        title: "Private database failure",
        detail: "patient-glucose-value-must-not-leak",
        type: "https://internal.example/private-error",
      });
    });

    const response = await app.inject({ method: "GET", url: "/private-problem" });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("patient-glucose-value-must-not-leak");
    expect(response.body).not.toContain("Private database failure");
    expect(response.body).not.toContain("internal.example");
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      detail: "An unexpected error occurred.",
    });
  });

  it("normalizes route validation errors without echoing input", async () => {
    const app = createTestApp();
    app.post(
      "/validate",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: { name: { type: "string", minLength: 1 } },
          },
        },
      },
      async () => ({ ok: true }),
    );

    const privateValue = "private-diary-value";
    const response = await app.inject({
      method: "POST",
      url: "/validate",
      payload: { unexpected: privateValue },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(privateValue);
    expect(response.json()).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      issues: [expect.objectContaining({ message: "Invalid value." })],
    });
  });

  it("preserves unlisted client status codes without leaking messages", async () => {
    const app = createTestApp();
    app.get("/unprocessable", async () => {
      throw Object.assign(new Error("private validation implementation detail"), {
        statusCode: 422,
      });
    });

    const response = await app.inject({ method: "GET", url: "/unprocessable" });

    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain("private validation implementation detail");
    expect(response.json()).toMatchObject({
      status: 422,
      code: "REQUEST_ERROR",
      detail: "The request could not be completed.",
    });
  });
});
