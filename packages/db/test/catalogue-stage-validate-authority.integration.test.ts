import { createHash, randomBytes } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  createDatabase,
  type Database,
  getSourceNutrientMappingDigest,
  type JsonObject,
  registerFoodSourceFromReviewedManifest,
  registerSourceNutrientMappings,
  runMigrations,
  stageBatch,
  supersedeSourceNutrientMapping,
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const APPLICATION_SCHEMA = "public";
const capabilityRoles = [
  "nutrition_catalogue_stage",
  "nutrition_catalogue_validate",
  "nutrition_catalogue_approve_data",
  "nutrition_catalogue_approve_quality",
  "nutrition_catalogue_approve_rights",
  "nutrition_catalogue_promote_activate",
  "nutrition_catalogue_rollback",
] as const;

type CapabilityRole = (typeof capabilityRoles)[number];

interface LoginFixture {
  readonly capabilities: readonly CapabilityRole[];
  readonly login: string;
  readonly password: string;
}

interface StageDocument {
  readonly acquiredAt: string;
  readonly artifactBytes: number;
  readonly artifactSha256: string;
  readonly artifactUri: string;
  readonly evidenceBundleSha256: string;
  readonly evidenceBundleUri: string;
  readonly evidenceDecisionSha256: string;
  readonly evidenceObjectVersionId: string;
  readonly evidenceValidUntil: string;
  readonly mediaType: string;
  readonly parserVersion: string;
  readonly publishedOn: string;
  readonly releaseClass: "live-reviewed";
  readonly releaseKey: string;
  readonly rightsManifestSha256: string;
  readonly rightsManifestUri: string;
  readonly schemaVersion: 1;
  readonly sourceCode: string;
  readonly upstreamSchemaVersion: string;
}

interface StagedRecordDocument {
  readonly canonicalPayloadDocument: string;
  readonly canonicalPayloadSha256: string;
  readonly sequenceNumber: number;
  readonly sourcePayloadSha256: string;
  readonly sourceRecordKey: string;
  readonly sourceRecordType: string;
}

interface StageBatchResult {
  readonly batchId: string;
  readonly nextOffset: number;
  readonly resumed: boolean;
  readonly stagedCount: number;
  readonly status: string;
}

interface StageChunkResult {
  readonly inserted: number;
  readonly nextOffset: number;
  readonly replayed: number;
  readonly stagedCount: number;
  readonly wasAlreadyStaged: boolean;
}

interface ParserSealResult {
  readonly parserReportSha256: string;
  readonly stagingSealSha256: string;
  readonly wasAlreadySealed: boolean;
}

interface ParserCounts {
  readonly emittedNutrientCount: number;
  readonly emittedPortionCount: number;
  readonly emittedRecordCount: number;
  readonly excludedNutrientCount: number;
  readonly excludedPortionCount: number;
  readonly excludedRecordCount: number;
  readonly sourceNutrientCount: number;
  readonly sourcePortionCount: number;
  readonly sourceRecordCount: number;
}

interface ValidationObservation {
  readonly batch: {
    readonly artifactSha256: string;
    readonly evidenceBundleSha256: string;
    readonly evidenceBundleUri: string;
    readonly evidenceDecisionSha256: string;
    readonly evidenceObjectVersionId: string;
    readonly evidenceValidUntil: string;
    readonly id: string;
    readonly releaseClass: string;
    readonly rightsManifestSha256: string;
    readonly stagedDatabasePrincipal: string;
    readonly stagingSealSha256: string;
  };
  readonly nutrientMappings: readonly { readonly revisionId: string }[];
  readonly parserReport: ParserCounts & { readonly reportSha256: string };
  readonly records: readonly {
    readonly canonicalPayloadSha256: string;
    readonly sourceRecordKey: string;
  }[];
}

interface ValidationObservationResult {
  readonly observation: ValidationObservation;
  readonly observationSha256: string;
  readonly schemaVersion: number;
}

const authorityFunctions = [
  {
    allowedCapability: null,
    identity: "guard_food_import_batch_stage_validate_authority()",
  },
  {
    allowedCapability: null,
    identity: "guard_food_import_record_insert_before_staging_seal()",
  },
  {
    allowedCapability: null,
    identity: "guard_food_import_stage_checkpoint_before_staging_seal()",
  },
  {
    allowedCapability: null,
    identity: "catalogue_compute_import_staging_seal(uuid)",
  },
  {
    allowedCapability: "nutrition_catalogue_stage",
    identity: "catalogue_stage_import_batch(text)",
  },
  {
    allowedCapability: "nutrition_catalogue_stage",
    identity: "catalogue_stage_import_record_chunk(uuid,bigint,text)",
  },
  {
    allowedCapability: "nutrition_catalogue_stage",
    identity: "catalogue_stage_import_parser_report(uuid,text)",
  },
  {
    allowedCapability: "nutrition_catalogue_validate",
    identity: "catalogue_observe_import_validation(uuid)",
  },
  {
    allowedCapability: "nutrition_catalogue_validate",
    identity: "catalogue_validate_import_batch(uuid,text,text,text)",
  },
] as const satisfies readonly {
  readonly allowedCapability: CapabilityRole | null;
  readonly identity: string;
}[];

