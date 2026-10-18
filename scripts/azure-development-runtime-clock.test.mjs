import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runtimeAssemblyFixture } from "./azure-development-runtime-assembly-fixture.mjs";
import { runtimeClockFixture } from "./azure-development-runtime-clock-fixture.mjs";
import { runtimeDockerFixture } from "./azure-development-runtime-fixture.mjs";

for (const timestamp of ["2026-10-18T23:59:00.000Z", "2026-10-19T00:01:00.000Z"])
  test(`source clock qualifies the actual two-hour assembly from ${timestamp}`, async (t) => {
    const restore = runtimeClockFixture({ wallTime: Date.parse(timestamp) });
    t.after(restore);
    const base = await runtimeDockerFixture(t, { parent: homedir() });
    const assembly = await runtimeAssemblyFixture(base.root);
    const output = join(base.root, "recovery/prepared-clock-bundle.json");
    const args = [
      assembly.assemblyInput.path,
      assembly.assemblyInput.sha256,
      assembly.contextSource,
      assembly.assemblySource,
      new Date().toISOString(),
      new Date(Date.now() + 900_000).toISOString(),
      output,
    ];
    const prepared = JSON.parse(await assembly.command(["prepare", ...args]));
    const bytes = await readFile(output);
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.deepEqual(JSON.parse(await assembly.command(["qualify", ...args, digest])), prepared);
    const manifest = JSON.parse(await readFile(join(base.root, "recovery/recovery-manifest.json")));
    assert.equal(
      Date.parse(manifest.lease.shutdown_at_utc) - Date.parse(manifest.lease.started_at_utc),
      7_200_000,
    );
    assert.equal(manifest.lease.shutdown_at_utc.slice(0, 10), timestamp.slice(0, 10));
    assert.equal(new Date().getUTCHours(), 12);
    assert.equal(prepared.operationalAcceptance, false);
  });

test("source clock preserves Date behavior and advances all three clocks by the finite hold", () => {
  const NativeDate = Date;
  const existingDate = new NativeDate();
  const nativeHrtime = process.hrtime.bigint;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "performance");
  let offset = 0;
  const restore = runtimeClockFixture({
    wallTime: Date.parse("2026-10-18T23:59:00.000Z"),
    offset: () => offset,
  });
  try {
    const wall = Date.now(),
      mono = performance.now(),
      hr = process.hrtime.bigint();
    offset = 900_000;
    assert(Math.abs(Date.now() - wall - offset) < 1000);
    assert(Math.abs(performance.now() - mono - offset) < 1000);
    assert(Math.abs(Number(process.hrtime.bigint() - hr) / 1e6 - offset) < 1000);
    assert(Math.abs(new Date().getTime() - Date.now()) < 1000);
    assert(existingDate instanceof Date && new Date() instanceof NativeDate);
    assert.equal(new Date("2000-01-01T00:00:00.000Z").toISOString(), "2000-01-01T00:00:00.000Z");
    assert.equal(Date.parse("2000-01-01T00:00:00.000Z"), 946684800000);
    assert.equal(typeof Date(), "string");
  } finally {
    restore();
  }
  assert.equal(Date, NativeDate);
  assert.equal(process.hrtime.bigint, nativeHrtime);
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, "performance"), descriptor);
});
