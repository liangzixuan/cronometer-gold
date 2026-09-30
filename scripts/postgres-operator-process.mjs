import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { kill as killProcess } from "node:process";
import { Readable, Transform, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";

const MAX_TOOL_BYTES = 134_217_728;
const STDERR_BYTES = 65_536;
const TERMINATE_MS = 2_000;
const failure = (phase) => new Error("PostgreSQL local backup " + phase + " failed");
export class ChildCleanupError extends AggregateError {
  constructor() {
    super(
      [failure("tool"), failure("child cleanup")],
      "PostgreSQL local backup child cleanup failed",
    );
  }
}
const requireValue = (condition) => {
  if (!condition) throw failure("configuration");
};

export async function trustedPath(path, { directory = false, privateLeaf = false } = {}) {
  requireValue(
    typeof path === "string" &&
      isAbsolute(path) &&
      resolve(path) === path &&
      !path.includes("\0") &&
      !path.includes("\r") &&
      !path.includes("\n"),
  );
  requireValue((await realpath(path)) === path);
  let current = path;
  while (true) {
    const entry = await lstat(current);
    requireValue(!entry.isSymbolicLink() && (entry.uid === 0 || entry.uid === process.getuid()));
    const writable = entry.mode & 0o022;
    requireValue(
      !writable ||
        (current !== path && entry.isDirectory() && entry.mode & 0o1000 && entry.uid === 0),
    );
    if (current === path) {
      requireValue(directory ? entry.isDirectory() : entry.isFile());
      if (privateLeaf)
        requireValue(entry.uid === process.getuid() && (entry.mode & 0o777) === 0o700);
    }
    if (current === "/") break;
    current = dirname(current);
  }
}

async function toolDigest(tool) {
  await trustedPath(tool.path);
  const handle = await open(tool.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireValue(
      stat.isFile() && stat.size > 0 && stat.size <= MAX_TOOL_BYTES && (stat.mode & 0o111) !== 0,
    );
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    requireValue(hash.digest("hex") === tool.sha256);
  } finally {
    await handle.close();
  }
}

const SUPERVISOR = String.raw`
const { spawn } = require("node:child_process");
let started = false;
setInterval(() => {}, 1000);
process.on("SIGTERM", () => {});
process.on("disconnect", () => process.kill(-process.pid, "SIGKILL"));
process.on("message", (message) => {
  if (started || !message || message.type !== "start") {
    process.kill(-process.pid, "SIGKILL");
    return;
  }
  started = true;
  let failed = false;
  const tool = spawn(process.argv[1], process.argv.slice(2), {
    shell: false, stdio: [0, 1, 2], env: process.env,
  });
  tool.once("error", () => { failed = true; });
  tool.once("close", (code, signal) => {
    process.send({
      type: "status", exitCode: failed ? null : code,
      signal: failed ? null : signal, spawnFailed: failed,
    });
  });
});
process.send({ type: "ready" });
`;

async function processIdentity(pid) {
  try {
    const value = await readFile("/proc/" + pid + "/stat", "utf8");
    requireValue(value.length <= 4096);
    const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
    requireValue(fields.length >= 20 && /^[0-9]+$/u.test(fields[19]));
    return {
      pid,
      state: fields[0],
      group: Number(fields[2]),
      session: Number(fields[3]),
      start: fields[19],
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return undefined;
    throw failure("process observation");
  }
}

/** Observation never sends signals after the pinned supervisor has been reaped. */
async function observeGroupTermination(identity) {
  const deadline = performance.now() + 5_000;
  while (true) {
    const replacement = await processIdentity(identity.pid);
    if (replacement && replacement.start !== identity.start) return;
    const names = await readdir("/proc");
    requireValue(names.length <= 65_536);
    let running = false;
    for (const name of names) {
      if (!/^[1-9][0-9]{0,9}$/u.test(name)) continue;
      const entry = await processIdentity(Number(name));
      if (
        entry?.group === identity.pid &&
        entry.session === identity.pid &&
        !["Z", "X"].includes(entry.state)
      ) {
        running = true;
        break;
      }
    }
    if (!running) return; // Zombies are terminated; their reaping belongs to their parent.
    if (performance.now() >= deadline) throw failure("group cleanup");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The fixed supervisor pins the PGID until our final group KILL. */
export async function runTool(
  tool,
  args,
  { signal, env, directory, limit, outputPath, input, inputBytes },
) {
  requireValue(
    input === undefined ||
      (input instanceof Readable &&
        Number.isSafeInteger(inputBytes) &&
        inputBytes > 0 &&
        inputBytes <= 2_147_483_648),
  );
  signal.throwIfAborted();
  await toolDigest(tool);
  signal.throwIfAborted();
  let child, closed, identity, timer, startupTimer;
  let childClosed = false,
    childExited = false,
    finalSignalAttempted = false,
    ready = false,
    status,
    stopped = false,
    killed = false;
  let failed = false,
    cleanupFailed = false;
  let inputComplete = input === undefined;
  let outputBytes = 0;
  let control = Promise.resolve();
  const startedStreams = [];
  const hash = createHash("sha256");
  const chunks = [];
  const destination = outputPath
    ? createWriteStream(outputPath, { flags: "wx", mode: 0o600 })
    : new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          done();
        },
      });
  destination.on("error", () => undefined);
  const destinationClosed = finished(destination, { cleanup: true }).catch(() => undefined);
  const send = (name) => {
    // The supervisor ignores TERM and never exits voluntarily. Its live ownership pins this PGID.
    if (finalSignalAttempted) return;
    if (childExited || childClosed || !Number.isSafeInteger(child?.pid) || child.pid < 2) {
      cleanupFailed = true;
      return;
    }
    if (name === "SIGKILL") finalSignalAttempted = true;
    try {
      killProcess(-child.pid, name);
      if (name === "SIGKILL") killed = true;
    } catch (error) {
      if (error?.code !== "ESRCH") cleanupFailed = true;
    }
  };
  const terminate = () => {
    if (stopped) return;
    stopped = true;
    if (ready && !childExited && !finalSignalAttempted) {
      send("SIGTERM");
      timer = setTimeout(() => send("SIGKILL"), TERMINATE_MS);
    }
    input?.destroy();
    child?.stdin?.destroy();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    destination.destroy();
  };
  const protocolFailure = () => {
    failed = true;
    if (!finalSignalAttempted && !childExited && !childClosed) send("SIGKILL");
  };
  let output;
  try {
    child = spawn(process.execPath, ["-e", SUPERVISOR, tool.path, ...args], {
      cwd: directory,
      env,
      detached: true,
      shell: false,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe", "ipc"],
    });
    closed = new Promise((done) => {
      child.once("error", () => {
        failed = true;
      });
      child.once("exit", () => {
        childExited = true;
        if (!finalSignalAttempted) {
          failed = true;
          cleanupFailed = true;
        }
      });
      child.once("close", () => {
        childClosed = true;
        done();
      });
    });
    startupTimer = setTimeout(protocolFailure, 5_000);
    child.on("message", (message) => {
      control = control
        .then(async () => {
          if (!message || typeof message !== "object") return protocolFailure();
          if (message.type === "ready" && Object.keys(message).join(",") === "type" && !ready) {
            identity = await processIdentity(child.pid);
            if (
              !identity ||
              identity.group !== child.pid ||
              identity.session !== child.pid ||
              childExited ||
              childClosed
            )
              return protocolFailure();
            ready = true;
            clearTimeout(startupTimer);
            if (stopped || signal.aborted) {
              stopped = true;
              send("SIGTERM");
              timer = setTimeout(() => send("SIGKILL"), TERMINATE_MS);
            } else
              child.send({ type: "start" }, (error) => {
                if (error) protocolFailure();
              });
            return;
          }
          if (
            message.type !== "status" ||
            !ready ||
            status ||
            Object.keys(message).sort().join(",") !== "exitCode,signal,spawnFailed,type" ||
            typeof message.spawnFailed !== "boolean" ||
            !(message.spawnFailed
              ? message.exitCode === null && message.signal === null
              : (Number.isInteger(message.exitCode) &&
                  message.exitCode >= 0 &&
                  message.exitCode <= 255 &&
                  message.signal === null) ||
                (message.exitCode === null &&
                  typeof message.signal === "string" &&
                  /^SIG[A-Z0-9]{1,16}$/u.test(message.signal)))
          )
            return protocolFailure();
          status = Object.freeze({ ...message });
          if (!inputComplete) {
            failed = true;
            input?.destroy();
            child.stdin?.destroy();
          }
          if (!stopped) send("SIGKILL");
        })
        .catch(protocolFailure);
    });
    if (input) {
      let count = 0;
      const inputCounter = new Transform({
        transform(chunk, _encoding, done) {
          count += chunk.byteLength;
          if (count > inputBytes) done(failure("input limit"));
          else done(null, chunk);
        },
        flush(done) {
          if (count !== inputBytes) done(failure("input length"));
          else done();
        },
      });
      startedStreams.push(
        pipeline(input, inputCounter, child.stdin).then(
          () => {
            inputComplete = true;
          },
          () => {
            failed = true;
            terminate();
          },
        ),
      );
    }
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
    const counter = new Transform({
      transform(chunk, _encoding, done) {
        outputBytes += chunk.byteLength;
        if (outputBytes > limit) done(failure("output limit"));
        else {
          hash.update(chunk);
          done(null, chunk);
        }
      },
    });
    startedStreams.push(
      pipeline(child.stdout, counter, destination).catch(() => {
        failed = true;
        terminate();
      }),
    );
    startedStreams.push(
      (async () => {
        let count = 0;
        for await (const chunk of child.stderr) {
          count += chunk.byteLength;
          if (count > STDERR_BYTES) throw failure("diagnostic limit");
        }
      })().catch(() => {
        failed = true;
        terminate();
      }),
    );
    await closed;
    await control;
    await Promise.all(startedStreams);
    if (!identity || !killed) cleanupFailed = true;
    if (
      !status ||
      status.spawnFailed ||
      status.exitCode !== 0 ||
      status.signal ||
      signal.aborted ||
      failed
    )
      failed = true;
    output = {
      bytes: outputBytes,
      sha256: hash.digest("hex"),
      text: outputPath ? undefined : Buffer.concat(chunks).toString("utf8"),
    };
  } catch {
    failed = true;
    if (child && !childExited && !childClosed && !finalSignalAttempted) send("SIGKILL");
  } finally {
    if (closed) await closed;
    await control;
    await Promise.all(startedStreams);
    clearTimeout(timer);
    clearTimeout(startupTimer);
    signal.removeEventListener("abort", terminate);
    input?.destroy();
    child?.stdin?.destroy();
    destination.destroy();
    await destinationClosed;
    if (identity) {
      try {
        await observeGroupTermination(identity);
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed) throw new ChildCleanupError();
  if (failed) throw failure("tool");
  return output;
}
