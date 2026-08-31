import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildApp: vi.fn(),
  createApiSearchRuntime: vi.fn(),
}));

vi.mock("../src/app.js", () => ({ buildApp: mocks.buildApp }));
vi.mock("../src/search-runtime.js", () => ({
  createApiSearchRuntime: mocks.createApiSearchRuntime,
}));

import { createApiApplicationRuntime } from "../src/server.js";

function environment(): NodeJS.ProcessEnv {
  return {
    API_HOST: "127.0.0.1",
    API_PORT: "3001",
    DATABASE_URL: "postgresql://local.invalid/nutrition",
    LOG_LEVEL: "silent",
    NODE_ENV: "test",
  };
}

function dependencies(close = vi.fn().mockResolvedValue(undefined)) {
  return {
    authService: {},
    close,
    diaryService: {},
    foodSearchService: {},
    goalService: {},
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
        authService: runtimeDependencies.authService,
        logger: false,
        readinessCheck: runtimeDependencies.readinessCheck,
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
});
