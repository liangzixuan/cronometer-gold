import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  query: vi.fn(),
  destroy: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  stage: vi.fn(),
}));
vi.mock("@nutrition-tracker/db", async (original) => ({
  ...(await original<typeof import("@nutrition-tracker/db")>()),
  createDatabaseFromEnvironment: mocks.create,
}));
vi.mock("../src/fdc-record-reader-v2.js", () => ({ openVerifiedFdcRecordExportV2: mocks.open }));
vi.mock("../src/fdc-csv-paged-stage.js", async (original) => ({
  ...(await original<typeof import("../src/fdc-csv-paged-stage.js")>()),
  stageVerifiedFdcCsvExportV2: mocks.stage,
}));

import {
  catalogueDocumentSha256V2,
  catalogueFramedSha256V2,
  createDatabase,
  encodeCataloguePreparationAdmissionV2,
  type JsonValue,
} from "@nutrition-tracker/db";
import {
  authenticatedReleaseEvidenceBundleSha256,
  canonicalJson,
  type FoodSourceManifestV4,
} from "@nutrition-tracker/ingestion";
import {
  type CatalogueValidationRequestFile,
  readCatalogueValidationRequest,
  writeCatalogueValidationRequest,
} from "../src/catalogue-validation-request.js";
import { prepareFdcCsvPagedStageIdentity } from "../src/fdc-csv-paged-stage.js";
import { runCommand } from "../src/run.js";
import {
  bindSyntheticReleaseEvidence,
  SYNTHETIC_EVIDENCE_EVALUATED_AT,
  writeCanonicalReleaseEvidence,
} from "./synthetic-release-evidence.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const BUILD = "b".repeat(64),
  MAPPING = "d".repeat(64),
  EXPORT = "e".repeat(64),
  ARTIFACT = "a".repeat(64);
const REVIEWER = "synthetic_quality",
  STAGER = "synthetic_stage";
const RUNNER = {
  authenticationMethod: "workload-identity" as const,
  principalId: "service:paged-stage-test",
  runId: "paged-stage-test",
  runReference: "urn:nutrition-tracker:test:paged-stage-test",
};
const cleanup: string[] = [];
let releaseDatabase: () => Promise<void>;
let responses: unknown[];

