// @ts-expect-error Node types are intentionally not part of the browser-safe contracts build.
import { createHash } from "node:crypto";
import { Ajv, type AnySchema } from "ajv";
import * as addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  type AccountErasureJob,
  type AccountExportJob,
  accountErasureMutationResponseSchema,
  accountErasureRequestSchema,
  accountErasureResponseSchema,
  accountExportRequestSchema,
  accountExportResponseSchema,
  assertAccountErasureLifecycle,
  assertAccountExportLifecycle,
  biometricDefinitionDraftRequestSchema,
  biometricDefinitionMutationResponseSchema,
  biometricDefinitionRevisionRequestSchema,
  biometricEventDraftRequestSchema,
  biometricEventMutationResponseSchema,
  biometricEventRevisionRequestSchema,
  biometricTrendResponseSchema,
  canonicalJson,
  createCustomFoodDiaryEntryRequestSchema,
  customFoodDraftRequestSchema,
  customFoodMutationResponseSchema,
  deviceChallengeRequestSchema,
  deviceChallengeResponseSchema,
  deviceRegistrationSignaturePayload,
  disconnectPlatformIntegrationRequestSchema,
  healthDeviceResponseSchema,
  healthImportBatchRequestSchema,
  healthImportBatchResponseSchema,
  healthImportSignaturePayload,
  nutrientTrendResponseSchema,
  platformConsentRequestSchema,
  platformIntegrationResponseSchema,
  reauthenticationRequestSchema,
  reauthenticationResponseSchema,
  rebindPlatformIntegrationRequestSchema,
  registerHealthDeviceRequestSchema,
  reminderDraftRequestSchema,
  reminderMutationResponseSchema,
  reminderRevisionRequestSchema,
  repeatDiaryEntryRequestSchema,
  signedDeviceHeadersSchema,
} from "./index.js";

const addFormats = addFormatsModule.default as unknown as (ajv: Ajv) => Ajv;

