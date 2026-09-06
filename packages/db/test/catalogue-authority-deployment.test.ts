import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertCatalogueAuthorityCanaryEvidence,
  assertCatalogueAuthorityDeploymentEvidence,
  CATALOGUE_ACTIVATION_GUARD_SOURCE_SHA256,
  CATALOGUE_APPROVAL_FUNCTION_SOURCE_SHA256,
  CATALOGUE_APPROVAL_GUARD_SOURCE_SHA256,
  CATALOGUE_AUTHORITY_CONSTRAINT_POLICY,
  CATALOGUE_AUTHORITY_FROZEN_COLUMN_POLICY,
  CATALOGUE_AUTHORITY_FUNCTION_POLICY,
  CATALOGUE_AUTHORITY_INDEX_POLICY,
  CATALOGUE_AUTHORITY_TRIGGER_POLICY,
  CATALOGUE_CAPABILITY_ROLES,
  CATALOGUE_OBSERVE_VALIDATION_FUNCTION_SOURCE_SHA256,
  CATALOGUE_PROMOTION_FUNCTION_SOURCE_SHA256,
  CATALOGUE_REVIEWER_CAPABILITIES,
  CATALOGUE_ROLLBACK_FUNCTION_SOURCE_SHA256,
  CATALOGUE_STAGE_BATCH_FUNCTION_SOURCE_SHA256,
  CATALOGUE_STAGE_PARSER_REPORT_FUNCTION_SOURCE_SHA256,
  CATALOGUE_STAGE_RECORD_CHUNK_FUNCTION_SOURCE_SHA256,
  CATALOGUE_STAGE_VALIDATE_GUARD_SOURCE_SHA256,
  CATALOGUE_VALIDATE_BATCH_FUNCTION_SOURCE_SHA256,
  type CatalogueAuthorityDeploymentEvidence,
  type CatalogueAuthorityDeploymentPolicy,
  catalogueAuthorityDeploymentPolicySha256,
  catalogueAuthorityDeploymentStructure,
  catalogueAuthorityDeploymentStructureSha256,
  parseCatalogueAuthorityDeploymentPolicy,
} from "../src/catalogue-authority-deployment.js";
import { canonicalJson } from "../src/catalogue-validation.js";
import type { JsonValue } from "../src/types.js";

const rawPolicy = {
  activationGuardSourceSha256: CATALOGUE_ACTIVATION_GUARD_SOURCE_SHA256,
  applicationSchema: "public",
  applicationSchemaOwner: "pg_database_owner",
  approvalFunctionSourceSha256: CATALOGUE_APPROVAL_FUNCTION_SOURCE_SHA256,
  approvalGuardSourceSha256: CATALOGUE_APPROVAL_GUARD_SOURCE_SHA256,
  databaseName: "nutrition_tracker",
  databaseOwner: "nutrition_app",
  effectiveLoginAllowlist: [
    "nutrition_api",
    "nutrition_app",
    "nutrition_catalogue_data_reviewer",
    "nutrition_catalogue_quality_reviewer",
    "nutrition_catalogue_rights_reviewer",
    "nutrition_catalogue_unassigned_canary",
    "nutrition_worker",
  ],
  nonReviewerLogins: {
    api: "nutrition_api",
    unassigned: "nutrition_catalogue_unassigned_canary",
    worker: "nutrition_worker",
  },
  observeValidationFunctionSourceSha256: CATALOGUE_OBSERVE_VALIDATION_FUNCTION_SOURCE_SHA256,
  policyKind: "catalogue-authority-deployment",
  promotionFunctionSourceSha256: CATALOGUE_PROMOTION_FUNCTION_SOURCE_SHA256,
  reviewerLogins: {
    data: "nutrition_catalogue_data_reviewer",
    quality: "nutrition_catalogue_quality_reviewer",
    rights: "nutrition_catalogue_rights_reviewer",
  },
  rollbackFunctionSourceSha256: CATALOGUE_ROLLBACK_FUNCTION_SOURCE_SHA256,
  schemaVersion: 4,
  stageBatchFunctionSourceSha256: CATALOGUE_STAGE_BATCH_FUNCTION_SOURCE_SHA256,
  stageParserReportFunctionSourceSha256: CATALOGUE_STAGE_PARSER_REPORT_FUNCTION_SOURCE_SHA256,
  stageRecordChunkFunctionSourceSha256: CATALOGUE_STAGE_RECORD_CHUNK_FUNCTION_SOURCE_SHA256,
  stageValidateGuardSourceSha256: CATALOGUE_STAGE_VALIDATE_GUARD_SOURCE_SHA256,
  validateBatchFunctionSourceSha256: CATALOGUE_VALIDATE_BATCH_FUNCTION_SOURCE_SHA256,
} as const;

