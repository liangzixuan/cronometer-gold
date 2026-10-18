/** Observe already acquired local images. Never pull, build, scan or qualify provenance here. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/contracts/dist/index.js";
import { runTool } from "./postgres-operator-process.mjs";
import { verifyRuntimeConfiguration } from "./verify-mailpit-image.mjs";

const SOURCE = resolve(fileURLToPath(new URL("../", import.meta.url))),
  sha = (value) => createHash("sha256").update(value).digest("hex");
const components = {
  API_IMAGE: "api",
  WORKER_IMAGE: "worker",
  MIGRATOR_IMAGE: "migrator",
  CADDY_IMAGE: "caddy",
  POSTGRES_IMAGE: "postgres",
  MEILI_IMAGE: "meilisearch",
  MAILPIT_IMAGE: "mailpit",
};
const failure = () => new Error("Prepared local runtime image admission failed");

export async function admitRuntimeImageObservations(input, execution = {}) {
  const images = Object.freeze({ ...input.images }),
    tools = structuredClone(input.tools),
    signal = input.signal,
    conserve = input.conserve,
    onObservation = input.onObservation,
    execute = execution.execute ?? runTool;
  const buffers = [];
  try {
    assert(
      signal instanceof AbortSignal &&
        typeof conserve === "function" &&
        typeof onObservation === "function",
    );
    assert(
      /^[a-f0-9]{40}$/u.test(input.sourceRevision) &&
        resolve(input.root) === input.root &&
        input.root !== "/",
    );
    assert.deepEqual(Object.keys(images).sort(), Object.keys(components).sort());
    for (const [name, component] of Object.entries(components))
      assert(
        new RegExp(
          `^ghcr\\.io/liangzixuan/cronometer-gold-${component}@sha256:[a-f0-9]{64}$`,
          "u",
        ).test(images[name]),
      );
    const command = async (tool, args, body) => {
      signal.throwIfAborted();
      await conserve();
      signal.throwIfAborted();
      const errors = [];
      let stderrBytes = 0;
      const startedAtUtc = new Date().toISOString();
      let raw,
        stdoutIntegrityVerified = false;
      try {
        raw = await execute(tool, args, {
          env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
          directory: SOURCE,
          limit: 524_288,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          ...(body ? { input: Readable.from([body]), inputBytes: body.length } : {}),
          onStderr: (chunk) => {
            assert(Buffer.isBuffer(chunk));
            stderrBytes += chunk.length;
            assert(stderrBytes <= 65_536);
            errors.push(Buffer.from(chunk));
          },
        });
        assert(
          typeof raw.text === "string" &&
            Buffer.byteLength(raw.text) <= 524_288 &&
            Buffer.byteLength(raw.text) === raw.bytes &&
            sha(raw.text) === raw.sha256 &&
            raw.stderrBytes === stderrBytes &&
            raw.stderrSha256 === sha(Buffer.concat(errors)),
        );
        stdoutIntegrityVerified = true;
        signal.throwIfAborted();
        await conserve();
        signal.throwIfAborted();
      } catch {
        const stderr = Buffer.concat(errors),
          stdoutAvailable = typeof raw?.text === "string" && Buffer.byteLength(raw.text) <= 524_288;
        await onObservation({
          phase: "runtime-image-observation-unconfirmed",
          command: args,
          startedAtUtc,
          endedAtUtc: new Date().toISOString(),
          completed: false,
          stdoutAvailable,
          stdoutIntegrityVerified,
          ...(stdoutAvailable ? { stdout: raw.text, stdoutSha256: sha(raw.text) } : {}),
          stderr: stderr.toString("base64"),
          stderrBytes: stderr.length,
          stderrSha256: sha(stderr),
        });
        throw failure();
      }
      await onObservation({
        phase: "runtime-image-observation",
        command: args,
        startedAtUtc,
        endedAtUtc: new Date().toISOString(),
        completed: true,
        stdout: raw.text,
        stdoutSha256: raw.sha256,
        stderr: Buffer.concat(errors).toString("base64"),
        stderrSha256: raw.stderrSha256,
      });
      signal.throwIfAborted();
      return raw.text;
    };
    const raw = await command(tools.docker, [
      "--host",
      "unix:///var/run/docker.sock",
      "--config",
      join(input.root, "docker-config"),
      "image",
      "inspect",
      ...Object.values(images),
    ]);
    const rows = JSON.parse(raw);
    assert(Array.isArray(rows) && rows.length === 7);
    const observations = {};
    for (const reference of Object.values(images)) {
      const matches = rows.filter(
        (row) => Array.isArray(row.RepoDigests) && row.RepoDigests.includes(reference),
      );
      assert(matches.length === 1);
      const row = matches[0];
      assert(
        /^sha256:[a-f0-9]{64}$/u.test(row.Id) && row.Os === "linux" && row.Architecture === "arm64",
      );
      observations[reference] = row;
    }
    assert(new Set(Object.values(observations).map((row) => row.Id)).size === 7);
    const mailpit = observations[images.MAILPIT_IMAGE];
    verifyRuntimeConfiguration(
      { config: mailpit.Config, os: mailpit.Os, architecture: mailpit.Architecture },
      input.sourceRevision,
      await readFile(join(SOURCE, "infra/docker/mailpit-build-inputs.json")),
      await readFile(join(SOURCE, "infra/docker/mailpit-NOTICES.txt")),
    );
    const backend = Object.fromEntries(
      Object.entries(images).filter(([name]) => name !== "MAILPIT_IMAGE"),
    );
    const body = Buffer.from(
      canonicalJson({
        schema_version: 1,
        source_revision: input.sourceRevision,
        images: backend,
        observations: Object.fromEntries(
          Object.values(backend).map((reference) => [reference, observations[reference]]),
        ),
      }),
    );
    buffers.push(body);
    const receipt = JSON.parse(
      await command(
        tools.python,
        ["-I", "-B", join(SOURCE, "infra/development/azure/runtime-image-observations.py")],
        body,
      ),
    );
    const expected = {
      kind: "nutrition-development-image-observations-v1",
      source_revision: input.sourceRevision,
      images: Object.fromEntries(
        Object.entries(backend).map(([name, reference]) => [
          name,
          { reference, image_id: observations[reference].Id },
        ]),
      ),
      localOnly: true,
      operationalAcceptance: false,
      provenanceQualified: false,
    };
    assert(canonicalJson(receipt) === canonicalJson(expected));
    await conserve();
    signal.throwIfAborted();
    return Object.freeze({
      kind: "nutrition-development-seven-local-images-v1",
      imageObservations: structuredClone(observations),
      sourceRevision: input.sourceRevision,
      localOnly: true,
      operationalAcceptance: false,
      provenanceQualified: false,
    });
  } catch {
    throw failure();
  } finally {
    for (const buffer of buffers) buffer.fill(0);
  }
}
