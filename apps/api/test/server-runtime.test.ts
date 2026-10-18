import { once } from "node:events";
import { HOSTED_DEVELOPMENT_WEB_ORIGIN } from "@nutrition-tracker/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildApp: vi.fn(),
  createApiSearchRuntime: vi.fn(),
}));

vi.mock("../src/app.js", () => ({ buildApp: mocks.buildApp }));
vi.mock("../src/search-runtime.js", () => ({
  createApiSearchRuntime: mocks.createApiSearchRuntime,
}));

import { createApiApplicationRuntime } from "../src/server.js";

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

function environment(): NodeJS.ProcessEnv {
  return {
    API_HOST: "127.0.0.1",
    API_PORT: "3001",
    DATABASE_URL: "postgresql://local.invalid/nutrition",
    LOG_LEVEL: "silent",
    NODE_ENV: "test",
    REFERENCE_TARGETS_ENABLED: "true",
  };
}

function dependencies(close = vi.fn().mockResolvedValue(undefined)) {
  return {
    activityService: {},
    authService: {},
    close,
    diaryService: {},
    foodSearchService: {},
    goalService: {},
    hydrationService: {},
    nutritionReportService: {},
    profileService: {},
    readinessCheck: vi.fn().mockResolvedValue(true),
    recipeService: {},
    retentionService: {},
  };
}

function application(
  options: {
    readonly afterCloseHook?: () => Promise<void>;
    readonly beforeCloseHook?: () => Promise<void>;
    readonly ready?: () => Promise<void>;
  } = {},
) {
  let onClose: (() => Promise<void>) | undefined;
  const app = {
    addHook: vi.fn((name: string, hook: () => Promise<void>) => {
      if (name === "onClose") onClose = hook;
    }),
    close: vi.fn(async () => {
      await options.beforeCloseHook?.();
      await onClose?.();
      await options.afterCloseHook?.();
    }),
    listen: vi.fn(),
    log: {
      fatal: vi.fn(),
      info: vi.fn(),
    },
    ready: vi.fn(options.ready ?? (async () => undefined)),
    server: { listening: false },
  };
  return app;
}

beforeEach(() => {
  mocks.buildApp.mockReset();
  mocks.createApiSearchRuntime.mockReset();
});