function validEvidence(
  policy: CatalogueAuthorityDeploymentPolicy,
): CatalogueAuthorityDeploymentEvidence {
  const acl = (grantee: string, grantor: string, privilege: string) => ({
    grantable: false,
    grantee,
    grantor,
    privilege,
  });
  const memberships = Object.entries(CATALOGUE_REVIEWER_CAPABILITIES).map(
    ([reviewerClass, role]) => ({
      adminOption: false,
      grantor: policy.databaseOwner,
      inheritOption: true,
      member:
        policy.reviewerLogins[
          reviewerClass as keyof CatalogueAuthorityDeploymentPolicy["reviewerLogins"]
        ],
      role,
      setOption: false,
    }),
  );
  const reviewerLogins = Object.values(policy.reviewerLogins);
  const nonReviewerLogins = Object.values(policy.nonReviewerLogins);
  const verifierLogins = [policy.databaseOwner, ...reviewerLogins, ...nonReviewerLogins];
  const relationAcl = [
    "DELETE",
    "INSERT",
    "REFERENCES",
    "SELECT",
    "TRIGGER",
    "TRUNCATE",
    "UPDATE",
  ].map((privilege) => acl(policy.databaseOwner, policy.databaseOwner, privilege));
  const sequenceAcl = ["SELECT", "UPDATE", "USAGE"].map((privilege) =>
    acl(policy.databaseOwner, policy.databaseOwner, privilege),
  );
  return {
    applicationSchema: {
      acl: [
        acl("PUBLIC", policy.applicationSchemaOwner, "USAGE"),
        ...Object.values(CATALOGUE_REVIEWER_CAPABILITIES).map((role) =>
          acl(role, policy.applicationSchemaOwner, "USAGE"),
        ),
        acl("nutrition_catalogue_stage", policy.applicationSchemaOwner, "USAGE"),
        acl("nutrition_catalogue_validate", policy.applicationSchemaOwner, "USAGE"),
        acl("nutrition_catalogue_promote_activate", policy.applicationSchemaOwner, "USAGE"),
        acl("nutrition_catalogue_rollback", policy.applicationSchemaOwner, "USAGE"),
        acl(policy.applicationSchemaOwner, policy.applicationSchemaOwner, "CREATE"),
        acl(policy.applicationSchemaOwner, policy.applicationSchemaOwner, "USAGE"),
      ],
      name: policy.applicationSchema,
      owner: policy.applicationSchemaOwner,
      publicCreate: false,
    },
    authorityConstraints: CATALOGUE_AUTHORITY_CONSTRAINT_POLICY,
    authorityFrozenColumns: CATALOGUE_AUTHORITY_FROZEN_COLUMN_POLICY,
    authorityIndexes: CATALOGUE_AUTHORITY_INDEX_POLICY.map((index) => ({
      ...index,
      owner: policy.databaseOwner,
    })),
    functions: CATALOGUE_AUTHORITY_FUNCTION_POLICY.map((entry) => {
      const { configuration, executeGrantees, ...semantics } = entry;
      const aclIsDefault = executeGrantees === "default";
      const grantees = aclIsDefault
        ? ["PUBLIC", policy.databaseOwner]
        : executeGrantees === "owner-only"
          ? [policy.databaseOwner]
          : [policy.databaseOwner, ...executeGrantees];
      return {
        ...semantics,
        acl: grantees.map((grantee) => acl(grantee, policy.databaseOwner, "EXECUTE")),
        aclIsDefault,
        owner: policy.databaseOwner,
        publicExecute: aclIsDefault,
        searchPath:
          configuration === "application-schema"
            ? [`search_path=pg_catalog, ${policy.applicationSchema}, pg_temp`]
            : [],
      };
    }),
    triggers: CATALOGUE_AUTHORITY_TRIGGER_POLICY.map((entry) => ({
      definition: entry.definition,
      enabled: "O",
      functionArguments: "",
      functionName: entry.functionName,
      functionSchema: policy.applicationSchema,
      name: entry.name,
      tableName: entry.tableName,
      tableSchema: policy.applicationSchema,
    })),
    capabilityRoles: CATALOGUE_CAPABILITY_ROLES.map((name) => ({
      bypassRls: false,
      canCreateDatabase: false,
      canCreateRole: false,
      canLogin: false,
      incomingMemberships: memberships.filter((membership) => membership.role === name),
      name,
      outgoingMemberships: [],
      ownedObjectCount: 0,
      replication: false,
      superuser: false,
    })),
    columnAcls: [],
    explicitColumnAclAttributeCount: 0,
    database: {
      acl: [
        acl("PUBLIC", policy.databaseOwner, "TEMPORARY"),
        acl(policy.databaseOwner, policy.databaseOwner, "CONNECT"),
        acl(policy.databaseOwner, policy.databaseOwner, "CREATE"),
        acl(policy.databaseOwner, policy.databaseOwner, "TEMPORARY"),
        ...[...reviewerLogins, ...nonReviewerLogins].map((login) =>
          acl(login, policy.databaseOwner, "CONNECT"),
        ),
      ],
      effectiveLoginAllowlist: policy.effectiveLoginAllowlist,
      name: policy.databaseName,
      owner: policy.databaseOwner,
      publicConnect: false,
      unexpectedClientSessionCount: 0,
      verifierSessions: verifierLogins.map((login, index) => ({
        applicationName:
          index === 0
            ? "catalogue-authority-deploy-zero-owner"
            : `catalogue-authority-deploy-zero-${
                Object.entries({ ...policy.reviewerLogins, ...policy.nonReviewerLogins }).find(
                  ([, candidate]) => candidate === login,
                )?.[0]
              }`,
        login,
        pid: 100 + index,
      })),
    },
    defaultAcls: [],
    logins: [
      ...reviewerLogins.map((name) => ({
        approvalFunctionExecute: true,
        bypassRls: false,
        canCreateDatabase: false,
        canCreateRole: false,
        canLogin: true,
        effectiveColumnPrivileges: [],
        effectiveSequencePrivileges: [],
        effectiveTablePrivileges: [],
        inherit: true,
        memberships: memberships.filter((membership) => membership.member === name),
        name,
        ownedObjectCount: 0,
        replication: false,
        schemaCreate: false,
        schemaUsage: true,
        superuser: false,
      })),
      ...nonReviewerLogins.map((name) => ({
        approvalFunctionExecute: false,
        bypassRls: false,
        canCreateDatabase: false,
        canCreateRole: false,
        canLogin: true,
        effectiveColumnPrivileges: [],
        effectiveSequencePrivileges: [],
        effectiveTablePrivileges: [],
        inherit: true,
        memberships: [],
        name,
        ownedObjectCount: 0,
        replication: false,
        schemaCreate: false,
        schemaUsage: true,
        superuser: false,
      })),
    ],
    memberships,
    nonSystemSchemas: [policy.applicationSchema],
    policySha256: catalogueAuthorityDeploymentPolicySha256(policy),
    relations: [
      "food_import_approval",
      "food_import_batch",
      "food_import_record",
      "food_source",
      "food_source_release",
      "food_source_release_activation",
    ]
      .map((name) => ({
        acl: relationAcl,
        aclIsDefault: true,
        kind: "r",
        name,
        owner: policy.databaseOwner,
      }))
      .concat(
        ["food_import_approval_id_seq", "food_source_release_activation_id_seq"].map((name) => ({
          acl: sequenceAcl,
          aclIsDefault: true,
          kind: "S",
          name,
          owner: policy.databaseOwner,
        })),
      ),
    schemaVersion: 4,
    types: [
      {
        acl: [
          acl("PUBLIC", policy.databaseOwner, "USAGE"),
          acl(policy.databaseOwner, policy.databaseOwner, "USAGE"),
        ],
        aclIsDefault: true,
        kind: "c",
        name: "food_import_batch",
        owner: policy.databaseOwner,
      },
    ],
  };
}

