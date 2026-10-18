import { once } from "node:events";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enforceHostedRuntimeDeadline, hostedRuntimeDeadline } from "../src/runtime-deadline.js";

// Real timers and sockets; one source-test clock origin avoids native WSL wall-clock steps.
beforeEach(() => {
  const wall = Date.now(),
    monotonic = process.hrtime.bigint();
  vi.spyOn(Date, "now").mockImplementation(
    () => wall + Number((process.hrtime.bigint() - monotonic) / 1_000_000n),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

function environment(milliseconds = 500): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    NOURISHING_API_PROFILE: "hosted-development",
    NOURISHING_RUNTIME_NOT_AFTER_UTC: new Date(Date.now() + milliseconds).toISOString(),
    NOURISHING_RUNTIME_DEADLINE_NS: (
      process.hrtime.bigint() +
      BigInt(milliseconds) * 1_000_000n
    ).toString(),
  };
}

describe("hosted runtime transport deadline", () => {
  it("keeps an unselected ordinary API free of timers", () => {
    expect(hostedRuntimeDeadline({})).toBeNull();
  });
  it.each([
    { NODE_ENV: "production" },
    { NOURISHING_API_PROFILE: "other" },
    { NOURISHING_RUNTIME_DEADLINE_NS: "0" },
    { NOURISHING_RUNTIME_DEADLINE_NS: "+123" },
    { NOURISHING_RUNTIME_DEADLINE_NS: undefined },
    { NOURISHING_RUNTIME_NOT_AFTER_UTC: undefined },
    { NOURISHING_RUNTIME_NOT_AFTER_UTC: "2099-01-01T00:00:00.000Z" },
  ])("rejects incomplete, unselected or inconsistent deadlines", (override) => {
    expect(() => hostedRuntimeDeadline({ ...environment(), ...override })).toThrow();
  });
  it("rejects inherited authority fields", () => {
    for (const key of Object.keys(environment())) {
      const env = environment();
      const value = env[key];
      delete env[key];
      Object.setPrototypeOf(env, { [key]: value });
      expect(() => hostedRuntimeDeadline(env)).toThrow();
    }
  });
  it("a restarted consumer uses the original remaining horizon", async () => {
    const env = environment(100);
    const first = hostedRuntimeDeadline(env)!;
    await delay(30);
    const second = hostedRuntimeDeadline(env)!;
    expect(second()).toBeLessThan(85);
    await delay(100);
    expect(first).toThrow();
    expect(second).toThrow();
    expect(() => hostedRuntimeDeadline(env)).toThrow();
  });
  it("closes a real listener and a hijacked in-flight socket at the original deadline", async () => {
    const app = Fastify({ logger: false });
    app.get("/pending", async (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200);
      reply.raw.write("partial");
    });
    const deadline = hostedRuntimeDeadline(environment(250))!;
    let closePromise: Promise<void> | undefined;
    let dispose = () => {};
    const close = () => (closePromise ??= app.close().finally(() => dispose()));
    dispose = enforceHostedRuntimeDeadline(app, deadline, close);
    let dependenciesClosed = 0;
    let finished!: () => void;
    const settled = new Promise<void>((resolve) => {
      finished = resolve;
    });
    app.addHook("onClose", async () => {
      dependenciesClosed++;
      finished();
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    expect(typeof address).toBe("object");
    const req = request({
      host: "127.0.0.1",
      port: (address as { port: number }).port,
      path: "/pending",
    });
    req.on("error", () => {});
    const responsePromise = once(req, "response");
    req.end();
    const [response] = await responsePromise;
    response.on("error", () => {});
    response.resume();
    const closed = new Promise<void>((resolve) => response.once("close", resolve));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Deadline failed to close active socket")),
            2000,
          );
        }),
      ]);
      await settled;
    } finally {
      clearTimeout(timeout);
    }
    expect(app.server.listening).toBe(false);
    expect(dependenciesClosed).toBe(1);
    await close();
  });
  it("ordinary close disposes the deadline and connection listener", async () => {
    const app = Fastify({ logger: false });
    const before = app.server.listenerCount("connection");
    let dispose = () => {};
    const close = () => app.close().finally(() => dispose());
    dispose = enforceHostedRuntimeDeadline(app, hostedRuntimeDeadline(environment(100))!, close);
    await app.ready();
    await close();
    expect(app.server.listenerCount("connection")).toBe(before);
    await delay(120);
  });
});
