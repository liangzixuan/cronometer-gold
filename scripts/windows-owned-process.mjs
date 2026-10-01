import { spawn as spawnProcess } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const controller = fileURLToPath(new URL("./windows-owned-process.ps1", import.meta.url));
const maximumOutputBytes = 20_000_000;
const maximumTimeoutMs = 240_000;

export class WindowsOwnedProcessError extends Error {
  constructor(reason, result = {}) {
    super(`Windows command failed: ${reason}.`);
    this.name = "WindowsOwnedProcessError";
    this.result = result;
  }
}

function plainEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("An explicit environment is required.");
  }
  const names = new Set();
  const result = {};
  for (const name in environment) {
    if (!Object.hasOwn(environment, name)) throw new TypeError("Inherited environment entry.");
    const descriptor = Object.getOwnPropertyDescriptor(environment, name);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new TypeError("Environment values must be own strings.");
    }
    const canonical = name.toUpperCase();
    if (!name || /[=\0]/u.test(name) || descriptor.value.includes("\0") || names.has(canonical)) {
      throw new TypeError("Invalid or case-colliding environment entry.");
    }
    names.add(canonical);
    Object.defineProperty(result, name, { value: descriptor.value, enumerable: true });
  }
  return result;
}

function powerShellExecutable(explicit, environment) {
  const candidates = explicit
    ? [explicit]
    : (environment.PATH ?? environment.Path ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, "pwsh.exe"));
  for (const path of candidates) {
    if (typeof path !== "string" || !isAbsolute(path) || !/[/\\]pwsh\.exe$/iu.test(path)) continue;
    try {
      const metadata = lstatSync(path);
      if (metadata.isFile() && !metadata.isSymbolicLink()) return realpathSync(path);
    } catch {
      // Try the next ordinary PATH entry; never install or invoke a command shim.
    }
  }
  throw new TypeError("PowerShell 7 pwsh.exe is required; set NOURISHING_POWERSHELL explicitly.");
}

export function validateWindowsProcessRequest(options) {
  if (!options || typeof options !== "object") throw new TypeError("A command is required.");
  for (const value of [options.executable, options.cwd]) {
    if (typeof value !== "string" || !value || value.includes("\0") || !isAbsolute(value)) {
      throw new TypeError("Executable and working directory must be absolute paths.");
    }
  }
  if (
    !Array.isArray(options.arguments) ||
    options.arguments.length > 128 ||
    options.arguments.some((value) => typeof value !== "string" || value.includes("\0"))
  )
    throw new TypeError("Literal string arguments are required.");
  const timeoutMs = options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > maximumTimeoutMs ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > maximumOutputBytes
  ) {
    throw new TypeError("Finite command and output limits are required.");
  }
  const request = {
    executable: options.executable,
    arguments: options.arguments,
    cwd: options.cwd,
    environment: plainEnvironment(options.environment),
    timeoutMs,
    maxOutputBytes,
  };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > 65_536) {
    throw new TypeError("Windows command request is too large.");
  }
  return request;
}