describeDatabase("catalogue stage and validate database authority", { timeout: 180_000 }, () => {
  it("separates authenticated staging from validation and seals every handoff", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    assertLoopbackDatabaseUrl(databaseUrl);

    const bootstrap = createDatabase({
      applicationName: "catalogue-stage-validate-bootstrap",
      connectionString: databaseUrl,
      maxConnections: 1,
    });
    const token = randomBytes(6).toString("hex");
    const ephemeralDatabaseName = `catalogue_stage_validate_${token}`;
    const fixtures = {
      multi: {
        capabilities: ["nutrition_catalogue_stage", "nutrition_catalogue_validate"],
        login: `cat_sv_multi_${token}`,
        password: randomBytes(24).toString("hex"),
      },
      stage: {
        capabilities: ["nutrition_catalogue_stage"],
        login: `cat_sv_stage_${token}`,
        password: randomBytes(24).toString("hex"),
      },
      unassigned: {
        capabilities: [],
        login: `cat_sv_none_${token}`,
        password: randomBytes(24).toString("hex"),
      },
      validate: {
        capabilities: ["nutrition_catalogue_validate"],
        login: `cat_sv_validate_${token}`,
        password: randomBytes(24).toString("hex"),
      },
    } as const satisfies Record<string, LoginFixture>;
    const fixtureList = Object.values(fixtures);
    const loginClients: Kysely<Database>[] = [];
    let cleanupReserved = false;
    let owner: Kysely<Database> | undefined;
    let primaryFailure: unknown;
    const cleanupFailures: unknown[] = [];

    try {
      const databaseState = (
        await sql<{
          readonly name: string;
          readonly owner: string;
          readonly sessionPrincipal: string;
        }>`
          select
            database_row.datname as name,
            pg_catalog.pg_get_userbyid(database_row.datdba) as owner,
            session_user as "sessionPrincipal"
          from pg_catalog.pg_database as database_row
          where database_row.datname = pg_catalog.current_database()
        `.execute(bootstrap)
      ).rows[0];
      if (!databaseState) throw new Error("Test database identity is unavailable");
      if (databaseState.owner !== databaseState.sessionPrincipal) {
        throw new Error("TEST_DATABASE_URL must authenticate as the local test database owner");
      }
      const resourceCollision = (
        await sql<{ readonly exists: boolean }>`
          select
            exists (
              select 1
              from pg_catalog.pg_database as database_row
              where database_row.datname = ${ephemeralDatabaseName}
            ) or exists (
              select 1
              from pg_catalog.pg_roles as role_row
              where role_row.rolname in (${sql.join(
                fixtureList.map((fixture) => sql`${fixture.login}`),
              )})
            ) as exists
        `.execute(bootstrap)
      ).rows[0]?.exists;
      if (resourceCollision !== false) {
        throw new Error("Generated catalogue stage/validate resources already exist");
      }
      cleanupReserved = true;

      await sql`
        create database ${sql.id(ephemeralDatabaseName)}
        owner ${sql.id(databaseState.owner)}
        template template0
      `.execute(bootstrap);
      const ownerUrl = databaseUrlForName(databaseUrl, ephemeralDatabaseName);
      const ownerClient = createDatabase({
        applicationName: "catalogue-stage-validate-owner",
        connectionString: ownerUrl,
        maxConnections: 2,
      });
      owner = ownerClient;
      await runMigrations(ownerClient);
      await assertAuthorityPrivileges(ownerClient, APPLICATION_SCHEMA, databaseState.owner);

      await sql`
        revoke connect on database ${sql.id(ephemeralDatabaseName)} from public
      `.execute(bootstrap);
      const validUntil = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
      for (const fixture of fixtureList) {
        await sql`
          create role ${sql.id(fixture.login)}
          login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
          connection limit 1
          password ${sql.lit(fixture.password)}
          valid until ${sql.lit(validUntil)}
        `.execute(bootstrap);
        await sql`
          grant connect on database ${sql.id(ephemeralDatabaseName)}
          to ${sql.id(fixture.login)}
        `.execute(bootstrap);
        for (const capability of fixture.capabilities) {
          await sql`
            grant ${sql.id(capability)} to ${sql.id(fixture.login)}
            with admin false, inherit true, set false
          `.execute(bootstrap);
        }
      }

      const roleRows = (
        await sql<{
          readonly login: string;
          readonly rolbypassrls: boolean;
          readonly rolcanlogin: boolean;
          readonly rolcreatedb: boolean;
          readonly rolcreaterole: boolean;
          readonly rolreplication: boolean;
          readonly rolsuper: boolean;
        }>`
          select
            role_row.rolname as login,
            role_row.rolcanlogin,
            role_row.rolsuper,
            role_row.rolcreatedb,
            role_row.rolcreaterole,
            role_row.rolreplication,
            role_row.rolbypassrls
          from pg_catalog.pg_roles as role_row
          where role_row.rolname in (${sql.join(
            fixtureList.map((fixture) => sql`${fixture.login}`),
          )})
          order by role_row.rolname
        `.execute(bootstrap)
      ).rows;
      expect(roleRows).toHaveLength(fixtureList.length);
      for (const role of roleRows) {
        expect(role).toMatchObject({
          rolbypassrls: false,
          rolcanlogin: true,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolsuper: false,
        });
      }

      const clientByName = new Map<string, Kysely<Database>>();
      for (const fixture of fixtureList) {
        const loginUrl = new URL(ownerUrl);
        loginUrl.username = fixture.login;
        loginUrl.password = fixture.password;
        const client = createDatabase({
          applicationName: `catalogue-stage-validate-${fixture.login}`,
          connectionString: loginUrl.toString(),
          maxConnections: 1,
        });
        clientByName.set(fixture.login, client);
        loginClients.push(client);
      }
      const requireClient = (fixture: LoginFixture): Kysely<Database> => {
        const client = clientByName.get(fixture.login);
        if (!client) throw new Error(`Client for ${fixture.login} is unavailable`);
        return client;
      };
      const stageClient = requireClient(fixtures.stage);
      const validateClient = requireClient(fixtures.validate);
      const unassignedClient = requireClient(fixtures.unassigned);
      const multiClient = requireClient(fixtures.multi);

      await Promise.all([
        createHostileTempShadows(stageClient),
        createHostileTempShadows(validateClient),
      ]);
      await expectPostgresCode(
        sql`select * from public.food_import_batch limit 1`.execute(stageClient),
        "42501",
      );
      await expectPostgresCode(
        sql`select * from public.food_import_record limit 1`.execute(validateClient),
        "42501",
      );

      const mainSourceCode = `SV${token.toUpperCase()}`;
      const driftSourceCode = `SD${token.toUpperCase()}`;
      await registerReviewedSource(ownerClient, mainSourceCode, token);
      await registerReviewedSource(ownerClient, driftSourceCode, `${token}-drift`);
      await registerSourceNutrientMappings(ownerClient, {
        mappings: [
          {
            canonicalNutrient: {
              code: "protein",
              dimension: "mass",
              name: "Protein",
              unit: "g",
            },
            sourceName: "Protein",
            sourceNutrientKey: "1003",
            sourceUnit: "g",
          },
        ],
        reviewedAt: new Date(Date.now() - 60_000).toISOString(),
        reviewedBy: "principal:stage-validate-mapping-review",
        sourceCode: driftSourceCode,
      });
      const mainMappingDigest = await getSourceNutrientMappingDigest(ownerClient, mainSourceCode);
      const driftMappingDigest = await getSourceNutrientMappingDigest(ownerClient, driftSourceCode);

      const mainStageDocument = buildStageDocument(
        mainSourceCode,
        "authority-main",
        mainMappingDigest,
      );
      const mainStageDocumentText = canonicalJson(mainStageDocument as unknown as JsonObject);
      await expectPostgresCode(stageImportBatch(unassignedClient, mainStageDocumentText), "42501");
      await expectPostgresCode(stageImportBatch(validateClient, mainStageDocumentText), "42501");
      await expectPostgresCode(stageImportBatch(multiClient, mainStageDocumentText), "42501");

      const staged = await stageImportBatch(stageClient, mainStageDocumentText);
      expect(staged).toMatchObject({
        nextOffset: 0,
        resumed: false,
        stagedCount: 0,
        status: "staging",
      });
      expect(await stageImportBatch(stageClient, mainStageDocumentText)).toEqual({
        ...staged,
        resumed: true,
      });
      await expectPostgresCode(
        stageImportBatch(
          stageClient,
          canonicalJson({
            ...(mainStageDocument as unknown as JsonObject),
            artifactUri: "s3://catalogue-stage-validate/divergent-provenance.json",
          }),
        ),
        "55000",
        "differs from immutable batch provenance",
      );
      await expectPostgresCode(
        stageImportBatch(
          stageClient,
          canonicalJson({
            ...(mainStageDocument as unknown as JsonObject),
            evidenceBundleSha256: sha256Text("divergent-evidence-bundle"),
          }),
        ),
        "55000",
        "differs from immutable batch provenance",
      );

      const mainRecord = buildStagedRecord("record-main", 0, "main");
      const mainChunkText = buildChunkDocument([mainRecord]);
      expect(await stageRecordChunk(stageClient, staged.batchId, 0, mainChunkText)).toEqual({
        inserted: 1,
        nextOffset: 1,
        replayed: 0,
        stagedCount: 1,
        wasAlreadyStaged: false,
      });
      expect(await stageRecordChunk(stageClient, staged.batchId, 0, mainChunkText)).toEqual({
        inserted: 0,
        nextOffset: 1,
        replayed: 1,
        stagedCount: 1,
        wasAlreadyStaged: true,
      });
      await expectPostgresCode(
        stageRecordChunk(
          stageClient,
          staged.batchId,
          0,
          buildChunkDocument([{ ...mainRecord, sourceRecordKey: "record-changed-key" }]),
        ),
        "23505",
      );
      await expectPostgresCode(
        stageRecordChunk(
          stageClient,
          staged.batchId,
          0,
          buildChunkDocument([{ ...mainRecord, sequenceNumber: 1 }]),
        ),
        "23514",
        "sequences must be contiguous",
      );
      await expectPostgresCode(
        stageRecordChunk(
          stageClient,
          staged.batchId,
          0,
          buildChunkDocument([
            {
              ...mainRecord,
              sourcePayloadSha256: sha256Text("changed-source-payload"),
            },
          ]),
        ),
        "55000",
        "replay differs",
      );
      const oversizedChunk = Array.from({ length: 251 }, (_, sequenceNumber) =>
        buildStagedRecord(`oversized-${sequenceNumber}`, sequenceNumber, "oversized"),
      );
      await expectPostgresCode(
        stageRecordChunk(stageClient, staged.batchId, 0, buildChunkDocument(oversizedChunk)),
        "22023",
        "between 1 and 250 records",
      );
      const recordLimitOverflowChunk = Array.from({ length: 2 }, (_, index) =>
        buildStagedRecord(`record-limit-${index}`, 9_999 + index, "record-limit"),
      );
      await expectPostgresCode(
        stageRecordChunk(
          stageClient,
          staged.batchId,
          9_999,
          buildChunkDocument(recordLimitOverflowChunk),
        ),
        "54000",
        "cannot exceed 10000 records",
      );
      expect(
        (
          await sql<{ readonly count: number }>`
            select pg_catalog.count(*)::integer as count
            from public.food_import_record
            where batch_id = ${staged.batchId}::uuid
          `.execute(ownerClient)
        ).rows[0],
      ).toEqual({ count: 1 });

      const mainParserDocument = buildParserReportDocument("main", {
        emittedNutrientCount: 0,
        emittedPortionCount: 0,
        emittedRecordCount: 1,
        excludedNutrientCount: 0,
        excludedPortionCount: 0,
        excludedRecordCount: 0,
        sourceNutrientCount: 0,
        sourcePortionCount: 0,
        sourceRecordCount: 1,
      });
      const mainSeal = await stageParserReport(
        stageClient,
        staged.batchId,
        mainParserDocument.document,
      );
      expect(mainSeal).toMatchObject({
        parserReportSha256: mainParserDocument.reportSha256,
        wasAlreadySealed: false,
      });
      expect(mainSeal.stagingSealSha256).toHaveLength(64);
      expect(
        await stageParserReport(stageClient, staged.batchId, mainParserDocument.document),
      ).toEqual({ ...mainSeal, wasAlreadySealed: true });

      const lateRecord = buildStagedRecord("record-late", 1, "late");
      await expectPostgresCode(
        sql`
          insert into public.food_import_record (
            batch_id, source_record_key, source_record_type, sequence_number,
            source_payload_sha256, canonical_payload_sha256, canonical_payload
          ) values (
            ${staged.batchId}::uuid,
            ${lateRecord.sourceRecordKey},
            ${lateRecord.sourceRecordType},
            ${lateRecord.sequenceNumber}::bigint,
            ${lateRecord.sourcePayloadSha256},
            ${lateRecord.canonicalPayloadSha256},
            ${lateRecord.canonicalPayloadDocument}::jsonb
          )
        `.execute(ownerClient),
        "55000",
        "cannot be appended after the staging seal",
      );
      await expectPostgresCode(
        sql`
          update public.food_import_checkpoint
          set cursor_data = cursor_data
          where batch_id = ${staged.batchId}::uuid and stage = 'stage'
        `.execute(ownerClient),
        "55000",
        "cannot change after the staging seal",
      );
      await expectPostgresCode(
        sql`
          update public.food_import_batch
          set staging_seal_sha256 = ${"f".repeat(64)}
          where id = ${staged.batchId}::uuid
        `.execute(ownerClient),
        "55000",
        "can only be recorded once",
      );

      const driftStageDocument = buildStageDocument(
        driftSourceCode,
        "authority-drift",
        driftMappingDigest,
      );
      const driftStage = await stageImportBatch(
        stageClient,
        canonicalJson(driftStageDocument as unknown as JsonObject),
      );
      const driftParserDocument = buildParserReportDocument("drift", {
        emittedNutrientCount: 0,
        emittedPortionCount: 0,
        emittedRecordCount: 0,
        excludedNutrientCount: 0,
        excludedPortionCount: 0,
        excludedRecordCount: 0,
        sourceNutrientCount: 0,
        sourcePortionCount: 0,
        sourceRecordCount: 0,
      });
      await stageParserReport(stageClient, driftStage.batchId, driftParserDocument.document);

      await expectPostgresCode(observeValidation(unassignedClient, staged.batchId), "42501");
      await expectPostgresCode(observeValidation(multiClient, staged.batchId), "42501");

      await sql`
        revoke nutrition_catalogue_stage from ${sql.id(fixtures.stage.login)}
      `.execute(bootstrap);
      await sql`
        grant nutrition_catalogue_validate to ${sql.id(fixtures.stage.login)}
        with admin false, inherit true, set false
      `.execute(bootstrap);
      await expectPostgresCode(
        observeValidation(stageClient, staged.batchId),
        "42501",
        "requires a distinct authenticated validator",
      );

      const observation = await observeValidation(validateClient, staged.batchId);
      expect(observation).toMatchObject({
        observation: {
          batch: {
            id: staged.batchId,
            stagedDatabasePrincipal: fixtures.stage.login,
            stagingSealSha256: mainSeal.stagingSealSha256,
          },
        },
        schemaVersion: 1,
      });
      expect(observation.observation.records).toHaveLength(1);
      const validationDocument = buildQuarantineValidationDocument(
        observation,
        mainMappingDigest,
        mainRecord,
      );
      await expectPostgresCode(
        validateImportBatch(
          validateClient,
          staged.batchId,
          mainSeal.stagingSealSha256,
          observation.observationSha256,
          replaceDigestSourceRecordKey(validationDocument, 42),
        ),
        "22023",
        "record digest contract differs",
      );
      const validation = await validateImportBatch(
        validateClient,
        staged.batchId,
        mainSeal.stagingSealSha256,
        observation.observationSha256,
        validationDocument,
      );
      expect(validation).toMatchObject({
        excludedNutrientCount: 0,
        nutrientInputCount: 0,
        nutrientMaterializableCount: 0,
        nutrientMappingDigest: mainMappingDigest,
        promotionEligible: true,
        quarantinedCount: 1,
        recordErrorCount: 0,
        stagedCount: 1,
        unresolvedErrorCount: 0,
        validCount: 0,
        warningCount: 0,
        wasAlreadyValidated: false,
      });
      expect(validation.validationDigest).toEqual(expect.any(String));
      expect(validation.validationDigest).toHaveLength(64);
      await expectPostgresCode(
        validateImportBatch(
          validateClient,
          staged.batchId,
          mainSeal.stagingSealSha256,
          "0".repeat(64),
          validationDocument,
        ),
        "23514",
        "observation digest is not bound",
      );
      await expectPostgresCode(
        validateImportBatch(
          validateClient,
          staged.batchId,
          mainSeal.stagingSealSha256,
          observation.observationSha256,
          replaceOuterValidationRecord(validationDocument, {
            validationIssuesDocument: canonicalJson([
              {
                code: "REPLAY_DIVERGENCE",
                severity: "warning",
              },
            ]),
          }),
        ),
        "55000",
        "replay issues differ",
      );
      await expectPostgresCode(
        validateImportBatch(
          validateClient,
          staged.batchId,
          mainSeal.stagingSealSha256,
          observation.observationSha256,
          replaceOuterValidationRecord(validationDocument, {
            validatedFoodDocument: canonicalJson({
              schemaVersion: 1,
            }),
          }),
        ),
        "55000",
        "replay quarantined-record evidence differs",
      );
      expect(
        await validateImportBatch(
          validateClient,
          staged.batchId,
          mainSeal.stagingSealSha256,
          observation.observationSha256,
          validationDocument,
        ),
      ).toMatchObject({
        nutrientMappingDigest: mainMappingDigest,
        promotionEligible: true,
        quarantinedCount: 1,
        stagedCount: 1,
        validCount: 0,
        validationDigest: validation.validationDigest,
        warningCount: 0,
        wasAlreadyValidated: true,
      });

      const assertSealedEvidenceDriftRejected = async (
        expectedCode: string,
        expectedMessage: string,
      ): Promise<void> => {
        await expectPostgresCode(
          observeValidation(validateClient, staged.batchId),
          expectedCode,
          expectedMessage,
        );
        await expectPostgresCode(
          validateImportBatch(
            validateClient,
            staged.batchId,
            mainSeal.stagingSealSha256,
            observation.observationSha256,
            validationDocument,
          ),
          expectedCode,
          expectedMessage,
        );
      };

      await sql`
        alter table public.food_import_parser_report
        disable trigger food_import_parser_report_reject_update
      `.execute(ownerClient);
      try {
        await sql`
          update public.food_import_parser_report
          set report = report || '{"replayTamper":true}'::jsonb
          where batch_id = ${staged.batchId}::uuid
        `.execute(ownerClient);
        await assertSealedEvidenceDriftRejected("55000", "changed after sealing");
      } finally {
        await sql`
          update public.food_import_parser_report
          set report = report - 'replayTamper'
          where batch_id = ${staged.batchId}::uuid
        `.execute(ownerClient);
        await sql`
          alter table public.food_import_parser_report
          enable trigger food_import_parser_report_reject_update
        `.execute(ownerClient);
      }

      await sql`
        alter table public.food_import_checkpoint
        disable trigger food_import_checkpoint_guard_staging_seal
      `.execute(ownerClient);
      try {
        await sql`
          update public.food_import_checkpoint
          set cursor_data = pg_catalog.jsonb_build_object('nextOffset', 999)
          where batch_id = ${staged.batchId}::uuid and stage = 'stage'
        `.execute(ownerClient);
        await assertSealedEvidenceDriftRejected(
          "23514",
          "checkpoint differs from the complete record set",
        );
      } finally {
        await sql`
          update public.food_import_checkpoint
          set cursor_data = pg_catalog.jsonb_build_object('nextOffset', 1)
          where batch_id = ${staged.batchId}::uuid and stage = 'stage'
        `.execute(ownerClient);
        await sql`
          alter table public.food_import_checkpoint
          enable trigger food_import_checkpoint_guard_staging_seal
        `.execute(ownerClient);
      }

      expect(
        (
          await sql<{
            readonly stagedCapability: string | null;
            readonly stagedPrincipal: string | null;
            readonly status: string;
            readonly validatedCapability: string | null;
            readonly validatedPrincipal: string | null;
          }>`
            select
              staged_database_capability_role as "stagedCapability",
              staged_database_principal as "stagedPrincipal",
              status,
              validated_database_capability_role as "validatedCapability",
              validated_database_principal as "validatedPrincipal"
            from public.food_import_batch
            where id = ${staged.batchId}::uuid
          `.execute(ownerClient)
        ).rows[0],
      ).toEqual({
        stagedCapability: "nutrition_catalogue_stage",
        stagedPrincipal: fixtures.stage.login,
        status: "ready",
        validatedCapability: "nutrition_catalogue_validate",
        validatedPrincipal: fixtures.validate.login,
      });

      const currentDriftRevision = await ownerClient
        .selectFrom("source_nutrient_map")
        .select("current_revision_id")
        .where("source_nutrient_key", "=", "1003")
        .where(
          "food_source_id",
          "=",
          ownerClient.selectFrom("food_source").select("id").where("code", "=", driftSourceCode),
        )
        .executeTakeFirstOrThrow();
      await supersedeSourceNutrientMapping(ownerClient, {
        changeReason: "Exercise post-seal active mapping drift rejection",
        expectedCurrentRevisionId: currentDriftRevision.current_revision_id,
        mapping: {
          canonicalNutrient: {
            code: "protein",
            dimension: "mass",
            name: "Protein",
            unit: "g",
          },
          conversionMultiplier: "2",
          sourceName: "Protein",
          sourceNutrientKey: "1003",
          sourceUnit: "g",
        },
        reviewedAt: new Date().toISOString(),
        reviewedBy: "principal:stage-validate-mapping-correction",
        sourceCode: driftSourceCode,
      });
      await expectPostgresCode(
        observeValidation(validateClient, driftStage.batchId),
        "55000",
        "changed after sealing",
      );

      const ownerStageDocument = buildStageDocument(
        mainSourceCode,
        "owner-local-compatibility",
        mainMappingDigest,
      );
      const ownerBatch = await stageBatch(ownerClient, stageInput(ownerStageDocument));
      await ownerClient
        .updateTable("food_import_batch")
        .set({ status: "failed" })
        .where("id", "=", ownerBatch.batchId)
        .execute();
      expect(
        (
          await sql<{
            readonly stagedCapability: string | null;
            readonly stagedPrincipal: string | null;
            readonly stagingSeal: string | null;
            readonly stagingSealedAt: Date | null;
            readonly validatedCapability: string | null;
            readonly validatedPrincipal: string | null;
          }>`
            select
              staged_database_capability_role as "stagedCapability",
              staged_database_principal as "stagedPrincipal",
              staging_seal_sha256 as "stagingSeal",
              staging_sealed_at as "stagingSealedAt",
              validated_database_capability_role as "validatedCapability",
              validated_database_principal as "validatedPrincipal"
            from public.food_import_batch
            where id = ${ownerBatch.batchId}::uuid
          `.execute(ownerClient)
        ).rows[0],
      ).toEqual({
        stagedCapability: null,
        stagedPrincipal: null,
        stagingSeal: null,
        stagingSealedAt: null,
        validatedCapability: null,
        validatedPrincipal: null,
      });
    } catch (error) {
      primaryFailure = error;
    } finally {
      const attemptCleanup = async (operation: () => Promise<unknown>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          cleanupFailures.push(error);
        }
      };

      for (const client of loginClients) {
        await attemptCleanup(() => client.destroy());
      }
      const ownerClient = owner;
      if (ownerClient) await attemptCleanup(() => ownerClient.destroy());

      if (cleanupReserved) {
        await attemptCleanup(() =>
          sql`drop database if exists ${sql.id(ephemeralDatabaseName)}`.execute(bootstrap),
        );
        for (const fixture of [...fixtureList].reverse()) {
          await attemptCleanup(() =>
            sql`drop role if exists ${sql.id(fixture.login)}`.execute(bootstrap),
          );
        }
        await attemptCleanup(async () => {
          const residue = (
            await sql<{ readonly exists: boolean }>`
              select
                exists (
                  select 1
                  from pg_catalog.pg_database as database_row
                  where database_row.datname = ${ephemeralDatabaseName}
                ) or exists (
                  select 1
                  from pg_catalog.pg_roles as role_row
                  where role_row.rolname in (${sql.join(
                    fixtureList.map((fixture) => sql`${fixture.login}`),
                  )})
                ) as exists
            `.execute(bootstrap)
          ).rows[0]?.exists;
          if (residue !== false) {
            throw new Error(
              "Catalogue stage/validate integration cleanup left database or role residue",
            );
          }
        });
      }
      await attemptCleanup(() => bootstrap.destroy());
    }

    if (primaryFailure !== undefined || cleanupFailures.length > 0) {
      throw new AggregateError(
        [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures],
        "Catalogue stage/validate integration test or cleanup failed",
      );
    }
  });
});

