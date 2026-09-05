import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertCatalogueAuthorityCanaryEvidence,
  assertCatalogueAuthorityDeploymentEvidence,
  CATALOGUE_APPROVAL_FUNCTION_SOURCE_SHA256,
  CATALOGUE_APPROVAL_GUARD_SOURCE_SHA256,
  CATALOGUE_AUTHORITY_FUNCTION_POLICY,
  CATALOGUE_AUTHORITY_TRIGGER_POLICY,
  CATALOGUE_CAPABILITY_ROLES,
  CATALOGUE_REVIEWER_CAPABILITIES,
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
  policyKind: "catalogue-authority-deployment",
  reviewerLogins: {
    data: "nutrition_catalogue_data_reviewer",
    quality: "nutrition_catalogue_quality_reviewer",
    rights: "nutrition_catalogue_rights_reviewer",
  },
  schemaVersion: 1,
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
        acl(policy.applicationSchemaOwner, policy.applicationSchemaOwner, "CREATE"),
        acl(policy.applicationSchemaOwner, policy.applicationSchemaOwner, "USAGE"),
      ],
      name: policy.applicationSchema,
      owner: policy.applicationSchemaOwner,
      publicCreate: false,
    },
    authorityConstraints: [
      {
        constraintType: "c",
        definition: "CHECK (database_principal IS NULL AND database_capability_role IS NULL)",
        name: "food_source_release_activation_expand_audit_null_check",
        tableName: "food_source_release_activation",
        validated: true,
      },
    ],
    functions: CATALOGUE_AUTHORITY_FUNCTION_POLICY.map((entry) => {
      const { configuration, ...semantics } = entry;
      const approval = entry.name === "catalogue_record_import_approval";
      const guard = entry.name === "guard_food_import_approval_authority";
      const grantees = approval
        ? [policy.databaseOwner, ...Object.values(CATALOGUE_REVIEWER_CAPABILITIES)]
        : guard
          ? [policy.databaseOwner]
          : ["PUBLIC", policy.databaseOwner];
      return {
        ...semantics,
        acl: grantees.map((grantee) => acl(grantee, policy.databaseOwner, "EXECUTE")),
        aclIsDefault: !approval && !guard,
        owner: policy.databaseOwner,
        publicExecute: !approval && !guard,
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
    schemaVersion: 1,
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
          },
        ],
      }),
    ).toThrow(/trigger set/u);
  });

  it.each(["enqueue_food_search_source_eligibility_change", "set_row_updated_at"])(
    "rejects protected trigger function body drift for %s",
    (functionName) => {
      const policy = parseCatalogueAuthorityDeploymentPolicy(rawPolicy);
      const base = validEvidence(policy);
      expect(() =>
        assertCatalogueAuthorityDeploymentEvidence(policy, {
          ...base,
          functions: base.functions.map((entry) =>
            entry.name === functionName ? { ...entry, sourceSha256: "0".repeat(64) } : entry,
          ),
        }),
      ).toThrow(
        new RegExp(`Catalogue authority function ${functionName} differs from policy`, "u"),
      );
    },
  );

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
      schemaVersion: 1,
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