function principal(capability = "nutrition_catalogue_stage") {
  const name = capability === "nutrition_catalogue_stage" ? STAGER : REVIEWER;
  return {
    databasePrincipal: name,
    effectivePrincipal: name,
    canLogin: true,
    privileged: false,
    ownerMember: false,
    capabilities: [capability],
  };
}
function accepted(requestDocument: string) {
  const requestSha256 = catalogueDocumentSha256V2(requestDocument, 131072);
  return {
    schemaVersion: 2,
    admissionSha256: catalogueFramedSha256V2("admission", [requestSha256, REVIEWER]),
    requestSha256,
    admittedBy: REVIEWER,
    requestDocument,
  };
}
function pinBytes(path: string, bytes: string): CatalogueValidationRequestFile {
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: Buffer.byteLength(bytes),
  };
}
function option(argv: readonly string[], name: string, value: string): string[] {
  const result = [...argv],
    index = result.indexOf(`--${name}`);
  if (index < 0) return [...result, `--${name}`, value];
  result[index + 1] = value;
  return result;
}
function admissionArgs(pin: CatalogueValidationRequestFile) {
  return [
    "catalogue",
    "admit-paged",
    "--request",
    pin.path,
    "--request-sha256",
    pin.sha256,
    "--request-bytes",
    String(pin.byteSize),
  ];
}
function requestPath() {
  const path = `.local-data/evidence/catalogue-validation/paged-stage-command-${randomUUID()}.json`;
  cleanup.push(resolve(ROOT, path));
  return path;
}
async function retained(document: JsonValue) {
  return writeCatalogueValidationRequest(requestPath(), document, ROOT);
}
function capture(overrides: NodeJS.ProcessEnv = {}) {
  const output: unknown[] = [],
    errors: string[] = [];
  return {
    output,
    errors,
    io: {
      environment: {
        DATABASE_URL: "postgresql://never-connected@127.0.0.1:1/test",
        INGEST_AUTHENTICATION_METHOD: RUNNER.authenticationMethod,
        INGEST_AUTHENTICATED_PRINCIPAL_ID: RUNNER.principalId,
        INGEST_AUTHENTICATION_RUN_REFERENCE: RUNNER.runReference,
        INGEST_PARSER_BUILD_SHA256: BUILD,
        ...overrides,
      },
      now: () => new Date(SYNTHETIC_EVIDENCE_EVALUATED_AT),
      writeOutput: (value: string) => output.push(JSON.parse(value)),
      writeError: (value: string) => errors.push(value),
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  responses = [];
  // The real compiler and client authority checks run; every executor call is
  // intercepted before driver acquisition, so this suite cannot connect to PG.
  const database = createDatabase({
    connectionString: "postgresql://never-connected@127.0.0.1:1/test",
  });
  releaseDatabase = database.destroy.bind(database);
  vi.spyOn(database.getExecutor(), "executeQuery").mockImplementation(mocks.query);
  vi.spyOn(database, "destroy").mockImplementation(mocks.destroy);
  mocks.create.mockReturnValue(database);
  mocks.destroy.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.query.mockImplementation(async () => {
    if (responses.length === 0) throw new Error("Unexpected SQL capability call");
    const result = responses.shift();
    if (result instanceof Error) throw result;
    return { rows: [{ result }] };
  });
  mocks.open.mockResolvedValue({
    evidence: { sha256: EXPORT, byteSize: 12345 },
    close: mocks.close,
  });
  mocks.stage.mockResolvedValue({
    schemaVersion: 2,
    status: "sealed",
    validationPending: true,
    activationAuthorized: false,
  });
});
afterEach(async () => {
  await releaseDatabase();
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("paged stage CLI admission boundaries", () => {
  it("prepares exact reviewed limits and authenticated identities without DB or export allocation", async () => {
    const fixture = await commandFixture();
    const path = requestPath(),
      result = capture();
    expect(await runCommand(fixture.prepare(path), result.io), result.errors.join("\n")).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(result.output).toHaveLength(1);
    const output = result.output[0] as { request: CatalogueValidationRequestFile };
    expect(await readCatalogueValidationRequest(path, output.request, ROOT)).toEqual({
      schemaVersion: 2,
      requestDocument: fixture.document,
    });
    expect(result.output[0]).toMatchObject({
      kind: "prepared-catalogue-admission-v2",
      admissionSubmitted: false,
    });
  });

  it.each([
    ["max-records", "0"],
    ["max-payload-text-bytes", "01"],
    ["max-intermediate-bytes", "9007199254740992"],
    ["max-validation-evidence-bytes", "-1"],
    ["max-reconciliation-evidence-bytes", "1e6"],
    ["max-baseline-records", "-1"],
    ["records-bytes", "012345"],
    ["records-sha256", "invalid"],
  ])("rejects invalid --%s before retained output or DB allocation", async (name, value) => {
    const fixture = await commandFixture(),
      path = requestPath(),
      result = capture();
    expect(await runCommand(option(fixture.prepare(path), name, value), result.io)).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(result.output).toEqual([]);
    await expect(readFile(resolve(ROOT, path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { INGEST_PARSER_BUILD_SHA256: "f".repeat(64) },
    { INGEST_AUTHENTICATED_PRINCIPAL_ID: "service:someone-else" },
  ])("preserves existing trusted build and evidence-runner gates %j", async (environment) => {
    const fixture = await commandFixture(),
      result = capture(environment);
    expect(await runCommand(fixture.prepare(requestPath()), result.io)).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(result.output).toEqual([]);
  });

  it("submits only exact canonical bytes using the actual restricted quality-principal check", async () => {
    const fixture = await commandFixture(),
      pin = await retained({ schemaVersion: 2, requestDocument: fixture.document });
    const receipt = accepted(fixture.document),
      { requestDocument: _document, ...response } = receipt;
    responses.push(principal("nutrition_catalogue_approve_quality"), response);
    const result = capture();
    mocks.destroy.mockImplementation(async () => {
      expect(result.output).toEqual([]);
    });
    expect(await runCommand(admissionArgs(pin), result.io), result.errors.join("\n")).toBe(0);
    expect(mocks.query.mock.calls[0]?.[0].sql).toContain("session_user");
    expect(mocks.query.mock.calls[1]?.[0]).toMatchObject({ parameters: [fixture.document] });
    expect(mocks.query.mock.calls[1]?.[0].sql).toContain("catalogue_admit_preparation_v2");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(result.output).toEqual([{ request: pin, receipt: response }]);
  });

  it.each([
    "wrong-sha",
    "wrong-size",
    "changed-content",
    "noncanonical-wrapper",
    "noncanonical-document",
    "extra-envelope-field",
    "extra-document-field",
  ])("rejects %s before creating a database", async (change) => {
    const fixture = await commandFixture();
    let document: JsonValue = { schemaVersion: 2, requestDocument: fixture.document };
    if (change === "noncanonical-document")
      document = { schemaVersion: 2, requestDocument: `${fixture.document} ` };
    if (change === "extra-envelope-field")
      document = { ...(document as object), unexpected: true } as JsonValue;
    if (change === "extra-document-field")
      document = {
        schemaVersion: 2,
        requestDocument: canonicalJson({ ...JSON.parse(fixture.document), unexpected: true }),
      };
    let pin = await retained(document);
    if (change === "wrong-sha") pin = { ...pin, sha256: "0".repeat(64) };
    if (change === "wrong-size") pin = { ...pin, byteSize: pin.byteSize + 1 };
    if (change === "changed-content")
      await writeFile(
        resolve(ROOT, pin.path),
        (await readFile(resolve(ROOT, pin.path), "utf8")).replace("synthetic", "Synthetic"),
      );
    if (change === "noncanonical-wrapper") {
      const bytes = `${JSON.stringify(document, null, 2)}\n`;
      await writeFile(resolve(ROOT, pin.path), bytes);
      pin = pinBytes(pin.path, bytes);
    }
    const result = capture();
    expect(await runCommand(admissionArgs(pin), result.io)).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(result.output).toEqual([]);
  });

  it("rejects a stage-only login for quality admission before the mutation call", async () => {
    const fixture = await commandFixture(),
      pin = await retained({ schemaVersion: 2, requestDocument: fixture.document });
    responses.push(principal());
    const result = capture();
    expect(await runCommand(admissionArgs(pin), result.io)).toBe(1);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(result.errors.join(" ")).toContain("actual restricted login");
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(result.output).toEqual([]);
  });

  it("withholds admission success when connection cleanup fails", async () => {
    const fixture = await commandFixture(),
      pin = await retained({ schemaVersion: 2, requestDocument: fixture.document });
    const { requestDocument: _document, ...response } = accepted(fixture.document);
    responses.push(principal("nutrition_catalogue_approve_quality"), response);
    mocks.destroy.mockRejectedValueOnce(new Error("synthetic cleanup failure"));
    const result = capture();
    expect(await runCommand(admissionArgs(pin), result.io)).toBe(1);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(result.output).toEqual([]);
    expect(await readCatalogueValidationRequest(pin.path, pin, ROOT)).toMatchObject({
      requestDocument: fixture.document,
    });
  });
});

describe("paged stage CLI accepted-resource and cleanup boundaries", () => {
  it("checks actual stage authority and accepted budgets before snapshot allocation", async () => {
    const fixture = await commandFixture(),
      receipt = accepted(fixture.document),
      result = capture();
    responses.push(principal(), receipt);
    mocks.destroy.mockImplementation(async () => {
      expect(result.output).toEqual([]);
    });
    mocks.close.mockImplementation(async () => {
      expect(result.output).toEqual([]);
    });
    expect(
      await runCommand(fixture.stage(receipt.admissionSha256), result.io),
      result.errors.join("\n"),
    ).toBe(0);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0]?.[0].sql).toContain("session_user");
    expect(mocks.query.mock.calls[1]?.[0].sql).toContain("catalogue_read_preparation_admission_v2");
    expect(mocks.query.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.open.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        admission: { maxRecords: 25000, maxPayloadTextBytes: 100000000, maxSnapshotBytes: 12345 },
        expectedExport: { sha256: EXPORT, byteSize: 12345 },
      }),
    );
    expect(mocks.stage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ admission: receipt, batch: fixture.identity.batch }),
    );
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(result.output).toEqual([
      expect.objectContaining({
        status: "sealed",
        validationPending: true,
        activationAuthorized: false,
      }),
    ]);
  });

  it.each([
    { privileged: true },
    { ownerMember: true },
    { canLogin: false },
    { effectivePrincipal: "assumed_stage" },
    { capabilities: ["nutrition_catalogue_validate"] },
    { capabilities: ["nutrition_catalogue_stage", "nutrition_catalogue_approve_quality"] },
  ])("rejects unsafe actual session %j before admission read or snapshot", async (change) => {
    const fixture = await commandFixture(),
      result = capture();
    responses.push({ ...principal(), ...change });
    expect(
      await runCommand(fixture.stage(accepted(fixture.document).admissionSha256), result.io),
    ).toBe(1);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(result.errors.join(" ")).toContain("actual restricted login");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(result.output).toEqual([]);
  });

  it.each([
    { exportSha256: "f".repeat(64) },
    { exportBytes: "12346" },
    { manifestSha256: "f".repeat(64) },
    { stageDocument: '{"schemaVersion":1}' },
    { maxRecords: "9007199254740992" },
    { maxPayloadTextBytes: "0" },
  ])("rejects incompatible accepted identity or limits %j before snapshot", async (change) => {
    const fixture = await commandFixture(),
      result = capture();
    const receipt = accepted(canonicalJson({ ...JSON.parse(fixture.document), ...change }));
    responses.push(principal(), receipt);
    expect(await runCommand(fixture.stage(receipt.admissionSha256), result.io)).toBe(1);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(result.output).toEqual([]);
  });

  it("rejects a forged admitted-document receipt before snapshot allocation", async () => {
    const fixture = await commandFixture(),
      receipt = accepted(fixture.document),
      result = capture();
    responses.push(principal(), {
      ...receipt,
      requestDocument: fixture.document.replace("25000", "25001"),
    });
    expect(await runCommand(fixture.stage(receipt.admissionSha256), result.io)).toBe(1);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(result.output).toEqual([]);
  });

  it("closes the connection after export verification fails without staging", async () => {
    const fixture = await commandFixture(),
      receipt = accepted(fixture.document),
      result = capture();
    responses.push(principal(), receipt);
    mocks.open.mockRejectedValueOnce(new Error("pinned export verification failed"));
    expect(await runCommand(fixture.stage(receipt.admissionSha256), result.io)).toBe(1);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(result.output).toEqual([]);
  });

  it.each(["database", "snapshot", "both"])(
    "withholds sealed success after %s cleanup failure and attempts both cleanups",
    async (failure) => {
      const fixture = await commandFixture(),
        receipt = accepted(fixture.document),
        result = capture();
      responses.push(principal(), receipt);
      if (failure !== "snapshot")
        mocks.destroy.mockRejectedValueOnce(new Error("DB cleanup failed"));
      if (failure !== "database")
        mocks.close.mockRejectedValueOnce(new Error("snapshot cleanup failed"));
      expect(await runCommand(fixture.stage(receipt.admissionSha256), result.io)).toBe(1);
      expect(mocks.stage).toHaveBeenCalledOnce();
      expect(mocks.destroy).toHaveBeenCalledOnce();
      expect(mocks.close).toHaveBeenCalledOnce();
      expect(result.output).toEqual([]);
      expect(result.errors.join(" ")).toContain("completion is unconfirmed");
    },
  );

  it("stops after an ambiguous stage response and performs no automatic retry", async () => {
    const fixture = await commandFixture(),
      receipt = accepted(fixture.document),
      result = capture();
    responses.push(principal(), receipt);
    mocks.stage.mockRejectedValueOnce(new Error("lost page response"));
    expect(await runCommand(fixture.stage(receipt.admissionSha256), result.io)).toBe(1);
    expect(mocks.stage).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(result.output).toEqual([]);
  });
});