async function assertAuthorityPrivileges(
  database: Kysely<Database>,
  schemaName: string,
  ownerName: string,
): Promise<void> {
  const schemaAcl = (
    await sql<{
      readonly grantee: string;
      readonly isGrantable: boolean;
      readonly privilegeType: string;
    }>`
      select
        grantee_role.rolname as grantee,
        schema_acl.privilege_type as "privilegeType",
        schema_acl.is_grantable as "isGrantable"
      from pg_catalog.pg_namespace as namespace_row
      cross join lateral pg_catalog.aclexplode(namespace_row.nspacl) as schema_acl
      join pg_catalog.pg_roles as grantee_role on grantee_role.oid = schema_acl.grantee
      where namespace_row.nspname = ${schemaName}
        and grantee_role.rolname in (
          'nutrition_catalogue_stage',
          'nutrition_catalogue_validate'
        )
      order by grantee_role.rolname, schema_acl.privilege_type
    `.execute(database)
  ).rows;
  expect(schemaAcl).toEqual([
    {
      grantee: "nutrition_catalogue_stage",
      isGrantable: false,
      privilegeType: "USAGE",
    },
    {
      grantee: "nutrition_catalogue_validate",
      isGrantable: false,
      privilegeType: "USAGE",
    },
  ]);

  for (const capability of ["nutrition_catalogue_stage", "nutrition_catalogue_validate"] as const) {
    expect(
      (
        await sql<{ readonly allowed: boolean }>`
          select pg_catalog.has_schema_privilege(
            ${capability},
            ${schemaName},
            'CREATE'
          ) as allowed
        `.execute(database)
      ).rows[0]?.allowed,
    ).toBe(false);
  }

  for (const functionSpec of authorityFunctions) {
    const qualifiedIdentity = `${schemaName}.${functionSpec.identity}`;
    const acl = (
      await sql<{
        readonly grantee: string;
        readonly isGrantable: boolean;
        readonly privilegeType: string;
      }>`
        select
          grantee_role.rolname as grantee,
          function_acl.privilege_type as "privilegeType",
          function_acl.is_grantable as "isGrantable"
        from pg_catalog.pg_proc as procedure_row
        cross join lateral pg_catalog.aclexplode(procedure_row.proacl) as function_acl
        join pg_catalog.pg_roles as grantee_role on grantee_role.oid = function_acl.grantee
        where procedure_row.oid = pg_catalog.to_regprocedure(${qualifiedIdentity})
        order by grantee_role.rolname
      `.execute(database)
    ).rows;
    const expectedGrantees = [
      ownerName,
      ...(functionSpec.allowedCapability ? [functionSpec.allowedCapability] : []),
    ].sort();
    expect(acl).toEqual(
      expectedGrantees.map((grantee) => ({
        grantee,
        isGrantable: false,
        privilegeType: "EXECUTE",
      })),
    );

    for (const capability of capabilityRoles) {
      expect(
        (
          await sql<{ readonly allowed: boolean }>`
            select pg_catalog.has_function_privilege(
              ${capability},
              ${qualifiedIdentity},
              'EXECUTE'
            ) as allowed
          `.execute(database)
        ).rows[0]?.allowed,
      ).toBe(capability === functionSpec.allowedCapability);
    }
  }

  for (const capability of ["nutrition_catalogue_stage", "nutrition_catalogue_validate"] as const) {
    const privileges = (
      await sql<{
        readonly columnPrivilege: boolean;
        readonly relationPrivilege: boolean;
        readonly sequencePrivilege: boolean;
      }>`
        select
          exists (
            select 1
            from pg_catalog.pg_class as class_row
            join pg_catalog.pg_namespace as namespace_row
              on namespace_row.oid = class_row.relnamespace
            where namespace_row.nspname = ${schemaName}
              and class_row.relkind in ('r', 'p', 'v', 'm', 'f')
              and (
                pg_catalog.has_table_privilege(${capability}, class_row.oid, 'SELECT')
                or pg_catalog.has_table_privilege(${capability}, class_row.oid, 'INSERT')
                or pg_catalog.has_table_privilege(${capability}, class_row.oid, 'UPDATE')
                or pg_catalog.has_table_privilege(${capability}, class_row.oid, 'DELETE')
                or pg_catalog.has_table_privilege(${capability}, class_row.oid, 'TRUNCATE')
                or pg_catalog.has_table_privilege(${capability}, class_row.oid, 'REFERENCES')
                or pg_catalog.has_table_privilege(${capability}, class_row.oid, 'TRIGGER')
              )
          ) as "relationPrivilege",
          exists (
            select 1
            from pg_catalog.pg_attribute as attribute_row
            join pg_catalog.pg_class as class_row on class_row.oid = attribute_row.attrelid
            join pg_catalog.pg_namespace as namespace_row
              on namespace_row.oid = class_row.relnamespace
            where namespace_row.nspname = ${schemaName}
              and class_row.relkind in ('r', 'p', 'v', 'm', 'f')
              and attribute_row.attnum > 0
              and not attribute_row.attisdropped
              and (
                pg_catalog.has_column_privilege(
                  ${capability}, class_row.oid, attribute_row.attnum, 'SELECT'
                )
                or pg_catalog.has_column_privilege(
                  ${capability}, class_row.oid, attribute_row.attnum, 'INSERT'
                )
                or pg_catalog.has_column_privilege(
                  ${capability}, class_row.oid, attribute_row.attnum, 'UPDATE'
                )
                or pg_catalog.has_column_privilege(
                  ${capability}, class_row.oid, attribute_row.attnum, 'REFERENCES'
                )
              )
          ) as "columnPrivilege",
          exists (
            select 1
            from pg_catalog.pg_class as class_row
            join pg_catalog.pg_namespace as namespace_row
              on namespace_row.oid = class_row.relnamespace
            where namespace_row.nspname = ${schemaName}
              and class_row.relkind = 'S'
              and (
                pg_catalog.has_sequence_privilege(${capability}, class_row.oid, 'USAGE')
                or pg_catalog.has_sequence_privilege(${capability}, class_row.oid, 'SELECT')
                or pg_catalog.has_sequence_privilege(${capability}, class_row.oid, 'UPDATE')
              )
          ) as "sequencePrivilege"
      `.execute(database)
    ).rows[0];
    expect(privileges).toEqual({
      columnPrivilege: false,
      relationPrivilege: false,
      sequencePrivilege: false,
    });
  }
}

