import { spawn as spawnProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { nestedProcessTerminationGraceMs } from "../../../scripts/local-development-shutdown-budget.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const expoHome = fileURLToPath(new URL("../.expo/home/", import.meta.url));
const forwardedSignals = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
const reviewedExpoInvocations = Object.freeze([
  Object.freeze(["export", "--platform", "all", "--output-dir", "dist"]),
  Object.freeze(["install", "--check"]),
  Object.freeze(["start", "--localhost"]),
]);

function assertReviewedExpoInvocation(arguments_) {
  if (
    !Array.isArray(arguments_) ||
    !reviewedExpoInvocations.some(
      (reviewed) =>
        arguments_.length === reviewed.length &&
        reviewed.every((argument, index) => arguments_[index] === argument),
    )
  ) {
    throw new Error("Expo invocation is not reviewed for this repository");
  }
}

export class ExpoProcessError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ExpoProcessError";
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
  }
}

function terminationGraceMs(value) {
  const parsed = value ?? nestedProcessTerminationGraceMs;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 60_000) {
    throw new Error("Expo requires a bounded termination grace period");
  }
  return parsed;
}

function monitorExpoChild(child, dependencies) {
  if (
    !child ||
    typeof child.once !== "function" ||
    typeof child.kill !== "function" ||
    !Number.isInteger(child.pid) ||
    child.pid < 1
  ) {
    throw new Error("Unable to start Expo");
  }
  const runtime = dependencies.signalRuntime ?? process;
  const kill = dependencies.kill ?? ((pid, signal) => process.kill(pid, signal));
  const platform = dependencies.platform ?? process.platform;
  const groupExists =
    dependencies.groupExists ??
    ((pid) => {
      try {
        if (platform === "win32") return child.exitCode === null && child.signalCode === null;
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        return error?.code !== "ESRCH";
      }
    });
  const graceMs = terminationGraceMs(dependencies.terminationGraceMs);
  const handlers = new Map();
  let forceTimer;
  let postKillTimer;
  let pollTimer;
  let forwardedSignal;
  let signalCount = 0;
  let settled = false;
  let terminalOutcome;
  let escalationComplete = false;
  let terminationStarted = false;
  let cleanupFailed = false;
  let killSent = false;
  const groupPollIntervalMs = Math.max(1, Math.min(25, Math.floor(graceMs / 4)));
  const postKillVerificationMs = Math.max(100, Math.min(1_000, graceMs));
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const dispose = () => {
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    if (postKillTimer !== undefined) clearTimeout(postKillTimer);
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    for (const [signal, handler] of handlers) runtime.removeListener(signal, handler);
    handlers.clear();
  };
  const groupStillExists = () => {
    try {
      return groupExists(child.pid);
    } catch {
      cleanupFailed = true;
      return true;
    }
  };
  const signalTree = (signal) => {
    try {
      if (platform === "win32") {
        child.kill(signal);
      } else {
        kill(-child.pid, signal);
      }
    } catch (error) {
      if (error?.code !== "ESRCH") return false;
    }
    return true;
  };
  const completeEscalation = () => {
    if (settled || escalationComplete || killSent) return;
    if (!groupStillExists()) {
      escalationComplete = true;
      settleIfReady();
      return;
    }
    if (!signalTree("SIGKILL")) cleanupFailed = true;
    killSent = true;
    postKillTimer = setTimeout(() => {
      postKillTimer = undefined;
      if (settled || escalationComplete) return;
      if (!groupStillExists()) {
        escalationComplete = true;
        terminalOutcome ??= { kind: "error" };
        settleIfReady();
        return;
      }
      cleanupFailed = true;
      escalationComplete = true;
      terminalOutcome ??= { kind: "error" };
      settleIfReady();
    }, postKillVerificationMs);
    startGroupPolling();
  };
  const startTermination = (signal) => {
    if (terminationStarted) return;
    terminationStarted = true;
    if (!signalTree(signal)) cleanupFailed = true;
    forceTimer = setTimeout(completeEscalation, graceMs);
  };
  const pollGroup = () => {
    pollTimer = undefined;
    if (settled || escalationComplete || terminalOutcome === undefined) return;
    if (!groupStillExists()) {
      escalationComplete = true;
      settleIfReady();
      return;
    }
    pollTimer = setTimeout(pollGroup, groupPollIntervalMs);
  };
  const startGroupPolling = () => {
    if (pollTimer === undefined && !escalationComplete && terminalOutcome !== undefined) {
      pollTimer = setTimeout(pollGroup, groupPollIntervalMs);
    }
  };
  const settleIfReady = () => {
    if (settled || terminalOutcome === undefined) return;
    if (!escalationComplete) {
      if (!groupStillExists()) {
        escalationComplete = true;
      } else {
        startTermination(forwardedSignal ?? "SIGTERM");
        startGroupPolling();
        return;
      }
    }
    settled = true;
    dispose();
    if (terminalOutcome.kind === "error" || cleanupFailed) {
      rejectCompletion(new Error("Unable to start Expo"));
      return;
    }
    resolveCompletion({
      signal: forwardedSignal ?? terminalOutcome.signal ?? null,
      status: terminalOutcome.status,
    });
  };
  const forward = (signal) => {
    if (settled) return;
    forwardedSignal ??= signal;
    signalCount += 1;
    if (signalCount === 1) {
      startTermination(signal);
    } else {
      completeEscalation();
    }
    settleIfReady();
  };

  child.once("error", () => {
    terminalOutcome ??= { kind: "error" };
    settleIfReady();
  });
  child.once("exit", (status, signal) => {
    terminalOutcome ??= { kind: "exit", signal, status };
    settleIfReady();
  });

  for (const signal of forwardedSignals) {
    const handler = () => forward(signal);
    handlers.set(signal, handler);
    runtime.on(signal, handler);
  }
  return completion;
}

export async function runExpo(arguments_ = [], dependencies = {}) {
  assertReviewedExpoInvocation(arguments_);
  const mkdir = dependencies.mkdir ?? mkdirSync;
  mkdir(expoHome, { recursive: true });

  const spawn = dependencies.spawn ?? spawnProcess;
  let child;
  try {
    child = spawn("expo", arguments_, {
      detached: true,
      env: {
        ...(dependencies.environment ?? process.env),
        __UNSAFE_EXPO_HOME_DIRECTORY: expoHome,
        EXPO_NO_TELEMETRY: "1",
      },
      shell: false,
      stdio: "inherit",
    });
  } catch {
    throw new Error("Unable to start Expo");
  }

  let result;
  try {
    result = await monitorExpoChild(child, dependencies);
  } catch (error) {
    try {
      child?.kill?.("SIGKILL");
    } catch {
      // The generic launch failure remains authoritative.
    }
    throw error;
  }
  if (result.signal) {
    throw new ExpoProcessError(`Expo stopped on ${result.signal}`, {
      signal: result.signal,
    });
  }
  if (result.status !== 0) {
    const exitCode = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    throw new ExpoProcessError(`Expo failed with exit code ${result.status ?? "unknown"}`, {
      exitCode,
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    await runExpo(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ExpoProcessError) {
      if (error.signal && forwardedSignals.includes(error.signal)) {
        try {
          process.kill(process.pid, error.signal);
        } catch {
          process.exitCode = 1;
        }
      } else {
        process.stderr.write(`${error.message}.\n`);
        process.exitCode = error.exitCode ?? 1;
      }
    } else {
      process.stderr.write("Expo launch failed.\n");
      process.exitCode = 1;
    }
  }
}