describe("API application runtime factory", () => {
  it("creates one ready unlistened application and closes owned dependencies once", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const runtimeDependencies = dependencies(close);
    const app = application();
    mocks.createApiSearchRuntime.mockResolvedValue(runtimeDependencies);
    mocks.buildApp.mockReturnValue(app);
    const clock = () => new Date("2026-08-30T12:00:00.000Z");
    const beforeSignals = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };
    const sourceEnvironment = environment();

    const runtime = await createApiApplicationRuntime(sourceEnvironment, {
      clock,
      logger: false,
    });

    expect(mocks.createApiSearchRuntime).toHaveBeenCalledWith(
      sourceEnvironment,
      expect.objectContaining({ databaseUrl: sourceEnvironment.DATABASE_URL }),
      { clock },
    );
    expect(mocks.buildApp).toHaveBeenCalledWith(
      expect.objectContaining({
        activityService: runtimeDependencies.activityService,
        authService: runtimeDependencies.authService,
        hydrationService: runtimeDependencies.hydrationService,
        logger: false,
        nutritionReportService: runtimeDependencies.nutritionReportService,
        readinessCheck: runtimeDependencies.readinessCheck,
        referenceTargetsEnabled: true,
        retentionClock: clock,
        retentionService: runtimeDependencies.retentionService,
      }),
    );
    expect(app.ready).toHaveBeenCalledOnce();
    expect(app.listen).not.toHaveBeenCalled();
    expect(runtime.app.server.listening).toBe(false);
    expect(process.listenerCount("SIGINT")).toBe(beforeSignals.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSignals.SIGTERM);

    await Promise.all([runtime.close(), runtime.close()]);
    expect(app.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes dependencies when synchronous application construction fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.createApiSearchRuntime.mockResolvedValue(dependencies(close));
    const primary = new Error("synthetic build failure");
    mocks.buildApp.mockImplementation(() => {
      throw primary;
    });

    await expect(createApiApplicationRuntime(environment())).rejects.toBe(primary);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes dependencies once through Fastify onClose when deferred boot fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.createApiSearchRuntime.mockResolvedValue(dependencies(close));
    const primary = new Error("synthetic ready failure");
    const app = application({
      ready: async () => {
        throw primary;
      },
    });
    mocks.buildApp.mockReturnValue(app);

    await expect(createApiApplicationRuntime(environment())).rejects.toBe(primary);
    expect(app.close).toHaveBeenCalledOnce();
    expect(app.listen).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("aggregates deferred boot and rejecting onClose cleanup exactly once", async () => {
    const dependencyCleanup = new Error("synthetic dependency cleanup failure");
    const close = vi.fn().mockRejectedValue(dependencyCleanup);
    mocks.createApiSearchRuntime.mockResolvedValue(dependencies(close));
    const primary = new Error("synthetic ready failure");
    const app = application({
      ready: async () => {
        throw primary;
      },
    });
    mocks.buildApp.mockReturnValue(app);

    const failure = await createApiApplicationRuntime(environment()).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([primary, dependencyCleanup]);
    expect(app.close).toHaveBeenCalledOnce();
    expect(app.listen).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("aggregates pre-hook application and fallback dependency cleanup failures", async () => {
    const dependencyCleanup = new Error("synthetic dependency cleanup failure");
    const close = vi.fn().mockRejectedValue(dependencyCleanup);
    mocks.createApiSearchRuntime.mockResolvedValue(dependencies(close));
    const primary = new Error("synthetic ready failure");
    const applicationCleanup = new Error("synthetic application cleanup failure");
    const app = application({
      beforeCloseHook: async () => {
        throw applicationCleanup;
      },
      ready: async () => {
        throw primary;
      },
    });
    mocks.buildApp.mockReturnValue(app);

    const failure = await createApiApplicationRuntime(environment()).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      primary,
      applicationCleanup,
      dependencyCleanup,
    ]);
    expect(app.close).toHaveBeenCalledOnce();
    expect(app.listen).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains an expiry cleanup rejection for the owning close caller", async () => {
    const { default: Fastify } = await import("fastify");
    const app = Fastify({ logger: false });
    const applicationClose = vi.spyOn(app, "close");
    const failure = new Error("synthetic expiry dependency failure");
    let entered!: () => void;
    const closing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const close = vi.fn(async () => {
      entered();
      throw failure;
    });
    mocks.createApiSearchRuntime.mockResolvedValue(dependencies(close));
    mocks.buildApp.mockReturnValue(app);
    const exitCode = process.exitCode;
    try {
      const milliseconds = 150;
      const runtime = await createApiApplicationRuntime({
        ...environment(),
        NODE_ENV: "development",
        NOURISHING_API_PROFILE: "hosted-development",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: "1025",
        SMTP_FROM: "nourishing@localhost",
        EMAIL_VERIFICATION_PUBLIC_ORIGIN: HOSTED_DEVELOPMENT_WEB_ORIGIN,
        PASSWORD_RECOVERY_PUBLIC_ORIGIN: HOSTED_DEVELOPMENT_WEB_ORIGIN,
        NOURISHING_RUNTIME_NOT_AFTER_UTC: new Date(Date.now() + milliseconds).toISOString(),
        NOURISHING_RUNTIME_DEADLINE_NS: (
          process.hrtime.bigint() +
          BigInt(milliseconds) * 1_000_000n
        ).toString(),
      });
      await closing;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(runtime.close()).rejects.toBe(failure);
      await expect(runtime.close()).rejects.toBe(failure);
      expect(applicationClose).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      process.exitCode = exitCode;
    }
  });

  it.each(["manual", "signal"] as const)(
    "keeps hard socket expiry active during pending %s shutdown",
    async (mode) => {
      const { default: Fastify } = await import("fastify");
      const { request } = await import("node:http");
      const { EventEmitter } = await import("node:events");
      const { installGracefulShutdown } = await import("../src/shutdown.js");
      const app = Fastify({ logger: false });
      app.get("/pending", async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200);
        reply.raw.write("partial");
      });
      const applicationClose = vi.spyOn(app, "close");
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const close = vi.fn(() => blocked);
      mocks.createApiSearchRuntime.mockResolvedValue(dependencies(close));
      mocks.buildApp.mockReturnValue(app);
      const milliseconds = 350;
      const runtime = await createApiApplicationRuntime({
        ...environment(),
        NODE_ENV: "development",
        NOURISHING_API_PROFILE: "hosted-development",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: "1025",
        SMTP_FROM: "nourishing@localhost",
        EMAIL_VERIFICATION_PUBLIC_ORIGIN: HOSTED_DEVELOPMENT_WEB_ORIGIN,
        PASSWORD_RECOVERY_PUBLIC_ORIGIN: HOSTED_DEVELOPMENT_WEB_ORIGIN,
        NOURISHING_RUNTIME_NOT_AFTER_UTC: new Date(Date.now() + milliseconds).toISOString(),
        NOURISHING_RUNTIME_DEADLINE_NS: (
          process.hrtime.bigint() +
          BigInt(milliseconds) * 1_000_000n
        ).toString(),
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const req = request({
        host: "127.0.0.1",
        port: (app.server.address() as { port: number }).port,
        path: "/pending",
      });
      req.on("error", () => {});
      const responseReady = once(req, "response");
      req.end();
      const [response] = await responseReady;
      response.on("error", () => {});
      response.resume();
      const socketClosed = new Promise<void>((resolve) => response.once("close", resolve));
      const emitter = Object.assign(new EventEmitter(), {
        exit: vi.fn((_code?: number): never => {
          throw new Error("Unexpected forced exit");
        }),
      });
      const shutdown = installGracefulShutdown(app, {
        timeoutMs: 2000,
        runtime: emitter,
        closeApplication: runtime.close,
      });
      let settled = false;
      let closing: Promise<void>;
      if (mode === "signal") {
        emitter.emit("SIGTERM");
        closing = shutdown.close();
      } else closing = runtime.close();
      void closing.then(() => {
        settled = true;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          socketClosed,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Pending shutdown disabled hard socket expiry")),
              1500,
            );
          }),
        ]);
        expect(app.server.listening).toBe(false);
        expect(settled).toBe(false);
        release();
        await closing;
        expect(applicationClose).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(emitter.exit).not.toHaveBeenCalled();
      } finally {
        clearTimeout(timer);
        release();
        req.destroy();
        shutdown.dispose();
        await runtime.close();
      }
    },
  );
});
