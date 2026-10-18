import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["SIGINT", "SIGTERM"] as const)(
  "settles replay and database closure after repeated %s signals",
  async (signal) => {
    const root = await mkdtemp(join(tmpdir(), "nutrition-replay-cli-"));
    const now = Date.now();
    const sas = new URLSearchParams({
      sv: "2026-04-06",
      spr: "https",
      sr: "c",
      sp: "rl",
      sig: "synthetic-signature",
      st: new Date(now - 60_000).toISOString(),
      se: new Date(now + 600_000).toISOString(),
      skoid: "11111111-1111-4111-8111-111111111111",
      sktid: "22222222-2222-4222-8222-222222222222",
      skt: new Date(now - 120_000).toISOString(),
      ske: new Date(now + 900_000).toISOString(),
      sks: "b",
      skv: "2026-04-06",
    }).toString();
    const child = spawn(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("../test/erasure-restore-cli-loader.mjs", import.meta.url)),
        fileURLToPath(new URL("./erasure-ledger-restore.ts", import.meta.url)),
      ],
      {
        env: {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          NODE_ENV: "test",
          DATABASE_RESTORE_EPOCH: "synthetic-cli-restore-epoch-".repeat(3),
          ERASURE_REPLAY_LEDGER_STORE: "azure",
          ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER: "azure_blob",
          ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL:
            "https://nourishingrecovery.blob.core.windows.net/ledger",
          ERASURE_REPLAY_LEDGER_AZURE_PREFIX: "ledger/",
          ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS: sas,
          ERASURE_REPLAY_LEDGER_RESTORE_SPOOL_DIR: root,
          ERASURE_REPLAY_LEDGER_CURRENT_KEY_ID: "aes",
          ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS: JSON.stringify({
            aes: Buffer.alloc(32, 7).toString("base64"),
          }),
          ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID: "locator",
          ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS: JSON.stringify({
            locator: Buffer.alloc(32, 8).toString("base64"),
          }),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
    let output = "";
    const messages: unknown[] = [];
    child.on("message", (message) => messages.push(message));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, childSignal) => resolve({ code, signal: childSignal }));
      },
    );
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => {
        output += chunk.toString();
      });
    const next = async () => {
      const deadline = Date.now() + 5_000;
      while (!messages.length) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline)
          throw new Error("Controlled replay child did not reach its expected phase");
        await delay(10);
      }
      return messages.shift();
    };
    try {
      expect(await next()).toBe("migration");
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(child.kill(signal)).toBe(true);
        await delay(50);
        child.send("listeners");
        expect(await next()).toMatchObject({ [signal]: 1 });
      }
      child.send("release-migration");
      expect(await next()).toBe("cleanup");
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(child.kill(signal)).toBe(true);
        await delay(50);
        child.send("listeners");
        expect(await next()).toMatchObject({ [signal]: 1 });
      }
      child.send("release-cleanup");
      expect(await exited).toEqual({ code: 1, signal: null });
      expect(output.length).toBeLessThan(8_192);
      expect(output).toContain('"event":"erasure_restore.failed"');
      expect(output).not.toContain("erasure_restore.reconciled");
      expect(output).not.toContain(sas);
      expect(output).not.toContain(root);
      expect(output).not.toContain("synthetic-cli-restore-epoch");
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