async function createHostileTempShadows(database: Kysely<Database>): Promise<void> {
  await sql`set search_path = pg_temp, public`.execute(database);
  for (const tableName of [
    "food_source",
    "food_import_batch",
    "food_import_record",
    "food_import_checkpoint",
    "food_import_parser_report",
    "source_nutrient_map",
    "source_nutrient_map_revision",
    "nutrient",
    "food_barcode",
    "food",
  ]) {
    await sql`
      create temporary table ${sql.id(tableName)} (shadow_marker text)
      on commit preserve rows
    `.execute(database);
  }
}

async function registerReviewedSource(
  database: Kysely<Database>,
  sourceCode: string,
  suffix: string,
): Promise<void> {
  await registerFoodSourceFromReviewedManifest(database, {
    attributionRequired: true,
    attributionText: "Stage/validate database authority integration fixture",
    code: sourceCode,
    commercialUseAllowed: true,
    databaseRightsNotes: "Synthetic loopback-only integration fixture",
    displayName: `Stage/validate authority source ${suffix}`,
    homepageUrl: "https://example.invalid/catalogue-stage-validate",
    kind: "government",
    licenseExpression: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    redistributionAllowed: true,
    rightsReviewStatus: "approved",
    rightsReviewedAt: new Date(Date.now() - 120_000).toISOString(),
    rightsReviewedBy: "principal:stage-validate-rights-review",
  });
}