async function commandFixture() {
  const directory = await mkdtemp(join(tmpdir(), "paged-stage-command-"));
  cleanup.push(directory);
  const base = JSON.parse(
    await readFile(
      join(ROOT, "data/manifests/usda-fdc-full-csv-2026-04-30.candidate.json"),
      "utf8",
    ),
  ) as FoodSourceManifestV4;
  const roles = [
    "food",
    "branded-food",
    "food-nutrient",
    "nutrient",
    "food-nutrient-derivation",
    "food-portion",
    "measure-unit",
  ];
  const expectations: Record<string, string | number> = {
    fdcCsvDefaultMarketCode: "US",
    "fdcCsvDataTypeMapping:foundation_food": "Foundation",
    "fdcCsvMarketMapping:United States": "US",
    "fdcCsvDisposition:guide.pdf": "guide:publisher-documentation-v1",
    parserBaselineCsvAcceptedFoodCount: 25000,
    parserBaselineCsvCanonicalAcceptedRecordsDigest: "c".repeat(64),
  };
  for (const role of roles)
    expectations[`fdcCsvDisposition:${role}.csv`] = `adapter-input:${role}-v1`;
  const evidence = bindSyntheticReleaseEvidence(
    {
      ...base,
      artifact: {
        ...base.artifact,
        byteSize: 100,
        sha256: ARTIFACT,
        objectUri: `s3://synthetic-paged-stage/sha256/${ARTIFACT}/full.zip`,
      },
      ingestion: { ...base.ingestion, parserVersion: "0.1.0", parserBuildSha256: BUILD },
      release: {
        ...base.release,
        releaseKey: "synthetic-paged-stage-command",
        upstreamSchemaVersion: "synthetic-v1",
      },
      rights: {
        ...base.rights,
        review: {
          ...base.rights.review,
          status: "approved",
          reviewedAt: "2026-08-29T12:00:00Z",
          reviewedBy: RUNNER.principalId,
          notes: "Synthetic fixture; never release evidence.",
        },
      },
      templateOnly: false,
      releaseClass: "fixture-nonrelease",
      evidenceBundle: null,
      validation: {
        ...base.validation,
        expectedFiles: [...roles.map((role) => `${role}.csv`), "guide.pdf"].sort(),
        releaseSpecificExpectations: expectations,
      },
    },
    RUNNER,
  );
  const bytes = `${canonicalJson(evidence.manifest)}\n`,
    manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  const manifestPath = join(directory, "manifest.json"),
    evidencePath = join(directory, "evidence.json");
  await writeFile(manifestPath, bytes, { mode: 0o600 });
  await writeCanonicalReleaseEvidence(evidencePath, evidence.bundle);
  const manifestObjectUri = `s3://synthetic-paged-stage/sha256/${manifestSha256}/manifest.json`;
  const identity = prepareFdcCsvPagedStageIdentity({
    manifest: evidence.manifest,
    manifestSha256,
    manifestObjectUri,
    parserBuildSha256: BUILD,
    nutrientMappingDigest: MAPPING,
    evaluatedAt: SYNTHETIC_EVIDENCE_EVALUATED_AT,
    releaseEvidence: {
      bundle: evidence.bundle,
      bundleSha256: authenticatedReleaseEvidenceBundleSha256(evidence.bundle),
      decisionSha256: createHash("sha256")
        .update(canonicalJson(evidence.bundle.authorityDecision))
        .digest("hex"),
    },
  });
  const document = encodeCataloguePreparationAdmissionV2({
    stageDocument: identity.stageDocument,
    manifestSha256,
    exportSha256: EXPORT,
    exportBytes: "12345",
    stagePrincipal: STAGER,
    maxRecords: "25000",
    maxPayloadTextBytes: "100000000",
    maxIntermediateBytes: "500000000",
    maxValidationEvidenceBytes: "200000000",
    maxReconciliationEvidenceBytes: "300000000",
    maxBaselineRecords: "0",
    maxBaselinePayloadBytes: "0",
    reviewReference: "synthetic reviewed budget",
  });
  const args = [
    manifestPath,
    "--records",
    ".local-data/evidence/fdc-csv-records/synthetic-paged-command.ndjson",
    "--records-sha256",
    EXPORT,
    "--records-bytes",
    "12345",
    "--nutrient-mapping-sha256",
    MAPPING,
    "--evidence-bundle",
    evidencePath,
    "--manifest-object-uri",
    manifestObjectUri,
  ];
  return {
    identity,
    document,
    stage: (admissionSha256: string) => [
      "catalogue",
      "stage-fdc-csv-paged",
      ...args,
      "--admission-sha256",
      admissionSha256,
    ],
    prepare: (path: string) => [
      "catalogue",
      "prepare-paged-admission",
      ...args,
      "--stage-principal",
      STAGER,
      "--max-records",
      "25000",
      "--max-payload-text-bytes",
      "100000000",
      "--max-intermediate-bytes",
      "500000000",
      "--max-validation-evidence-bytes",
      "200000000",
      "--max-reconciliation-evidence-bytes",
      "300000000",
      "--max-baseline-records",
      "0",
      "--max-baseline-payload-bytes",
      "0",
      "--review-reference",
      "synthetic reviewed budget",
      "--request-out",
      path,
    ],
  };
}