function validator(schema: AnySchema) {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const id = "10000000-0000-4000-8000-000000000001";
const id2 = "20000000-0000-4000-8000-000000000002";
const now = "2026-08-16T12:00:00.000Z";

const aggregate = {
  nutrientId: "1",
  code: "energy",
  name: "Energy",
  unit: "kcal",
  knownAmount: "123.45",
  completeness: "partial",
  isExact: false,
  contributorCount: 2,
  quantifiedCount: 1,
  traceCount: 0,
  unknownCount: 1,
  unknownReasonCounts: { not_reported: 1, not_analyzed: 0, not_applicable: 0, withheld: 0 },
} as const;

const definition = {
  id,
  revision: "1",
  status: "active",
  name: "Body weight",
  dimension: "mass",
  canonicalUnit: "kg",
  notes: null,
  createdAt: now,
  updatedAt: now,
} as const;

const event = {
  id: id2,
  revision: "1",
  definitionId: id,
  measuredAt: now,
  localDate: "2026-08-16",
  timeZone: "America/Chicago",
  value: "72.125",
  source: { kind: "manual", deviceId: null, externalId: null, externalRevision: null },
  createdAt: now,
  updatedAt: now,
} as const;

describe("retention contract schemas", () => {
  it("strictly compiles the changed diary and every retention response family", () => {
    for (const schema of [
      nutrientTrendResponseSchema,
      biometricTrendResponseSchema,
      customFoodMutationResponseSchema,
      biometricDefinitionMutationResponseSchema,
      biometricEventMutationResponseSchema,
      reminderMutationResponseSchema,
      deviceChallengeResponseSchema,
      healthDeviceResponseSchema,
      healthImportBatchResponseSchema,
      platformIntegrationResponseSchema,
      accountExportResponseSchema,
      accountErasureResponseSchema,
      accountErasureMutationResponseSchema,
      reauthenticationResponseSchema,
    ]) {
      expect(() => validator(schema)).not.toThrow();
    }
  });

  it("keeps trend date bounds and lower-bound nutrient evidence exact", () => {
    const validateNutrient = validator(nutrientTrendResponseSchema);
    const nutrient = {
      data: {
        nutrient: { id: "1", code: "energy", name: "Energy", unit: "kcal" },
        timeZone: "America/Chicago",
        from: "2026-08-16",
        to: "2026-08-16",
        bucket: "day",
        watermarkRevision: "1",
        points: [
          {
            localDate: "2026-08-16",
            startsAt: "2026-08-16T05:00:00.000Z",
            endsAt: "2026-08-17T05:00:00.000Z",
            aggregate,
          },
        ],
      },
    };
    expect(validateNutrient(nutrient), JSON.stringify(validateNutrient.errors)).toBe(true);
    expect(validateNutrient({ ...nutrient, extra: true })).toBe(false);

    const validateBiometric = validator(biometricTrendResponseSchema);
    const trend = {
      data: {
        definition,
        timeZone: "America/Chicago",
        from: "2026-11-01",
        to: "2026-11-01",
        bucket: "day",
        points: [
          {
            localDate: "2026-11-01",
            startsAt: "2026-11-01T05:00:00.000Z",
            endsAt: "2026-11-02T06:00:00.000Z",
            count: 2,
            first: "72.1",
            last: "72.2",
            minimum: "72.1",
            maximum: "72.2",
          },
        ],
      },
    };
    expect(validateBiometric(trend), JSON.stringify(validateBiometric.errors)).toBe(true);
  });

  it("does not let clients author repeat or manual-biometric local coordinates", () => {
    const repeat = validator(repeatDiaryEntryRequestSchema);
    expect(repeat({ occurredAt: now, mealSlot: "dinner" })).toBe(true);
    expect(repeat({ occurredAt: now, localDate: "2026-08-16" })).toBe(false);

    const createEvent = validator(biometricEventDraftRequestSchema);
    expect(createEvent({ definitionId: id, measuredAt: now, value: "72.125" })).toBe(true);
    expect(
      createEvent({
        definitionId: id,
        measuredAt: now,
        value: "72.125",
        timeZone: "America/Chicago",
      }),
    ).toBe(false);
    const reviseEvent = validator(biometricEventRevisionRequestSchema);
    expect(reviseEvent({ value: "72.25" })).toBe(true);
    expect(reviseEvent({ value: "72.25", definitionId: id })).toBe(false);

    const eventMutation = validator(biometricEventMutationResponseSchema);
    expect(eventMutation({ data: { replayed: false, event } })).toBe(true);
    expect(eventMutation({ data: { replayed: false, event: { ...event, value: 72.125 } } })).toBe(
      false,
    );
  });

  it("makes biometric dimension and canonical unit immutable across revisions", () => {
    const create = validator(biometricDefinitionDraftRequestSchema);
    expect(
      create({ name: "Body weight", dimension: "mass", canonicalUnit: "kg", notes: null }),
    ).toBe(true);
    expect(create({ name: "Body weight", canonicalUnit: "kg", notes: null })).toBe(false);
    const revise = validator(biometricDefinitionRevisionRequestSchema);
    expect(revise({ name: "Morning body weight", notes: null })).toBe(true);
    expect(revise({ name: "Morning body weight", notes: null, canonicalUnit: "lb" })).toBe(false);
  });

  it("closes versioned custom-food drafts and pins bigint food-version identity", () => {
    const validateDraft = validator(customFoodDraftRequestSchema);
    const draft = {
      name: "Family granola",
      brandName: null,
      serving: { label: "cup", grams: "90" },
      nutrients: [
        { nutrientId: "1", state: "quantified", amountPer100Grams: "450.25" },
        { nutrientId: "2", state: "unknown", amountPer100Grams: null, reason: "not_analyzed" },
      ],
      notes: null,
    };
    expect(validateDraft(draft), JSON.stringify(validateDraft.errors)).toBe(true);
    expect(
      validateDraft({
        ...draft,
        nutrients: [{ nutrientId: "1", state: "trace", amountPer100Grams: "0" }],
      }),
    ).toBe(false);
    const validateLog = validator(createCustomFoodDiaryEntryRequestSchema);
    expect(
      validateLog({
        customFoodVersionId: "9223372036854775807",
        portion: { kind: "grams", grams: "100" },
        mealSlot: "lunch",
        occurredAt: now,
      }),
    ).toBe(true);
    expect(
      validateLog({
        customFoodVersionId: id,
        portion: { kind: "grams", grams: "100" },
        mealSlot: "lunch",
        occurredAt: now,
      }),
    ).toBe(false);
  });

  it("keeps paused reminder consent while fixing all delivered content", () => {
    const create = validator(reminderDraftRequestSchema);
    expect(
      create({
        label: "My evening routine",
        localTime: "20:15",
        daysOfWeek: [1, 3, 5],
        timeZone: "America/Chicago",
        channel: "local",
        consentGranted: true,
      }),
    ).toBe(true);
    expect(
      create({
        label: "My evening routine",
        localTime: "20:15",
        daysOfWeek: [1],
        timeZone: "America/Chicago",
        channel: "push",
        consentGranted: true,
      }),
    ).toBe(false);
    expect(
      validator(reminderRevisionRequestSchema)({
        label: "My routine",
        localTime: "20:15",
        daysOfWeek: [1],
        timeZone: "America/Chicago",
        status: "paused",
      }),
    ).toBe(true);
    const reminder = {
      id,
      revision: "2",
      status: "paused",
      label: "Private label",
      localTime: "20:15",
      daysOfWeek: [1],
      timeZone: "America/Chicago",
      channel: "local",
      consent: { policyVersion: "local-reminders-v1", grantedAt: now, revokedAt: null },
      deliveryPolicy: {
        title: "Nutrition Tracker",
        lockScreenText: "Time to check in.",
        includesHealthDetails: false,
      },
      createdAt: now,
      updatedAt: now,
    };
    expect(validator(reminderMutationResponseSchema)({ data: { replayed: false, reminder } })).toBe(
      true,
    );
    expect(
      validator(reminderMutationResponseSchema)({
        data: {
          replayed: false,
          reminder: {
            ...reminder,
            deliveryPolicy: { ...reminder.deliveryPolicy, lockScreenText: reminder.label },
          },
        },
      }),
    ).toBe(false);
  });

  it("requires challenge-bound key possession and signed cursor transitions", () => {
    expect(validator(deviceChallengeRequestSchema)({ platform: "apple_healthkit" })).toBe(true);
    const registration = {
      challengeId: id,
      challenge: "q".repeat(43),
      platform: "apple_healthkit",
      displayName: "Eric's iPhone",
      publicKey: {
        format: "spki",
        algorithm: "ES256",
        derBase64: `${"A".repeat(122)}==`,
      },
      challengeSignature: "c".repeat(86),
      attestation: null,
    };
    expect(
      validator(registerHealthDeviceRequestSchema)(registration),
      JSON.stringify(validator(registerHealthDeviceRequestSchema).errors),
    ).toBe(true);
    expect(
      validator(registerHealthDeviceRequestSchema)({
        ...registration,
        challengeSignature: undefined,
      }),
    ).toBe(false);

    const upsert = {
      operation: "upsert",
      externalId: "weight-1",
      externalRevision: "2",
      definitionCode: "body_weight",
      measuredAt: now,
      recordedTimeZone: "America/Chicago",
      value: "72.125",
      unit: "kg",
    };
    const deletion = {
      operation: "delete",
      externalId: "weight-2",
      externalRevision: "3",
    };
    const batch = {
      deviceId: id,
      batchId: id2,
      platform: "apple_healthkit",
      cursorEpoch: "1",
      sourceCursor: null,
      nextSourceCursor: "next-anchor-digest",
      records: [upsert, deletion],
    };
    const validateBatch = validator(healthImportBatchRequestSchema);
    expect(validateBatch(batch), JSON.stringify(validateBatch.errors)).toBe(true);
    expect(validateBatch({ ...batch, records: [] })).toBe(true);
    expect(validateBatch({ ...batch, cursorEpoch: undefined })).toBe(false);
    expect(validateBatch({ ...batch, cursorEpoch: "0" })).toBe(false);
    expect(validateBatch({ ...batch, cursorEpoch: "01" })).toBe(false);
    expect(validateBatch({ ...batch, cursorEpoch: "9223372036854775807" })).toBe(true);
    expect(validateBatch({ ...batch, cursorEpoch: "9223372036854775808" })).toBe(false);
    expect(validateBatch({ ...batch, sourceCursor: "short" })).toBe(false);
    expect(validateBatch({ ...batch, records: [{ ...upsert, unit: "lb" }] })).toBe(false);
    const validateResult = validator(healthImportBatchResponseSchema);
    expect(
      validateResult({
        data: { replayed: false, accepted: 1, deleted: 0, duplicates: 1, conflicts: [] },
      }),
    ).toBe(true);
    expect(
      validateResult({ data: { replayed: false, accepted: 1, deleted: 0, conflicts: [] } }),
    ).toBe(false);
    expect(
      validator(signedDeviceHeadersSchema)({
        "x-device-timestamp": now,
        "x-device-nonce": "n".repeat(22),
        "x-device-signature": "s".repeat(86),
      }),
    ).toBe(true);
  });

  it("restricts platform consent to reviewed body-weight scope and explicit disconnect policy", () => {
    expect(
      validator(platformConsentRequestSchema)({
        platform: "android_health_connect",
        dataTypeCodes: ["body_weight"],
        consentGranted: true,
      }),
    ).toBe(true);
    expect(
      validator(platformConsentRequestSchema)({
        platform: "android_health_connect",
        dataTypeCodes: ["blood_pressure"],
        consentGranted: true,
      }),
    ).toBe(false);
    const disconnect = validator(disconnectPlatformIntegrationRequestSchema);
    expect(disconnect({ importedDataDisposition: "retain" })).toBe(true);
    expect(disconnect({})).toBe(false);
    const rebind = validator(rebindPlatformIntegrationRequestSchema);
    expect(rebind({ deviceId: id })).toBe(true);
    expect(rebind({ deviceId: id, sourceCursor: null })).toBe(false);
    const integration = {
      platform: "android_health_connect",
      deviceId: id,
      cursorEpoch: "2",
      revision: "2",
      status: "connected",
      dataTypeCodes: ["body_weight"],
      consentGrantedAt: now,
      disconnectedAt: null,
      lastImportAt: null,
      currentSourceCursor: null,
      consentHistory: [
        {
          id: id2,
          dataTypeCodes: ["body_weight"],
          status: "granted",
          recordedAt: now,
        },
      ],
    };
    const integrationResponse = validator(platformIntegrationResponseSchema);
    expect(
      integrationResponse({ data: { replayed: false, integration } }),
      JSON.stringify(integrationResponse.errors),
    ).toBe(true);
    expect(
      integrationResponse({
        data: { replayed: false, integration: { ...integration, cursorEpoch: undefined } },
      }),
    ).toBe(false);
    expect(
      integrationResponse({
        data: { replayed: false, integration: { ...integration, cursorEpoch: "0" } },
      }),
    ).toBe(false);
  });

  it("requires purpose-bound reauthentication and reconciled deterministic export lifecycle", () => {
    expect(
      validator(reauthenticationRequestSchema)({
        password: "a sufficiently long password",
        purpose: "account_export",
      }),
    ).toBe(true);
    expect(
      validator(reauthenticationRequestSchema)({ password: "a sufficiently long password" }),
    ).toBe(false);
    expect(validator(accountExportRequestSchema)({ formats: ["json", "csv"] })).toBe(true);
    const completedExport = {
      data: {
        replayed: false,
        export: {
          id,
          status: "completed",
          formats: ["json", "csv"],
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          expiresAt: "2026-08-17T12:00:00.000Z",
          artifacts: [
            {
              format: "json",
              fileName: "account-export.json",
              byteLength: "100",
              sha256: "a".repeat(64),
              downloadPath: `/v1/exports/${id}/artifacts/json`,
              mediaType: "application/json",
              expiresAt: "2026-08-17T12:00:00.000Z",
            },
            {
              format: "csv",
              fileName: "account-export-csv.zip",
              byteLength: "200",
              sha256: "b".repeat(64),
              downloadPath: `/v1/exports/${id}/artifacts/csv`,
              mediaType: "application/zip",
              expiresAt: "2026-08-17T12:00:00.000Z",
            },
          ],
          manifestSha256: "c".repeat(64),
          reconciliation: {
            snapshotWatermark: "snapshot-42",
            entities: [
              {
                entity: "diary_entries",
                sourceCount: 10,
                exportedCount: 10,
                watermark: "entry-10",
              },
              {
                entity: "tombstones",
                sourceCount: 2,
                exportedCount: 2,
                watermark: "tombstone-2",
              },
            ],
            reconciled: true,
          },
          failureCode: null,
        } satisfies AccountExportJob,
      },
    };
    const validateExport = validator(accountExportResponseSchema);
    expect(validateExport(completedExport), JSON.stringify(validateExport.errors)).toBe(true);
    expect(() =>
      assertAccountExportLifecycle({
        ...completedExport.data.export,
        status: "queued",
      }),
    ).toThrow(TypeError);
    expect(
      validateExport({
        ...completedExport,
        data: {
          ...completedExport.data,
          export: {
            ...completedExport.data.export,
            reconciliation: {
              ...completedExport.data.export.reconciliation,
              entities: [],
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("closes account-erasure states around explicit consequences", () => {
    expect(validator(accountErasureRequestSchema)({ confirmation: "DELETE_MY_ACCOUNT" })).toBe(
      true,
    );
    const erasure = {
      data: {
        replayed: false,
        erasure: {
          id,
          status: "queued",
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          executeAfter: "2026-08-17T12:00:00.000Z",
          recentAuthenticationSatisfied: true,
          consequences: [
            "ACCOUNT_ACCESS_REVOKED",
            "PRIVATE_HEALTH_DATA_DELETED",
            "EXPORT_LINKS_REVOKED",
          ],
          failureCode: null,
        } satisfies AccountErasureJob,
      },
    };
    const validate = validator(accountErasureResponseSchema);
    expect(validate(erasure), JSON.stringify(validate.errors)).toBe(true);
    const validateMutation = validator(accountErasureMutationResponseSchema);
    expect(
      validateMutation({
        data: {
          ...erasure.data,
          statusCapability: {
            token: "s".repeat(43),
            expiresAt: "2026-09-16T12:00:00.000Z",
          },
        },
      }),
      JSON.stringify(validateMutation.errors),
    ).toBe(true);
    expect(validateMutation(erasure)).toBe(false);
    expect(() =>
      assertAccountErasureLifecycle({
        ...erasure.data.erasure,
        status: "completed",
      }),
    ).toThrow(TypeError);
    expect(
      validate({
        ...erasure,
        data: {
          ...erasure.data,
          erasure: { ...erasure.data.erasure, recentAuthenticationSatisfied: false },
        },
      }),
    ).toBe(false);
  });
});

describe("cross-client canonical signing vectors", () => {
  it("sorts Unicode code points and rejects ambiguous JSON inputs", () => {
    const input = { z: 1, a: { y: true, x: "é" }, records: [null, "72.125"] };
    expect(canonicalJson(input)).toBe('{"a":{"x":"é","y":true},"records":[null,"72.125"],"z":1}');
    expect(() => canonicalJson({ invalid: undefined })).toThrow(TypeError);
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = "sparse";
    expect(() => canonicalJson(sparse)).toThrow(TypeError);
    const hiddenNumericProperty: unknown[] = [];
    hiddenNumericProperty["4294967295" as unknown as number] = "omitted-by-array-map";
    expect(() => canonicalJson(hiddenNumericProperty)).toThrow(TypeError);
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow(TypeError);
  });

  it("publishes fixed health-import and registration signature framing", () => {
    const body = {
      batchId: id2,
      cursorEpoch: "1",
      deviceId: id,
      nextSourceCursor: "next-anchor-digest",
      platform: "apple_healthkit",
      records: [],
      sourceCursor: null,
    };
    expect(canonicalJson(body)).toBe(
      `{"batchId":"${id2}","cursorEpoch":"1","deviceId":"${id}","nextSourceCursor":"next-anchor-digest","platform":"apple_healthkit","records":[],"sourceCursor":null}`,
    );
    // SHA-256 of the UTF-8 canonical body above; shared as a fixed native/web test vector.
    const bodyHash = createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
    expect(bodyHash).toBe("94b99a3b1dc9fc514e3ac6ededad50525fa68c7fd5bd75aa36e7c5f542b1bcf6");
    expect(
      healthImportSignaturePayload({
        deviceId: id,
        platform: "apple_healthkit",
        batchId: id2,
        signedAt: now,
        nonce: "n".repeat(22),
        bodySha256: bodyHash,
      }),
    ).toBe(
      [
        "nutrition-tracker-health-import-v1",
        id,
        "apple_healthkit",
        id2,
        now,
        "n".repeat(22),
        bodyHash,
      ].join("\n"),
    );
    expect(
      deviceRegistrationSignaturePayload({
        challengeId: id,
        challenge: "q".repeat(43),
        platform: "apple_healthkit",
        canonicalPublicKeySha256: "a".repeat(64),
      }),
    ).toContain("nutrition-tracker-device-registration-v1\n");
  });
});