function buildStageDocument(
  sourceCode: string,
  releaseKey: string,
  nutrientMappingDigest: string,
): StageDocument {
  const artifactSha256 = sha256Text(`${sourceCode}:${releaseKey}:artifact`);
  const evidenceBundleSha256 = sha256Text(`${sourceCode}:${releaseKey}:evidence-bundle`);
  const parserBuildSha256 = sha256Text(`${sourceCode}:${releaseKey}:parser-build`);
  const rightsManifestSha256 = sha256Text(`${sourceCode}:rights-manifest`);
  return {
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    artifactBytes: 1_024,
    artifactSha256,
    artifactUri: `s3://catalogue-stage-validate/${sourceCode}/${releaseKey}.json`,
    evidenceBundleSha256,
    evidenceBundleUri: `s3://catalogue-evidence/sha256/${evidenceBundleSha256}/bundle.json`,
    evidenceDecisionSha256: sha256Text(`${sourceCode}:${releaseKey}:evidence-decision`),
    evidenceObjectVersionId: `fixture-${evidenceBundleSha256}`,
    evidenceValidUntil: new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString(),
    mediaType: "application/json",
    parserVersion: `authority-parser@1.0.0+build.${parserBuildSha256}+mapping.${nutrientMappingDigest}`,
    publishedOn: "2026-09-06",
    releaseClass: "live-reviewed",
    releaseKey,
    rightsManifestSha256,
    rightsManifestUri: `repo://manifests/${sourceCode}.json`,
    schemaVersion: 1,
    sourceCode,
    upstreamSchemaVersion: "authority-integration-v1",
  };
}

