import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// Load the ingestion package's source through tsx so a clean checkout cannot
// accidentally validate with stale or missing build output.
import {
  assertImportReadyManifest,
  parseFoodSourceManifest,
} from "../packages/ingestion/src/manifest.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestDirectory = path.join(projectRoot, "data", "manifests");
const schemaPath = path.join(manifestDirectory, "food-source-manifest.schema.json");
const checkedInManifestPattern = /\.(?:candidate|example)\.json$/;

const schema = await readJson(schemaPath);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

let validateSchema;
try {
  validateSchema = ajv.compile(schema);
} catch (error) {
  throw new Error(`Manifest schema does not compile in Ajv strict mode: ${errorMessage(error)}`, {
    cause: error,
  });
}

const evidenceObjectUriSchema =
  schema.properties?.evidenceBundle?.oneOf?.[1]?.properties?.objectUri;
assert.ok(evidenceObjectUriSchema, "Evidence-bundle object URI schema is missing");
const validateEvidenceObjectUri = ajv.compile(evidenceObjectUriSchema);

const manifestNames = (await readdir(manifestDirectory))
  .filter((name) => checkedInManifestPattern.test(name))
  .sort();

assert.ok(manifestNames.length > 0, "No checked-in candidate/example food-source manifests found");

for (const manifestName of manifestNames) {
  const manifestPath = path.join(manifestDirectory, manifestName);
  const input = await readJson(manifestPath);
  assertSchemaValid(input, manifestName);

  let manifest;
  try {
    manifest = parseFoodSourceManifest(input);
  } catch (error) {
    throw new Error(
      `Runtime parser rejected schema-valid ${manifestName}: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }

  assert.equal(
    manifest.templateOnly,
    true,
    `${manifestName} is a checked-in template and must keep templateOnly=true`,
  );
  assert.equal(
    manifest.manifestVersion,
    4,
    `${manifestName} must use the current manifest-v4 authority contract`,
  );
  assert.equal(
    manifest.releaseClass,
    "live-reviewed",
    `${manifestName} must remain classified as a live release candidate`,
  );
  assert.equal(
    manifest.evidenceBundle,
    null,
    `${manifestName} is a template and must not bind authority evidence`,
  );
  assert.throws(
    () => assertImportReadyManifest(manifest),
    undefined,
    `${manifestName} unexpectedly passed the runtime import-readiness gate`,
  );
}

runDriftMutations(await readJson(path.join(manifestDirectory, manifestNames[0])));
runEvidenceObjectUriSchemaCases();

console.log(
  `Validated ${manifestNames.length} food-source manifest templates with strict JSON Schema and the runtime parser.`,
);

function runDriftMutations(fixture) {
  const mutations = [
    {
      label: "unknown root property",
      value: { ...structuredClone(fixture), unexpectedManifestField: true },
    },
    {
      label: "unsupported manifest version",
      value: { ...structuredClone(fixture), manifestVersion: 3 },
    },
    {
      label: "incomplete import-ready promotion",
      value: { ...structuredClone(fixture), templateOnly: false },
    },
  ];

  for (const mutation of mutations) {
    assert.equal(
      validateSchema(mutation.value),
      false,
      `Schema unexpectedly accepted mutation: ${mutation.label}`,
    );
    assert.throws(
      () => parseFoodSourceManifest(mutation.value),
      undefined,
      `Runtime parser unexpectedly accepted mutation: ${mutation.label}`,
    );
  }
}

function runEvidenceObjectUriSchemaCases() {
  const digest = "c".repeat(64);
  assert.equal(
    validateEvidenceObjectUri(`s3://release-evidence/sha256/${digest}/bundle.json`),
    true,
    "Schema rejected the canonical evidence-bundle URI",
  );
  for (const [label, value] of [
    [
      "missing content-addressed digest segment",
      "s3://release-evidence/not-content-addressed/bundle.json",
    ],
    ["empty segment before digest", `s3://release-evidence//sha256/${digest}/bundle.json`],
    ["empty segment after digest", `s3://release-evidence/sha256/${digest}//bundle.json`],
    ["dot segment", `s3://release-evidence/sha256/${digest}/nested/../bundle.json`],
    ["malformed percent escape", `s3://release-evidence/%zz/sha256/${digest}/bundle.json`],
  ]) {
    assert.equal(
      validateEvidenceObjectUri(value),
      false,
      `Schema unexpectedly accepted evidence URI with ${label}`,
    );
  }
}

function assertSchemaValid(input, manifestName) {
  if (!validateSchema(input)) {
    throw new Error(
      `JSON Schema rejected ${manifestName}:\n${ajv.errorsText(validateSchema.errors, {
        separator: "\n",
      })}`,
    );
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `${path.relative(projectRoot, filePath)} is not valid JSON: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
