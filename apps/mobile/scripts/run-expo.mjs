import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, win32 } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { nestedProcessTerminationGraceMs } from "../../../scripts/local-development-shutdown-budget.mjs";

import {
  runWindowsOwnedProcess,
  WindowsOwnedProcessError,
} from "../../../scripts/windows-owned-process.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const mobileDirectory = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(mobileDirectory, "../..");
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

function validateExpoProfile(environment) {
  const profile = environment.EXPO_PUBLIC_NOURISHING_PROFILE;
  if (profile === undefined && environment.EXPO_PUBLIC_API_URL === "https://dev-api.nourishing.app")
    throw new TypeError("The reserved development origin requires its explicit mobile profile.");
  if (
    profile !== undefined &&
    (profile !== "hosted-development" ||
      environment.EXPO_PUBLIC_API_URL !== "https://dev-api.nourishing.app")
  ) {
    throw new TypeError("Hosted development requires its exact selector and API origin.");
  }
  if (
    profile === "hosted-development" &&
    (environment.EAS_BUILD === "true" ||
      environment.EAS_BUILD_PROFILE !== undefined ||
      ["production", "preview"].includes(environment.EAS_ENVIRONMENT))
  ) {
    throw new TypeError("Hosted development is not an approved native build or release profile.");
  }
}

export function resolveExpoCli(dependencies = {}) {
  const requireMobile = createRequire(resolve(mobileDirectory, "package.json"));
  const manifest =
    dependencies.mobileManifest ??
    JSON.parse(readFileSync(resolve(mobileDirectory, "package.json"), "utf8"));
  const installed = dependencies.expoManifest ?? requireMobile("expo/package.json");
  const expected = manifest.dependencies?.expo;
  if (
    !/^\d+\.\d+\.\d+$/u.test(expected ?? "") ||
    installed.name !== "expo" ||
    installed.version !== expected ||
    installed.bin?.expo !== "bin/cli"
  ) {
    throw new Error("Installed Expo must match its exact repository identity and version.");
  }
  return (dependencies.resolveExpo ?? (() => requireMobile.resolve("expo/bin/cli")))();
}

export function prepareWindowsExpo(arguments_, dependencies = {}) {
  const session =
    Array.isArray(arguments_) &&
    arguments_.length === 2 &&
    arguments_[0] === "start" &&
    arguments_[1] === "--localhost";
  const finite = [
    ["export", "--platform", "all", "--output-dir", "dist"],
    ["install", "--check"],
    ["config", "--type", "introspect", "--json"],
  ];
  if (
    !Array.isArray(arguments_) ||
    (!session &&
      !finite.some(
        (allowed) =>
          allowed.length === arguments_.length &&
          allowed.every((value, i) => value === arguments_[i]),
      ))
  )
    throw new TypeError(
      "Windows Expo requires a reviewed finite command or headless localhost session.",
    );
  const environment = dependencies.environment ?? process.env;
  const own = new Map();
  for (const name in environment) {
    if (!Object.hasOwn(environment, name))
      throw new TypeError("Inherited frontend environment entry.");
    const descriptor = Object.getOwnPropertyDescriptor(environment, name);
    const canonical = name.toUpperCase();
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.includes("\0") ||
      own.has(canonical)
    ) {
      throw new TypeError("Invalid or case-colliding frontend environment.");
    }
    own.set(canonical, descriptor.value);
  }
  const blocked = [
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "OPENSSL_CONF",
    "OPENSSL_MODULES",
    "GIT_SSL_NO_VERIFY",
    "CURL_INSECURE",
    "EXPO_OFFLINE",
  ];
  if (
    blocked.some((name) => own.has(name)) ||
    ["NPM_CONFIG_STRICT_SSL", "PNPM_CONFIG_STRICT_SSL"].some(
      (name) => own.get(name)?.toLowerCase() === "false",
    ) ||
    ["NPM_CONFIG_OFFLINE", "PNPM_CONFIG_OFFLINE"].some((name) =>
      /^(?:1|true)$/iu.test(own.get(name) ?? ""),
    ) ||
    ["EXPO_NO_DEPENDENCY_VALIDATION", "EXPO_NO_NEW_ARCH_COMPAT_CHECK"].some(
      (name) => own.has(name) && own.get(name) !== "0",
    ) ||
    (own.has("EXPO_NO_DOTENV") && own.get("EXPO_NO_DOTENV") !== "1")
  ) {
    throw new TypeError("Windows Expo refuses runtime injection, offline and validation bypasses.");
  }
  const apiOrigin = own.get("EXPO_PUBLIC_API_URL");
  const profile = own.get("EXPO_PUBLIC_NOURISHING_PROFILE");
  validateExpoProfile(Object.fromEntries(own));
  if (
    !["https://dev-api.nourishing.app", "https://native-qualification.invalid"].includes(apiOrigin)
  ) {
    throw new TypeError(
      "Select the exact hosted development or synthetic qualification API origin.",
    );
  }
  const readdir = dependencies.readdir ?? readdirSync;
  for (const directory of [repositoryRoot, mobileDirectory]) {
    if (
      readdir(directory).some((name) => /^\.env(?:\.|$)/iu.test(name) && name !== ".env.example")
    ) {
      throw new TypeError("Windows Expo refuses implicit private dotenv files.");
    }
  }
  const executable = dependencies.execPath ?? process.execPath;
  const systemRoot = own.get("SYSTEMROOT");
  if (!win32.isAbsolute(executable) || !systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new TypeError("Windows Node and SystemRoot must be absolute paths.");
  }
  const projected = {};
  for (const [canonical, name] of [
    ["SYSTEMROOT", "SystemRoot"],
    ["WINDIR", "WINDIR"],
    ["TEMP", "TEMP"],
    ["TMP", "TMP"],
    ["USERPROFILE", "USERPROFILE"],
    ["APPDATA", "APPDATA"],
    ["LOCALAPPDATA", "LOCALAPPDATA"],
  ]) {
    if (own.has(canonical)) projected[name] = own.get(canonical);
  }
  Object.assign(projected, {
    PATH: `${win32.dirname(executable)};${win32.join(systemRoot, "System32")}`,
    ...(session ? {} : { CI: "1" }),
    NODE_ENV: arguments_[0] === "export" ? "production" : "development",
    BABEL_ENV: arguments_[0] === "export" ? "production" : "development",
    __UNSAFE_EXPO_HOME_DIRECTORY: expoHome,
    EXPO_NO_TELEMETRY: "1",
    EXPO_NO_DOTENV: "1",
    EXPO_UNSTABLE_HEADLESS: "1",
    EXPO_NO_DEPENDENCY_VALIDATION: "0",
    EXPO_NO_NEW_ARCH_COMPAT_CHECK: "0",
    EXPO_PUBLIC_API_URL: apiOrigin,
    ...(profile === undefined ? {} : { EXPO_PUBLIC_NOURISHING_PROFILE: profile }),
  });
  return {
    executable,
    arguments: [
      resolveExpoCli(dependencies),
      ...arguments_,
      ...(session ? ["--port", "8081"] : []),
    ],
    cwd: mobileDirectory,
    environment: projected,
    timeoutMs: session ? 3_600_000 : arguments_[0] === "export" ? 240_000 : 120_000,
    ...(session ? { session: true } : {}),
    maxOutputBytes: arguments_[0] === "config" ? 20_000_000 : 4_000_000,
    powershellPath: own.get("NOURISHING_POWERSHELL"),
  };
}