function stageInput(document: StageDocument) {
  return {
    acquiredAt: document.acquiredAt,
    artifactBytes: document.artifactBytes,
    artifactSha256: document.artifactSha256,
    artifactUri: document.artifactUri,
    evidenceBundleSha256: document.evidenceBundleSha256,
    evidenceBundleUri: document.evidenceBundleUri,
    evidenceDecisionSha256: document.evidenceDecisionSha256,
    evidenceObjectVersionId: document.evidenceObjectVersionId,
    evidenceValidUntil: document.evidenceValidUntil,
    mediaType: document.mediaType,
    parserVersion: document.parserVersion,
    publishedOn: document.publishedOn,
    releaseClass: document.releaseClass,
    releaseKey: document.releaseKey,
    rightsManifestSha256: document.rightsManifestSha256,
    rightsManifestUri: document.rightsManifestUri,
    sourceCode: document.sourceCode,
    upstreamSchemaVersion: document.upstreamSchemaVersion,
  };
}

function buildStagedRecord(
  sourceRecordKey: string,
  sequenceNumber: number,
  payloadMarker: string,
): StagedRecordDocument {
  const canonicalPayloadDocument = canonicalJson({
    payloadMarker,
    schemaVersion: 1,
  });
  return {
    canonicalPayloadDocument,
    canonicalPayloadSha256: sha256Text(canonicalPayloadDocument),
    sequenceNumber,
    sourcePayloadSha256: sha256Text(`${sourceRecordKey}:source-payload`),
    sourceRecordKey,
    sourceRecordType: "authority-fixture",
  };
}