describe("catalogue authority deployment policy", () => {
  it("pins the complete whole-table authority manifest", () => {
    expect(CATALOGUE_AUTHORITY_FUNCTION_POLICY).toHaveLength(44);
    expect(CATALOGUE_AUTHORITY_TRIGGER_POLICY).toHaveLength(52);
  });

  it("keeps frozen-column evidence in the runtime query's canonical order", () => {
    const identities = CATALOGUE_AUTHORITY_FROZEN_COLUMN_POLICY.map(
      (column) => `${column.tableName}.${column.columnName}`,
    );
    expect(identities).toEqual([...identities].sort());
  });

  it("accepts the exact credential-free policy and deterministic evidence", () => {
    const policy = parseCatalogueAuthorityDeploymentPolicy(rawPolicy);
    expect(catalogueAuthorityDeploymentPolicySha256(policy)).toMatch(/^[0-9a-f]{64}$/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, validEvidence(policy)),
    ).not.toThrow();
  });

  it("rejects any additional non-system schema", () => {
    const policy = parseCatalogueAuthorityDeploymentPolicy(rawPolicy);
    const base = validEvidence(policy);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        nonSystemSchemas: [...base.nonSystemSchemas, "catalogue_authority_backdoor"],
      }),
    ).toThrow(/non-system schema set/u);
  });

  it.each([
    ["secret field", { ...rawPolicy, password: "must-not-appear" }],
    [
      "unsafe login",
      { ...rawPolicy, reviewerLogins: { ...rawPolicy.reviewerLogins, data: "bad-name" } },
    ],
    [
      "duplicate login",
      {
        ...rawPolicy,
        nonReviewerLogins: {
          ...rawPolicy.nonReviewerLogins,
          api: rawPolicy.reviewerLogins.data,
        },
      },
    ],
    [
      "unsorted allowlist",
      { ...rawPolicy, effectiveLoginAllowlist: [...rawPolicy.effectiveLoginAllowlist].reverse() },
    ],
    ["wrong schema owner", { ...rawPolicy, applicationSchemaOwner: "nutrition_app" }],
    ["wrong function digest", { ...rawPolicy, approvalFunctionSourceSha256: "a".repeat(64) }],
    [
      "wrong stage function digest",
      { ...rawPolicy, stageBatchFunctionSourceSha256: "b".repeat(64) },
    ],
    [
      "wrong validate function digest",
      { ...rawPolicy, validateBatchFunctionSourceSha256: "c".repeat(64) },
    ],
  ])("rejects %s", (_label, candidate) => {
    expect(() => parseCatalogueAuthorityDeploymentPolicy(candidate)).toThrow();
  });

  it("rejects membership, privilege, ACL, session, and structure drift", () => {
    const policy = parseCatalogueAuthorityDeploymentPolicy(rawPolicy);
    const base = validEvidence(policy);
    const dataRole = base.capabilityRoles.find(
      (role) => role.name === "nutrition_catalogue_approve_data",
    );
    if (!dataRole) throw new Error("data role fixture is missing");
    const firstTrigger = base.triggers[0];
    if (!firstTrigger) throw new Error("trigger fixture is missing");
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        capabilityRoles: base.capabilityRoles.map((role) =>
          role === dataRole
            ? {
                ...role,
                incomingMemberships: role.incomingMemberships.map((membership) => ({
                  ...membership,
                  setOption: true,
                })),
              }
            : role,
        ),
      }),
    ).toThrow(/membership options/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        database: { ...base.database, unexpectedClientSessionCount: 1 },
      }),
    ).toThrow(/unexpected database sessions/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        functions: base.functions.map((entry) =>
          entry.name === "catalogue_record_import_approval"
            ? { ...entry, publicExecute: true }
            : entry,
        ),
      }),
    ).toThrow(/ACL representation differs/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        functions: base.functions.map((entry) =>
          entry.name === "catalogue_promote_import_batch"
            ? {
                ...entry,
                acl: entry.acl.map((grant) =>
                  grant.grantee === "nutrition_catalogue_promote_activate"
                    ? { ...grant, grantee: "nutrition_catalogue_rollback" }
                    : grant,
                ),
              }
            : entry,
        ),
      }),
    ).toThrow(/ACL/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        functions: base.functions.map((entry) =>
          entry.name === "catalogue_rollback_source_release"
            ? {
                ...entry,
                acl: entry.acl.filter((grant) => grant.grantee !== "nutrition_catalogue_rollback"),
              }
            : entry,
        ),
      }),
    ).toThrow(/ACL/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        functions: base.functions.map((entry) =>
          entry.name === "guard_food_source_release_activation_authority"
            ? {
                ...entry,
                acl: [
                  ...entry.acl,
                  {
                    grantable: false,
                    grantee: "PUBLIC",
                    grantor: policy.databaseOwner,
                    privilege: "EXECUTE",
                  },
                ],
              }
            : entry,
        ),
      }),
    ).toThrow(/ACL/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        functions: [
          ...base.functions,
          {
            acl: [
              {
                grantable: false,
                grantee: "PUBLIC",
                grantor: policy.databaseOwner,
                privilege: "EXECUTE",
              },
            ],
            aclIsDefault: false,
            arguments: "",
            language: "plpgsql",
            leakproof: false,
            name: "unsafe_extra_function",
            owner: policy.databaseOwner,
            parallel: "u",
            publicExecute: true,
            resultType: "void",
            searchPath: [],
            securityDefiner: true,
            sourceSha256: "0".repeat(64),
            strict: false,
            volatility: "v",
          },
        ],
      }),
    ).toThrow(/Non-authority function/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        logins: base.logins.map((login, index) =>
          index === 0
            ? { ...login, effectiveTablePrivileges: ["food_import_approval:INSERT"] }
            : login,
        ),
      }),
    ).toThrow(/is unsafe/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        columnAcls: [
          {
            columnName: "approval_role",
            grantable: false,
            grantee: policy.reviewerLogins.data,
            grantor: policy.databaseOwner,
            privilege: "INSERT",
            relationName: "food_import_approval",
          },
        ],
      }),
    ).toThrow(/explicit column ACLs/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        explicitColumnAclAttributeCount: 1,
      }),
    ).toThrow(/explicit column ACLs/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        relations: base.relations.map((relation, index) =>
          index === 0 ? { ...relation, owner: "unexpected_owner" } : relation,
        ),
      }),
    ).toThrow(/owner or ACL/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        triggers: base.triggers.map((trigger, index) =>
          index === 0 ? { ...trigger, enabled: "D" } : trigger,
        ),
      }),
    ).toThrow(/trigger .* differs/u);
    const temporaryReplacementEvidence = {
      ...base,
      triggers: base.triggers.map((trigger, index) =>
        index === 0 ? { ...trigger, tableSchema: "pg_temp_3" } : trigger,
      ),
    };
    expect(catalogueAuthorityDeploymentStructureSha256(temporaryReplacementEvidence)).not.toBe(
      catalogueAuthorityDeploymentStructureSha256(base),
    );
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, temporaryReplacementEvidence),
    ).toThrow(/trigger .* differs/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        triggers: [...base.triggers, { ...firstTrigger, tableSchema: "pg_temp_3" }],
      }),
    ).toThrow(/trigger set/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        triggers: [
          ...base.triggers,
          {
            definition:
              "CREATE TRIGGER unsafe_extra BEFORE UPDATE ON food_import_approval FOR EACH ROW EXECUTE FUNCTION unsafe_extra_function()",
            enabled: "O",
            functionArguments: "",
            functionName: "unsafe_extra_function",
            functionSchema: policy.applicationSchema,
            name: "unsafe_extra",
            tableName: "food_import_approval",
            tableSchema: policy.applicationSchema,
          },
        ],
      }),
    ).toThrow(/trigger set/u);
  });

  it.each([
    "food_import_batch_guard_stage_validate_authority",
    "food_import_checkpoint_guard_staging_seal",
    "food_import_checkpoint_set_updated_at",
    "food_import_parser_report_reject_update",
    "food_import_record_guard_staging_seal",
  ])("rejects normalized 0020 trigger drift for %s", (triggerName) => {
    const policy = parseCatalogueAuthorityDeploymentPolicy(rawPolicy);
    const base = validEvidence(policy);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        triggers: base.triggers.map((trigger) =>
          trigger.name === triggerName
            ? { ...trigger, definition: `${trigger.definition} -- drift` }
            : trigger,
        ),
      }),
    ).toThrow(new RegExp(`Catalogue authority trigger ${triggerName} differs from policy`, "u"));
  });

  it.each([
    ["catalogue_stage_import_batch", "nutrition_catalogue_stage"],
    ["catalogue_stage_import_parser_report", "nutrition_catalogue_stage"],
    ["catalogue_stage_import_record_chunk", "nutrition_catalogue_stage"],
    ["catalogue_observe_import_validation", "nutrition_catalogue_validate"],
    ["catalogue_validate_import_batch", "nutrition_catalogue_validate"],
  ] as const)("rejects fixed-purpose execute ACL drift for %s", (functionName, grantee) => {
    const policy = parseCatalogueAuthorityDeploymentPolicy(rawPolicy);
    const base = validEvidence(policy);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        functions: base.functions.map((entry) =>
          entry.name === functionName
            ? { ...entry, acl: entry.acl.filter((grant) => grant.grantee !== grantee) }
            : entry,
        ),
      }),
    ).toThrow(/ACL/u);
  });

  it("pins all authority constraints, frozen columns, and the activation batch index", () => {
    const policy = parseCatalogueAuthorityDeploymentPolicy(rawPolicy);
    for (const expectedConstraint of CATALOGUE_AUTHORITY_CONSTRAINT_POLICY) {
      const base = validEvidence(policy);
      expect(() =>
        assertCatalogueAuthorityDeploymentEvidence(policy, {
          ...base,
          authorityConstraints: base.authorityConstraints.map((constraint) =>
            constraint.name === expectedConstraint.name
              ? { ...constraint, definition: "CHECK (false)" }
              : constraint,
          ),
        }),
      ).toThrow(/constraint differs/u);
    }

    for (const expectedColumn of CATALOGUE_AUTHORITY_FROZEN_COLUMN_POLICY) {
      const base = validEvidence(policy);
      expect(() =>
        assertCatalogueAuthorityDeploymentEvidence(policy, {
          ...base,
          authorityFrozenColumns: base.authorityFrozenColumns.map((column) =>
            column.tableName === expectedColumn.tableName &&
            column.columnName === expectedColumn.columnName
              ? { ...column, defaultExpression: "'unsafe'::text" }
              : column,
          ),
        }),
      ).toThrow(/frozen materialization column differs/u);
    }

    const base = validEvidence(policy);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        authorityIndexes: base.authorityIndexes.map((index) => ({
          ...index,
          predicate: "import_batch_id IS NULL",
        })),
      }),
    ).toThrow(/authority index differs/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        authorityIndexes: base.authorityIndexes.map((index) => ({
          ...index,
          owner: "unexpected_owner",
        })),
      }),
    ).toThrow(/authority index differs/u);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        authorityIndexes: base.authorityIndexes.map((index) => ({
          ...index,
          isPrimary: true,
          keyAttributeCount: 2,
        })),
      }),
    ).toThrow(/authority index differs/u);
  });

  it.each([
    "advance_food_search_projection_revision",
    "catalogue_compute_import_staging_seal",
    "catalogue_observe_import_validation",
    "catalogue_promote_import_batch",
    "catalogue_record_import_approval",
    "catalogue_rollback_source_release",
    "catalogue_stage_import_batch",
    "catalogue_stage_import_parser_report",
    "catalogue_stage_import_record_chunk",
    "catalogue_validate_import_batch",
    "enqueue_food_search_barcode_insert",
    "enqueue_food_search_barcode_update",
    "enqueue_food_search_food_eligibility_change",
    "enqueue_food_search_serving_insert",
    "enqueue_food_search_source_eligibility_change",
    "guard_active_nutrient_vector_size",
    "guard_custom_food_child_insert_v3",
    "guard_custom_food_immutable_evidence_v3",
    "guard_food_import_approval_authority",
    "guard_food_import_batch_stage_validate_authority",
    "guard_food_import_batch_update",
    "guard_food_import_batch_validation_digest",
    "guard_food_import_record_insert_before_staging_seal",
    "guard_food_import_record_update",
    "guard_food_import_stage_checkpoint_before_staging_seal",
    "guard_food_source_release_activation_authority",
    "guard_imported_food_version_child_delete",
    "guard_source_barcode_delete",
    "lock_active_nutrient_registry_before_write",
    "lock_active_nutrient_registry_for_read",
    "reconcile_recipe_components_v2",
    "set_row_updated_at",
    "validate_food_version_child_insert",
  ])("rejects protected authority function body drift for %s", (functionName) => {
    const policy = parseCatalogueAuthorityDeploymentPolicy(rawPolicy);
    const base = validEvidence(policy);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        functions: base.functions.map((entry) =>
          entry.name === functionName ? { ...entry, sourceSha256: "0".repeat(64) } : entry,
        ),
      }),
    ).toThrow(new RegExp(`Catalogue authority function ${functionName} differs from policy`, "u"));
  });

  it.each([
    "advance_food_search_projection_revision",
    "catalogue_compute_import_staging_seal",
    "catalogue_observe_import_validation",
    "catalogue_stage_import_batch",
    "catalogue_stage_import_parser_report",
    "catalogue_stage_import_record_chunk",
    "catalogue_validate_import_batch",
    "enqueue_food_search_barcode_insert",
    "enqueue_food_search_barcode_update",
    "enqueue_food_search_food_eligibility_change",
    "enqueue_food_search_serving_insert",
    "enqueue_food_search_source_eligibility_change",
    "guard_active_nutrient_vector_size",
    "guard_food_import_batch_stage_validate_authority",
    "guard_food_import_record_insert_before_staging_seal",
    "guard_food_import_stage_checkpoint_before_staging_seal",
    "lock_active_nutrient_registry_before_write",
    "lock_active_nutrient_registry_for_read",
    "reconcile_recipe_components_v2",
  ])("rejects hardened authority function search-path drift for %s", (functionName) => {
    const policy = parseCatalogueAuthorityDeploymentPolicy(rawPolicy);
    const base = validEvidence(policy);
    expect(() =>
      assertCatalogueAuthorityDeploymentEvidence(policy, {
        ...base,
        functions: base.functions.map((entry) =>
          entry.name === functionName ? { ...entry, searchPath: [] } : entry,
        ),
      }),
    ).toThrow(new RegExp(`Catalogue authority function ${functionName} differs from policy`, "u"));
  });

  it("requires the exact zero-write canary result set and unchanged state", () => {
    const policy = parseCatalogueAuthorityDeploymentPolicy(rawPolicy);
    const deploymentEvidence = validEvidence(policy);
    const structure = catalogueAuthorityDeploymentStructure(deploymentEvidence);
    const structureSha256 = catalogueAuthorityDeploymentStructureSha256(deploymentEvidence);
    const evidence = {
      afterApprovalRowCount: "0",
      afterStructureSha256: structureSha256,
      beforeApprovalRowCount: "0",
      beforeStructureSha256: structureSha256,
      policySha256: catalogueAuthorityDeploymentPolicySha256(policy),
      results: [
        { canary: "data-matching", sqlstate: "23503" },
        { canary: "quality-matching", sqlstate: "23503" },
        { canary: "rights-matching", sqlstate: "23503" },
        { canary: "data-requesting-quality", sqlstate: "42501" },
        { canary: "api-execute", sqlstate: "42501" },
        { canary: "unassigned-execute", sqlstate: "42501" },
        { canary: "worker-execute", sqlstate: "42501" },
        { canary: "data-direct-dml", sqlstate: "42501" },
      ],
      schemaVersion: 4,
      structure,
    } as const;

    expect(() => assertCatalogueAuthorityCanaryEvidence(policy, evidence)).not.toThrow();
    expect(() =>
      assertCatalogueAuthorityCanaryEvidence(policy, {
        ...evidence,
        afterApprovalRowCount: "1",
      }),
    ).toThrow(/changed protected database state/u);
    expect(() =>
      assertCatalogueAuthorityCanaryEvidence(policy, {
        ...evidence,
        results: evidence.results.map((result) =>
          result.canary === "api-execute"
            ? { canary: "api-execute" as const, sqlstate: "23503" as const }
            : result,
        ),
      }),
    ).toThrow(/did not fail closed/u);
    expect(() =>
      assertCatalogueAuthorityCanaryEvidence(policy, {
        ...evidence,
        results: evidence.results.slice(0, -1),
      }),
    ).toThrow(/result set differs/u);
    expect(() =>
      assertCatalogueAuthorityCanaryEvidence(policy, {
        ...evidence,
        afterStructureSha256: "a".repeat(64),
        beforeStructureSha256: "a".repeat(64),
      }),
    ).toThrow(/digest binding differs/u);
  });

  it("uses a stable, persisted, credential-free deployment structure digest", () => {
    const policy = parseCatalogueAuthorityDeploymentPolicy(rawPolicy);
    const evidence = validEvidence(policy);
    const changedPidsAndOrder = {
      ...evidence,
      database: {
        ...evidence.database,
        verifierSessions: [...evidence.database.verifierSessions]
          .reverse()
          .map((session, index) => ({ ...session, pid: 10_000 + index })),
      },
    };
    const structuralChange = {
      ...evidence,
      applicationSchema: {
        ...evidence.applicationSchema,
        publicCreate: true,
      },
    };
    const structure = catalogueAuthorityDeploymentStructure(evidence);
    const independentlyRecomputedSha256 = createHash("sha256")
      .update(canonicalJson(structure as unknown as JsonValue), "utf8")
      .digest("hex");

    expect(catalogueAuthorityDeploymentStructureSha256(changedPidsAndOrder)).toBe(
      catalogueAuthorityDeploymentStructureSha256(evidence),
    );
    expect(independentlyRecomputedSha256).toBe(
      catalogueAuthorityDeploymentStructureSha256(evidence),
    );
    expect(catalogueAuthorityDeploymentStructureSha256(structuralChange)).not.toBe(
      catalogueAuthorityDeploymentStructureSha256(evidence),
    );
    expect(structure.database.verifierSessions).toEqual(
      [...structure.database.verifierSessions].sort((left, right) =>
        left.applicationName < right.applicationName
          ? -1
          : left.applicationName === right.applicationName
            ? 0
            : 1,
      ),
    );
    expect(structure.database.verifierSessions.every((session) => !("pid" in session))).toBe(true);
    expect(JSON.stringify(structure)).not.toMatch(/password|connectionString|DATABASE_URL/u);
  });
});