export async function runWindowsOwnedProcess(options, observers = {}, dependencies = {}) {
  const request = validateWindowsProcessRequest(options);
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") throw new TypeError("This adapter requires Windows.");
  if (options.signal?.aborted) throw new WindowsOwnedProcessError("cancelled before launch");
  const powershell = (dependencies.resolvePowerShell ?? powerShellExecutable)(
    options.powershellPath,
    dependencies.powerShellSearchEnvironment ?? process.env,
  );
  const environment = {};
  for (const [name, value] of Object.entries(request.environment)) {
    if (
      ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].includes(
        name.toUpperCase(),
      )
    ) {
      environment[name] = value;
    }
  }
  environment.PATH = dirname(powershell);
  const spawn = dependencies.spawn ?? spawnProcess;
  return await new Promise((resolveCompletion, rejectCompletion) => {
    let child;
    let terminal;
    let failure;
    let protocol = "";
    let outputBytes = 0;
    let started = false;
    let forcedController = false;
    let timer;
    let cancellationTimer;
    let settlementTimer;
    let settled = false;
    const chunks = { stdout: [], stderr: [] };
    const runtime = dependencies.signalRuntime ?? process;
    const handlers = new Map();
    const dispose = () => {
      clearTimeout(timer);
      clearTimeout(cancellationTimer);
      clearTimeout(settlementTimer);
      options.signal?.removeEventListener("abort", abort);
      for (const [signal, handler] of handlers) runtime.removeListener(signal, handler);
    };
    const fail = (reason) => {
      if (failure || settled) return;
      failure = reason;
      if (!child) return;
      if (!child.stdin.destroyed) child.stdin.write("C", () => {});
      cancellationTimer = setTimeout(() => {
        forcedController = true;
        // Node retains this child's process handle; controller loss closes its private job.
        try {
          child.kill();
        } catch {
          /* Settlement still has to be observed. */
        }
        if (settled) return;
        settlementTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          dispose();
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref?.();
          rejectCompletion(
            new WindowsOwnedProcessError("controller cleanup could not be verified", {
              forcedController: true,
              cleanupVerified: false,
              stdout: Buffer.concat(chunks.stdout).toString("utf8"),
              stderr: Buffer.concat(chunks.stderr).toString("utf8"),
            }),
          );
        }, 3_000);
      }, 10_000);
    };
    const observe = (name, event) => {
      try {
        observers[name]?.(event);
      } catch {
        fail("observer failed");
      }
    };
    const abort = () => fail("cancelled");
    const consume = (line) => {
      const kind = line.slice(0, 2);
      const value = line.slice(2);
      if (terminal) return fail("output after terminal result");
      if (kind === "S:") {
        if (started || !/^[1-9][0-9]*$/u.test(value)) return fail("invalid start event");
        const pid = Number(value);
        if (!Number.isSafeInteger(pid)) return fail("invalid process identity");
        started = true;
        clearTimeout(timer);
        timer = setTimeout(
          () => fail("controller exceeded command budget"),
          request.timeoutMs + 5_000,
        );
        observe("onStarted", { pid });
      } else if (kind === "O:" || kind === "E:") {
        if (
          !started ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
        ) {
          return fail("invalid output frame");
        }
        const bytes = Buffer.from(value, "base64");
        if (bytes.length > 4_096 || outputBytes + bytes.length > request.maxOutputBytes) {
          return fail("output limit exceeded");
        }
        outputBytes += bytes.length;
        const stream = kind === "O:" ? "stdout" : "stderr";
        chunks[stream].push(bytes);
        observe("onOutput", { stream, bytes });
      } else if (kind === "R:") {
        try {
          terminal = JSON.parse(value);
        } catch {
          fail("invalid terminal result");
        }
      } else fail("invalid controller frame");
    };
    try {
      child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", controller], {
        cwd: request.cwd,
        env: environment,
        shell: false,
        // The controller accepts only no console or its own self-only console.
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      rejectCompletion(new WindowsOwnedProcessError("controller could not start"));
      return;
    }
    timer = setTimeout(() => fail("controller startup exceeded budget"), 20_000);
    child.stdin.on("error", () => fail("controller control pipe failed"));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      protocol += data;
      let newline = protocol.indexOf("\n");
      while (newline >= 0) {
        const line = protocol.slice(0, newline).replace(/\r$/u, "");
        protocol = protocol.slice(newline + 1);
        if (line.length > 65_536) fail("controller frame exceeds limit");
        else consume(line);
        newline = protocol.indexOf("\n");
      }
      if (protocol.length > 65_536) {
        protocol = "";
        fail("controller frame exceeds limit");
      }
    });
    child.stderr.on("data", () => fail("controller reported an error"));
    child.once("error", () => fail("controller could not start"));
    child.once("close", (controllerStatus, controllerSignal) => {
      if (settled) return;
      settled = true;
      dispose();
      child.stdin.destroy();
      const result = {
        ...terminal,
        controllerStatus,
        controllerSignal,
        forcedController,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      };
      if (
        failure ||
        protocol.length ||
        controllerStatus !== 0 ||
        controllerSignal ||
        forcedController ||
        !terminal ||
        terminal.status !== 0 ||
        terminal.reason !== "completed" ||
        terminal.activeZero !== true ||
        terminal.outputDrained !== true ||
        terminal.forcedCleanup !== false
      ) {
        rejectCompletion(
          new WindowsOwnedProcessError(failure ?? "command did not complete naturally", result),
        );
      } else resolveCompletion(result);
    });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => fail(`cancelled by ${signal}`);
      handlers.set(signal, handler);
      runtime.on(signal, handler);
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdin.write(`${JSON.stringify(request)}\n`);
    observe("onController", { pid: child.pid });
    if (options.signal?.aborted) abort();
  });
}