function buildChunkDocument(records: readonly StagedRecordDocument[]): string {
  return canonicalJson({
    records: records.map((record) => ({ ...record })),
    schemaVersion: 1,
  });
}

function buildParserReportDocument(
  marker: string,
  counts: ParserCounts,
): { readonly document: string; readonly reportSha256: string } {
  const reportDocument = canonicalJson({
    marker,
    reportKind: "stage-validate-authority-integration",
    schemaVersion: 1,
  });
  const reportSha256 = sha256Text(reportDocument);
  return {
    document: canonicalJson({
      ...counts,
      reportDocument,
      reportSha256,
      schemaVersion: 1,
    }),
    reportSha256,
  };
}

function buildQuarantineValidationDocument(
  observationResult: ValidationObservationResult,
  nutrientMappingDigest: string,
  record: StagedRecordDocument,
): string {
  const { batch, nutrientMappings, parserReport } = observationResult.observation;
  const policy: JsonObject = {
    maximumExcludedNutrientFraction: 1,
    maximumQuarantineFraction: 1,
    maximumQuarantinedRecords: 1,
    requireAtLeastOneValidRecord: false,
    requireDistinctApprovalPrincipals: true,
    requireMaterializedNutrientPerValidRecord: true,
  };
  const issues: readonly never[] = [];
  const digestDocument = canonicalJson({
    artifactSha256: batch.artifactSha256,
    batchId: batch.id,
    evidenceBundleSha256: batch.evidenceBundleSha256,
    evidenceBundleUri: batch.evidenceBundleUri,
    evidenceDecisionSha256: batch.evidenceDecisionSha256,
    evidenceObjectVersionId: batch.evidenceObjectVersionId,
    evidenceValidUntil: batch.evidenceValidUntil,
    nutrientMappingDigest,
    nutrientMappingRevisionIds: nutrientMappings.map((mapping) => mapping.revisionId).sort(),
    observationSha256: observationResult.observationSha256,
    parserEvidence: {
      emittedNutrientCount: parserReport.emittedNutrientCount,
      emittedPortionCount: parserReport.emittedPortionCount,
      emittedRecordCount: parserReport.emittedRecordCount,
      excludedNutrientCount: parserReport.excludedNutrientCount,
      excludedPortionCount: parserReport.excludedPortionCount,
      excludedRecordCount: parserReport.excludedRecordCount,
      sourceNutrientCount: parserReport.sourceNutrientCount,
      sourcePortionCount: parserReport.sourcePortionCount,
      sourceRecordCount: parserReport.sourceRecordCount,
    },
    parserReportSha256: parserReport.reportSha256,
    policy,
    records: [
      {
        canonicalPayloadSha256: record.canonicalPayloadSha256,
        excludedNutrientCount: 0,
        issues,
        nutrientInputCount: 0,
        nutrientMaterializableCount: 0,
        portionInputCount: 0,
        sourceRecordKey: record.sourceRecordKey,
        status: "quarantined",
        validatedFoodContractVersion: null,
        validatedFoodSha256: null,
      },
    ],
    releaseClass: batch.releaseClass,
    rightsManifestSha256: batch.rightsManifestSha256,
    validatedFoodContractVersion: 1,
  });
  return canonicalJson({
    digestDocument,
    records: [
      {
        sourceRecordKey: record.sourceRecordKey,
        validatedFoodDocument: null,
        validationIssuesDocument: canonicalJson(issues),
      },
    ],
    schemaVersion: 1,
  });
}