async function executeWindowsExpo(arguments_, dependencies) {
  const plan = prepareWindowsExpo(arguments_, dependencies);
  (dependencies.mkdir ?? mkdirSync)(expoHome, { recursive: true });
  return await (dependencies.runWindowsOwnedProcess ?? runWindowsOwnedProcess)(
    { ...plan, signal: dependencies.signal },
    plan.session
      ? { onOutput: ({ stream, bytes }) => (dependencies[stream] ?? process[stream]).write(bytes) }
      : {},
  );
}

export async function readExpoNativeConfig(dependencies = {}) {
  const arguments_ = ["config", "--type", "introspect", "--json"];
  if ((dependencies.platform ?? process.platform) === "win32") {
    const result = await executeWindowsExpo(arguments_, dependencies);
    return JSON.parse(result.stdout);
  }
  validateExpoProfile(dependencies.environment ?? process.env);
  (dependencies.mkdir ?? mkdirSync)(expoHome, { recursive: true });
  const result = (dependencies.spawnSync ?? spawnSync)(
    dependencies.execPath ?? process.execPath,
    [resolveExpoCli(dependencies), ...arguments_],
    {
      encoding: "utf8",
      env: {
        ...(dependencies.environment ?? process.env),
        __UNSAFE_EXPO_HOME_DIRECTORY: expoHome,
        EXPO_NO_TELEMETRY: "1",
      },
      maxBuffer: 20_000_000,
      shell: false,
      cwd: mobileDirectory,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error("Expo native configuration introspection failed.");
  return JSON.parse(result.stdout);
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
  const groupExists =
    dependencies.groupExists ??
    ((pid) => {
      try {
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
      kill(-child.pid, signal);
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
  if ((dependencies.platform ?? process.platform) === "win32") {
    const writeOutput = ({ stdout = "", stderr = "" }) => {
      (dependencies.stdout ?? process.stdout).write(stdout);
      (dependencies.stderr ?? process.stderr).write(stderr);
    };
    const session = arguments_[0] === "start";
    try {
      const result = await executeWindowsExpo(arguments_, dependencies);
      if (session) return result;
      writeOutput(result);
    } catch (error) {
      if (!session && error instanceof WindowsOwnedProcessError) writeOutput(error.result);
      throw error;
    }
    return;
  }
  validateExpoProfile(dependencies.environment ?? process.env);
  const expoEntry = resolveExpoCli(dependencies);
  const mkdir = dependencies.mkdir ?? mkdirSync;
  mkdir(expoHome, { recursive: true });

  const spawn = dependencies.spawn ?? spawnProcess;
  let child;
  try {
    child = spawn(dependencies.execPath ?? process.execPath, [expoEntry, ...arguments_], {
      cwd: mobileDirectory,
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