function replaceOuterValidationRecord(
  validationDocument: string,
  replacement: Readonly<{
    validatedFoodDocument?: string | null;
    validationIssuesDocument?: string;
  }>,
): string {
  const document = JSON.parse(validationDocument) as {
    readonly digestDocument: string;
    readonly records: readonly JsonObject[];
    readonly schemaVersion: number;
  };
  const record = document.records[0];
  if (!record || document.records.length !== 1) {
    throw new Error("Validation replay fixture must contain exactly one outer record");
  }
  return canonicalJson({
    digestDocument: document.digestDocument,
    records: [{ ...record, ...replacement }],
    schemaVersion: document.schemaVersion,
  });
}

function replaceDigestSourceRecordKey(validationDocument: string, sourceRecordKey: number): string {
  const document = JSON.parse(validationDocument) as {
    readonly digestDocument: string;
    readonly records: readonly JsonObject[];
    readonly schemaVersion: number;
  };
  const digestDocument = JSON.parse(document.digestDocument) as JsonObject & {
    readonly records: readonly JsonObject[];
  };
  const record = digestDocument.records[0];
  if (!record || digestDocument.records.length !== 1) {
    throw new Error("Validation digest fixture must contain exactly one record");
  }
  return canonicalJson({
    digestDocument: canonicalJson({
      ...digestDocument,
      records: [{ ...record, sourceRecordKey }],
    }),
    records: document.records,
    schemaVersion: document.schemaVersion,
  });
}

async function stageImportBatch(
  database: Kysely<Database>,
  stageDocument: string,
): Promise<StageBatchResult> {
  const result = (
    await sql<{ readonly result: StageBatchResult }>`
      select public.catalogue_stage_import_batch(${stageDocument}::text) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Catalogue stage function returned no result");
  return result;
}

async function stageRecordChunk(
  database: Kysely<Database>,
  batchId: string,
  expectedNextOffset: number,
  recordsDocument: string,
): Promise<StageChunkResult> {
  const result = (
    await sql<{ readonly result: StageChunkResult }>`
      select public.catalogue_stage_import_record_chunk(
        ${batchId}::uuid,
        ${expectedNextOffset}::bigint,
        ${recordsDocument}::text
      ) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Catalogue stage-chunk function returned no result");
  return result;
}

async function stageParserReport(
  database: Kysely<Database>,
  batchId: string,
  parserReportDocument: string,
): Promise<ParserSealResult> {
  const result = (
    await sql<{ readonly result: ParserSealResult }>`
      select public.catalogue_stage_import_parser_report(
        ${batchId}::uuid,
        ${parserReportDocument}::text
      ) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Catalogue parser-seal function returned no result");
  return result;
}

async function observeValidation(
  database: Kysely<Database>,
  batchId: string,
): Promise<ValidationObservationResult> {
  const result = (
    await sql<{ readonly result: ValidationObservationResult }>`
      select public.catalogue_observe_import_validation(${batchId}::uuid) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Catalogue validation observation returned no result");
  return result;
}

async function validateImportBatch(
  database: Kysely<Database>,
  batchId: string,
  expectedStagingSealSha256: string,
  expectedObservationSha256: string,
  validationDocument: string,
): Promise<Record<string, unknown>> {
  const result = (
    await sql<{ readonly result: Record<string, unknown> }>`
      select public.catalogue_validate_import_batch(
        ${batchId}::uuid,
        ${expectedStagingSealSha256}::text,
        ${expectedObservationSha256}::text,
        ${validationDocument}::text
      ) as result
    `.execute(database)
  ).rows[0]?.result;
  if (!result) throw new Error("Catalogue validation function returned no result");
  return result;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function expectPostgresCode(
  operation: Promise<unknown>,
  expectedCode: string,
  expectedMessage?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: expectedCode });
  if (expectedMessage) {
    expect(caught).toMatchObject({ message: expect.stringContaining(expectedMessage) });
  }
}

function assertLoopbackDatabaseUrl(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a PostgreSQL URL on literal loopback");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("TEST_DATABASE_URL must use a literal loopback PostgreSQL host");
  }
}

function databaseUrlForName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
