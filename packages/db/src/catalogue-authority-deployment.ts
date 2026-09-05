import { createHash } from "node:crypto";

import { canonicalJson } from "./catalogue-validation.js";
import type { JsonValue } from "./types.js";

export const CATALOGUE_CAPABILITY_ROLES = [
  "nutrition_catalogue_stage",
  "nutrition_catalogue_validate",
  "nutrition_catalogue_approve_data",
  "nutrition_catalogue_approve_quality",
  "nutrition_catalogue_approve_rights",
  "nutrition_catalogue_promote_activate",
  "nutrition_catalogue_rollback",
] as const;

export const CATALOGUE_REVIEWER_CAPABILITIES = {
  data: "nutrition_catalogue_approve_data",
  quality: "nutrition_catalogue_approve_quality",
  rights: "nutrition_catalogue_approve_rights",
} as const;

export const CATALOGUE_APPROVAL_FUNCTION_SOURCE_SHA256 =
  "89b10b9f12cee731953c14a80b18fcf5f565eb7a7a80d92be55f1cabdab697ac";
export const CATALOGUE_APPROVAL_GUARD_SOURCE_SHA256 =
  "f96feb298d900165172c56a3fa1e99e91aaca010657155e5a996ee04015fdbbd";

export interface CatalogueAuthorityFunctionPolicy {
  readonly arguments: string;
  readonly configuration: "application-schema" | "none";
  readonly language: "plpgsql" | "sql";
  readonly leakproof: boolean;
  readonly name: string;
  readonly parallel: string;
  readonly resultType: "boolean" | "trigger" | "void";
  readonly securityDefiner: boolean;
  readonly sourceSha256: string;
  readonly strict: boolean;
  readonly volatility: string;
}

const TRIGGER_FUNCTION_POLICY = {
  arguments: "",
  configuration: "application-schema",
  language: "plpgsql",
  leakproof: false,
  parallel: "u",
  resultType: "trigger",
  securityDefiner: false,
  strict: false,
  volatility: "v",
} as const;

export const CATALOGUE_AUTHORITY_FUNCTION_POLICY: readonly CatalogueAuthorityFunctionPolicy[] = [
  {
    arguments: "",
    configuration: "application-schema",
    language: "plpgsql",
    leakproof: false,
    name: "advance_food_search_projection_revision",
    parallel: "u",
    resultType: "void",
    securityDefiner: false,
    sourceSha256: "d1e4a8a27203104c6339f045a31a4dfdd2aee3c78cdd94e06bfd3db2c9ac2108",
    strict: false,
    volatility: "v",
  },
  {
    arguments: "value text, digest text",
    configuration: "application-schema",
    language: "sql",
    leakproof: false,
    name: "catalogue_evidence_bundle_uri_is_valid",
    parallel: "u",
    resultType: "boolean",
    securityDefiner: false,
    sourceSha256: "5403779dc4398446c61d0a27ad8b95d904e2552a5e694496b9e7e8612e0c902e",
    strict: true,
    volatility: "i",
  },
  {
    arguments:
      "p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text",
    configuration: "application-schema",
    language: "plpgsql",
    leakproof: false,
    name: "catalogue_record_import_approval",
    parallel: "u",
    resultType: "boolean",
    securityDefiner: true,
    sourceSha256: CATALOGUE_APPROVAL_FUNCTION_SOURCE_SHA256,
    strict: false,
    volatility: "v",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "enqueue_food_search_source_eligibility_change",
    sourceSha256: "3a88f24e4863d8150db21f93efadd528ea5d7811b5c79c6ff5cd38fdcb93ce87",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_import_approval_authority",
    sourceSha256: CATALOGUE_APPROVAL_GUARD_SOURCE_SHA256,
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_import_batch_initial_state",
    sourceSha256: "2561714155de31151c79f95977156072a66451d1f13f7b5c6e85d13abe9ecb0c",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_import_batch_update",
    sourceSha256: "59dc41d73ec62b554caa721e13a2581a75327688f840cab922fddad0ca7be249",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_import_batch_validation_digest",
    sourceSha256: "511c01c16477a31c2de7639a5b48c65e421167c129dfd83377f9256210288ba2",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_import_record_update",
    sourceSha256: "b111a6db4f4bd43bf2e9183ecf0ee8b19ccda1ed3679c598ef2f73d58d9cb2d9",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_source_active_release_authority",
    sourceSha256: "306eec1771a7bbf7961bd6d46ba752801fe98f07d27fbf96291a1c454750cd11",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_source_initial_active_release",
    sourceSha256: "e3cbc51f28aafd274ea2bc3b71b824d51180d8e741dbcfd22d0af9e21849be43",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_source_release_initial_state",
    sourceSha256: "797445724ddd8d37cdbcc1891c724e9bd8af543548d322db5cf9c3d22ac13b3d",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_source_release_legacy_promotion_grandfather",
    sourceSha256: "22340dfcbb5f98e1d0504703b0fb37830b31a4ecde5cbe81e55844968b86f214",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_food_source_release_update",
    sourceSha256: "191701f20750b6e98b8acf290a1df2417bf17bd9c3a4e5e87a7ac7ef56453726",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "guard_new_food_source_release_authority",
    sourceSha256: "93f189e2c097009ac1cbf1129ce10a24d0c7fd2e4cee66c2ea5cdbb1537462b3",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    name: "reject_new_legacy_unbound_catalogue_evidence",
    sourceSha256: "f972295c68b0774f901ce592801a0c8d25ddf6384194a702ca576844f088b14e",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    configuration: "none",
    name: "reject_immutable_row_update",
    sourceSha256: "631a42e27de6543bc09fd6b8d0f1b0fd336250270b47f13849a2483fd0786e6e",
  },
  {
    ...TRIGGER_FUNCTION_POLICY,
    configuration: "none",
    name: "set_row_updated_at",
    sourceSha256: "92fa7c305a8b856faea0575b27eaa33c1e39952cf9fe87b4c0cbf7d7eab556bd",
  },
];

export const CATALOGUE_AUTHORITY_PROTECTED_TABLES = [
  "food_import_approval",
  "food_import_batch",
  "food_import_record",
  "food_source",
  "food_source_release",
  "food_source_release_activation",
] as const;

export interface CatalogueAuthorityTriggerPolicy {
  readonly definition: string;
  readonly functionName: string;
  readonly name: string;
  readonly tableName: string;
}

export const CATALOGUE_AUTHORITY_TRIGGER_POLICY: readonly CatalogueAuthorityTriggerPolicy[] = [
  {
    definition:
      "CREATE TRIGGER food_import_approval_guard_authority BEFORE INSERT ON food_import_approval FOR EACH ROW EXECUTE FUNCTION guard_food_import_approval_authority()",
    functionName: "guard_food_import_approval_authority",
    name: "food_import_approval_guard_authority",
    tableName: "food_import_approval",
  },
  {
    definition:
      "CREATE TRIGGER food_import_approval_reject_update BEFORE DELETE OR UPDATE ON food_import_approval FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    functionName: "reject_immutable_row_update",
    name: "food_import_approval_reject_update",
    tableName: "food_import_approval",
  },
  {
    definition:
      "CREATE TRIGGER food_import_batch_guard_initial_state BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_initial_state()",
    functionName: "guard_food_import_batch_initial_state",
    name: "food_import_batch_guard_initial_state",
    tableName: "food_import_batch",
  },
  {
    definition:
      "CREATE TRIGGER food_import_batch_guard_update BEFORE DELETE OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_update()",
    functionName: "guard_food_import_batch_update",
    name: "food_import_batch_guard_update",
    tableName: "food_import_batch",
  },
  {
    definition:
      "CREATE TRIGGER food_import_batch_guard_validation_digest BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_validation_digest()",
    functionName: "guard_food_import_batch_validation_digest",
    name: "food_import_batch_guard_validation_digest",
    tableName: "food_import_batch",
  },
  {
    definition:
      "CREATE TRIGGER food_import_batch_reject_new_legacy_unbound BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()",
    functionName: "reject_new_legacy_unbound_catalogue_evidence",
    name: "food_import_batch_reject_new_legacy_unbound",
    tableName: "food_import_batch",
  },
  {
    definition:
      "CREATE TRIGGER food_import_record_guard_update BEFORE UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_update()",
    functionName: "guard_food_import_record_update",
    name: "food_import_record_guard_update",
    tableName: "food_import_record",
  },
  {
    definition:
      "CREATE TRIGGER food_import_record_reject_delete BEFORE DELETE ON food_import_record FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    functionName: "reject_immutable_row_update",
    name: "food_import_record_reject_delete",
    tableName: "food_import_record",
  },
  {
    definition:
      "CREATE TRIGGER food_source_guard_active_release_authority BEFORE UPDATE OF active_release_id ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_active_release_authority()",
    functionName: "guard_food_source_active_release_authority",
    name: "food_source_guard_active_release_authority",
    tableName: "food_source",
  },
  {
    definition:
      "CREATE TRIGGER food_source_guard_initial_active_release BEFORE INSERT ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_initial_active_release()",
    functionName: "guard_food_source_initial_active_release",
    name: "food_source_guard_initial_active_release",
    tableName: "food_source",
  },
  {
    definition:
      "CREATE TRIGGER food_source_search_eligibility_outbox AFTER UPDATE OF active, active_release_id, code, display_name, license_expression, attribution_required, attribution_text, commercial_use_allowed, redistribution_allowed, rights_review_status, rights_reviewed_at, rights_reviewed_by ON food_source FOR EACH ROW EXECUTE FUNCTION enqueue_food_search_source_eligibility_change()",
    functionName: "enqueue_food_search_source_eligibility_change",
    name: "food_source_search_eligibility_outbox",
    tableName: "food_source",
  },
  {
    definition:
      "CREATE TRIGGER food_source_set_updated_at BEFORE UPDATE ON food_source FOR EACH ROW EXECUTE FUNCTION set_row_updated_at()",
    functionName: "set_row_updated_at",
    name: "food_source_set_updated_at",
    tableName: "food_source",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_guard_initial_state BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_initial_state()",
    functionName: "guard_food_source_release_initial_state",
    name: "food_source_release_guard_initial_state",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_guard_legacy_grandfather_insert BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()",
    functionName: "guard_food_source_release_legacy_promotion_grandfather",
    name: "food_source_release_guard_legacy_grandfather_insert",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_guard_legacy_grandfather_update BEFORE UPDATE OF legacy_promotion_grandfathered_at ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()",
    functionName: "guard_food_source_release_legacy_promotion_grandfather",
    name: "food_source_release_guard_legacy_grandfather_update",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_guard_new_authority BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_new_food_source_release_authority()",
    functionName: "guard_new_food_source_release_authority",
    name: "food_source_release_guard_new_authority",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_guard_update BEFORE UPDATE ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_update()",
    functionName: "guard_food_source_release_update",
    name: "food_source_release_guard_update",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_reject_delete BEFORE DELETE ON food_source_release FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    functionName: "reject_immutable_row_update",
    name: "food_source_release_reject_delete",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_reject_new_legacy_unbound BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()",
    functionName: "reject_new_legacy_unbound_catalogue_evidence",
    name: "food_source_release_reject_new_legacy_unbound",
    tableName: "food_source_release",
  },
  {
    definition:
      "CREATE TRIGGER food_source_release_activation_reject_update BEFORE DELETE OR UPDATE ON food_source_release_activation FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_update()",
    functionName: "reject_immutable_row_update",
    name: "food_source_release_activation_reject_update",
    tableName: "food_source_release_activation",
  },
];

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVIEWER_CLASSES = ["data", "quality", "rights"] as const;
const NON_REVIEWER_CLASSES = ["api", "unassigned", "worker"] as const;

export type CatalogueCapabilityRole = (typeof CATALOGUE_CAPABILITY_ROLES)[number];
export type CatalogueReviewerClass = (typeof REVIEWER_CLASSES)[number];
export type CatalogueNonReviewerClass = (typeof NON_REVIEWER_CLASSES)[number];

export interface CatalogueAuthorityDeploymentPolicy {
  readonly applicationSchema: string;
  readonly applicationSchemaOwner: "pg_database_owner";
  readonly approvalFunctionSourceSha256: string;
  readonly approvalGuardSourceSha256: string;
  readonly databaseName: string;
  readonly databaseOwner: string;
  readonly effectiveLoginAllowlist: readonly string[];
  readonly nonReviewerLogins: Readonly<Record<CatalogueNonReviewerClass, string>>;
  readonly policyKind: "catalogue-authority-deployment";
  readonly reviewerLogins: Readonly<Record<CatalogueReviewerClass, string>>;
  readonly schemaVersion: 1;
}

export interface CatalogueRoleMembershipEvidence {
  readonly adminOption: boolean;
  readonly grantor: string;
  readonly inheritOption: boolean;
  readonly member: string;
  readonly role: string;
  readonly setOption: boolean;
}

export interface CatalogueAclEvidence {
  readonly grantable: boolean;
  readonly grantee: string;
  readonly grantor: string;
  readonly privilege: string;
}

export interface CatalogueCapabilityRoleEvidence {
  readonly bypassRls: boolean;
  readonly canCreateDatabase: boolean;
  readonly canCreateRole: boolean;
  readonly canLogin: boolean;
  readonly incomingMemberships: readonly CatalogueRoleMembershipEvidence[];
  readonly name: CatalogueCapabilityRole;
  readonly outgoingMemberships: readonly string[];
  readonly ownedObjectCount: number;
  readonly replication: boolean;
  readonly superuser: boolean;
}

export interface CatalogueLoginEvidence {
  readonly approvalFunctionExecute: boolean;
  readonly bypassRls: boolean;
  readonly canCreateDatabase: boolean;
  readonly canCreateRole: boolean;
  readonly canLogin: boolean;
  readonly effectiveColumnPrivileges: readonly string[];
  readonly effectiveSequencePrivileges: readonly string[];
  readonly effectiveTablePrivileges: readonly string[];
  readonly inherit: boolean;
  readonly memberships: readonly CatalogueRoleMembershipEvidence[];
  readonly name: string;
  readonly ownedObjectCount: number;
  readonly replication: boolean;
  readonly schemaCreate: boolean;
  readonly schemaUsage: boolean;
  readonly superuser: boolean;
}

export interface CatalogueFunctionEvidence {
  readonly acl: readonly CatalogueAclEvidence[];
  readonly aclIsDefault: boolean;
  readonly arguments: string;
  readonly language: string;
  readonly leakproof: boolean;
  readonly name: string;
  readonly owner: string;
  readonly parallel: string;
  readonly publicExecute: boolean;
  readonly resultType: string;
  readonly searchPath: readonly string[];
  readonly securityDefiner: boolean;
  readonly sourceSha256: string;
  readonly strict: boolean;
  readonly volatility: string;
}

export interface CatalogueRelationEvidence {
  readonly acl: readonly CatalogueAclEvidence[];
  readonly aclIsDefault: boolean;
  readonly kind: string;
  readonly name: string;
  readonly owner: string;
}

export interface CatalogueTypeEvidence {
  readonly acl: readonly CatalogueAclEvidence[];
  readonly aclIsDefault: boolean;
  readonly kind: string;
  readonly name: string;
  readonly owner: string;
}

export interface CatalogueDefaultAclEvidence {
  readonly acl: readonly CatalogueAclEvidence[];
  readonly objectType: string;
  readonly owner: string;
  readonly schemaName: string;
}

export interface CatalogueColumnAclEvidence extends CatalogueAclEvidence {
  readonly columnName: string;
  readonly relationName: string;
}

export interface CatalogueTriggerEvidence {
  readonly definition: string;
  readonly enabled: string;
  readonly functionArguments: string;
  readonly functionName: string;
  readonly functionSchema: string;
  readonly name: string;
  readonly tableName: string;
}

export interface CatalogueAuthorityConstraintEvidence {
  readonly constraintType: string;
  readonly definition: string;
  readonly name: string;
  readonly tableName: string;
  readonly validated: boolean;
}

export interface CatalogueAuthorityDeploymentEvidence {
  readonly applicationSchema: {
    readonly acl: readonly CatalogueAclEvidence[];
    readonly name: string;
    readonly owner: string;
    readonly publicCreate: boolean;
  };
  readonly authorityConstraints: readonly CatalogueAuthorityConstraintEvidence[];
  readonly functions: readonly CatalogueFunctionEvidence[];
  readonly triggers: readonly CatalogueTriggerEvidence[];
  readonly capabilityRoles: readonly CatalogueCapabilityRoleEvidence[];
  readonly columnAcls: readonly CatalogueColumnAclEvidence[];
  readonly database: {
    readonly acl: readonly CatalogueAclEvidence[];
    readonly effectiveLoginAllowlist: readonly string[];
    readonly name: string;
    readonly owner: string;
    readonly publicConnect: boolean;
    readonly unexpectedClientSessionCount: number;
    readonly verifierSessions: readonly {
      readonly applicationName: string;
      readonly login: string;
      readonly pid: number;
    }[];
  };
  readonly defaultAcls: readonly CatalogueDefaultAclEvidence[];
  readonly explicitColumnAclAttributeCount: number;
  readonly logins: readonly CatalogueLoginEvidence[];
  readonly memberships: readonly CatalogueRoleMembershipEvidence[];
  readonly nonSystemSchemas: readonly string[];
  readonly policySha256: string;
  readonly relations: readonly CatalogueRelationEvidence[];
  readonly schemaVersion: 1;
  readonly types: readonly CatalogueTypeEvidence[];
}

export interface CatalogueAuthorityStableVerifierSessionEvidence {
  readonly applicationName: string;
  readonly login: string;
}

export type CatalogueAuthorityDeploymentStructureEvidence = Omit<
  CatalogueAuthorityDeploymentEvidence,
  "database"
> & {
  readonly database: Omit<CatalogueAuthorityDeploymentEvidence["database"], "verifierSessions"> & {
    readonly verifierSessions: readonly CatalogueAuthorityStableVerifierSessionEvidence[];
  };
};

export type CatalogueAuthorityCanaryName =
  | "api-execute"
  | "data-direct-dml"
  | "data-matching"
  | "data-requesting-quality"
  | "quality-matching"
  | "rights-matching"
  | "unassigned-execute"
  | "worker-execute";

export interface CatalogueAuthorityCanaryEvidence {
  readonly afterApprovalRowCount: string;
  readonly afterStructureSha256: string;
  readonly beforeApprovalRowCount: string;
  readonly beforeStructureSha256: string;
  readonly policySha256: string;
  readonly results: readonly {
    readonly canary: CatalogueAuthorityCanaryName;
    readonly sqlstate: "23503" | "42501";
  }[];
  readonly schemaVersion: 1;
  readonly structure: CatalogueAuthorityDeploymentStructureEvidence;
}

export function parseCatalogueAuthorityDeploymentPolicy(
  value: unknown,
): CatalogueAuthorityDeploymentPolicy {
  const policy = exactRecord(value, "catalogue authority deployment policy", [
    "applicationSchema",
    "applicationSchemaOwner",
    "approvalFunctionSourceSha256",
    "approvalGuardSourceSha256",
    "databaseName",
    "databaseOwner",
    "effectiveLoginAllowlist",
    "nonReviewerLogins",
    "policyKind",
    "reviewerLogins",
    "schemaVersion",
  ]);
  if (policy.policyKind !== "catalogue-authority-deployment" || policy.schemaVersion !== 1) {
    throw new Error("Catalogue authority deployment policy identity is unsupported");
  }
  if (
    policy.applicationSchema !== "public" ||
    policy.applicationSchemaOwner !== "pg_database_owner"
  ) {
    throw new Error(
      "Catalogue authority DEPLOY-0 requires the canonical public schema owned by pg_database_owner",
    );
  }
  const reviewerLogins = identifierMap(policy.reviewerLogins, REVIEWER_CLASSES, "reviewerLogins");
  const nonReviewerLogins = identifierMap(
    policy.nonReviewerLogins,
    NON_REVIEWER_CLASSES,
    "nonReviewerLogins",
  );
  const databaseOwner = identifier(policy.databaseOwner, "databaseOwner");
  const namedLogins = [
    databaseOwner,
    ...REVIEWER_CLASSES.map((role) => reviewerLogins[role]),
    ...NON_REVIEWER_CLASSES.map((role) => nonReviewerLogins[role]),
  ];
  if (new Set(namedLogins).size !== namedLogins.length) {
    throw new Error("Catalogue authority deployment login identifiers must be distinct");
  }
  const effectiveLoginAllowlist = identifierArray(
    policy.effectiveLoginAllowlist,
    "effectiveLoginAllowlist",
  );
  for (const login of namedLogins) {
    if (!effectiveLoginAllowlist.includes(login)) {
      throw new Error(`effectiveLoginAllowlist is missing required login ${login}`);
    }
  }
  const approvalFunctionSourceSha256 = sha256(
    policy.approvalFunctionSourceSha256,
    "approvalFunctionSourceSha256",
  );
  const approvalGuardSourceSha256 = sha256(
    policy.approvalGuardSourceSha256,
    "approvalGuardSourceSha256",
  );
  if (
    approvalFunctionSourceSha256 !== CATALOGUE_APPROVAL_FUNCTION_SOURCE_SHA256 ||
    approvalGuardSourceSha256 !== CATALOGUE_APPROVAL_GUARD_SOURCE_SHA256
  ) {
    throw new Error("Catalogue authority deployment function digests differ from source policy");
  }
  return {
    applicationSchema: "public",
    applicationSchemaOwner: "pg_database_owner",
    approvalFunctionSourceSha256,
    approvalGuardSourceSha256,
    databaseName: identifier(policy.databaseName, "databaseName"),
    databaseOwner,
    effectiveLoginAllowlist,
    nonReviewerLogins,
    policyKind: "catalogue-authority-deployment",
    reviewerLogins,
    schemaVersion: 1,
  };
}

export function catalogueAuthorityDeploymentPolicySha256(
  policy: CatalogueAuthorityDeploymentPolicy,
): string {
  return digest(policy as unknown as JsonValue);
}

export function catalogueAuthorityDeploymentStructureSha256(
  evidence: CatalogueAuthorityDeploymentEvidence,
): string {
  return digest(catalogueAuthorityDeploymentStructure(evidence) as unknown as JsonValue);
}

export function catalogueAuthorityDeploymentStructure(
  evidence: CatalogueAuthorityDeploymentEvidence,
): CatalogueAuthorityDeploymentStructureEvidence {
  const verifierSessions = evidence.database.verifierSessions
    .map(({ applicationName, login }) => ({ applicationName, login }))
    .sort((left, right) => {
      if (left.applicationName !== right.applicationName) {
        return left.applicationName < right.applicationName ? -1 : 1;
      }
      if (left.login === right.login) return 0;
      return left.login < right.login ? -1 : 1;
    });
  return {
    applicationSchema: evidence.applicationSchema,
    authorityConstraints: evidence.authorityConstraints,
    capabilityRoles: evidence.capabilityRoles,
    columnAcls: evidence.columnAcls,
    database: {
      acl: evidence.database.acl,
      effectiveLoginAllowlist: evidence.database.effectiveLoginAllowlist,
      name: evidence.database.name,
      owner: evidence.database.owner,
      publicConnect: evidence.database.publicConnect,
      unexpectedClientSessionCount: evidence.database.unexpectedClientSessionCount,
      verifierSessions,
    },
    defaultAcls: evidence.defaultAcls,
    explicitColumnAclAttributeCount: evidence.explicitColumnAclAttributeCount,
    functions: evidence.functions,
    logins: evidence.logins,
    memberships: evidence.memberships,
    nonSystemSchemas: evidence.nonSystemSchemas,
    policySha256: evidence.policySha256,
    relations: evidence.relations,
    schemaVersion: evidence.schemaVersion,
    triggers: evidence.triggers,
    types: evidence.types,
  };
}

export function assertCatalogueAuthorityDeploymentEvidence(
  policy: CatalogueAuthorityDeploymentPolicy,
  evidence: CatalogueAuthorityDeploymentEvidence,
): void {
  if (
    evidence.schemaVersion !== 1 ||
    evidence.policySha256 !== catalogueAuthorityDeploymentPolicySha256(policy)
  ) {
    throw new Error("Catalogue authority deployment evidence identity differs");
  }
  if (
    evidence.database.name !== policy.databaseName ||
    evidence.database.owner !== policy.databaseOwner ||
    evidence.database.publicConnect
  ) {
    throw new Error("Catalogue authority database identity or CONNECT policy differs");
  }
  assertExactStrings(
    evidence.database.effectiveLoginAllowlist,
    policy.effectiveLoginAllowlist,
    "effective database login allowlist",
  );
  assertExactAcl(
    evidence.database.acl,
    [
      expectedAcl("PUBLIC", policy.databaseOwner, "TEMPORARY"),
      expectedAcl(policy.databaseOwner, policy.databaseOwner, "CONNECT"),
      expectedAcl(policy.databaseOwner, policy.databaseOwner, "CREATE"),
      expectedAcl(policy.databaseOwner, policy.databaseOwner, "TEMPORARY"),
      ...REVIEWER_CLASSES.map((role) =>
        expectedAcl(policy.reviewerLogins[role], policy.databaseOwner, "CONNECT"),
      ),
      ...NON_REVIEWER_CLASSES.map((role) =>
        expectedAcl(policy.nonReviewerLogins[role], policy.databaseOwner, "CONNECT"),
      ),
    ],
    "database ACL",
  );
  if (evidence.database.unexpectedClientSessionCount !== 0) {
    throw new Error("Catalogue authority deployment has unexpected database sessions");
  }
  assertVerifierSessions(evidence.database.verifierSessions, policy);
  assertExactStrings(
    evidence.nonSystemSchemas,
    [policy.applicationSchema],
    "non-system schema set",
  );
  if (
    evidence.applicationSchema.name !== policy.applicationSchema ||
    evidence.applicationSchema.owner !== policy.applicationSchemaOwner ||
    evidence.applicationSchema.publicCreate
  ) {
    throw new Error("Catalogue authority application schema policy differs");
  }
  assertExactAcl(
    evidence.applicationSchema.acl,
    [
      expectedAcl("PUBLIC", policy.applicationSchemaOwner, "USAGE"),
      ...REVIEWER_CLASSES.map((role) =>
        expectedAcl(CATALOGUE_REVIEWER_CAPABILITIES[role], policy.applicationSchemaOwner, "USAGE"),
      ),
      expectedAcl(policy.applicationSchemaOwner, policy.applicationSchemaOwner, "CREATE"),
      expectedAcl(policy.applicationSchemaOwner, policy.applicationSchemaOwner, "USAGE"),
    ],
    "application schema ACL",
  );

  const expectedMemberships = REVIEWER_CLASSES.map((reviewerClass) => ({
    adminOption: false,
    grantor: policy.databaseOwner,
    inheritOption: true,
    member: policy.reviewerLogins[reviewerClass],
    role: CATALOGUE_REVIEWER_CAPABILITIES[reviewerClass],
    setOption: false,
  }));
  assertExactMembershipGraph(evidence.memberships, expectedMemberships);
  assertCatalogueAuthorityStructure(policy, evidence);

  const roleByName = new Map(evidence.capabilityRoles.map((role) => [role.name, role]));
  if (
    roleByName.size !== CATALOGUE_CAPABILITY_ROLES.length ||
    evidence.capabilityRoles.length !== CATALOGUE_CAPABILITY_ROLES.length
  ) {
    throw new Error("Catalogue capability role set has missing or duplicate entries");
  }
  for (const roleName of CATALOGUE_CAPABILITY_ROLES) {
    const role = roleByName.get(roleName);
    if (
      !role ||
      role.canLogin ||
      role.superuser ||
      role.canCreateDatabase ||
      role.canCreateRole ||
      role.replication ||
      role.bypassRls ||
      role.ownedObjectCount !== 0
    ) {
      throw new Error(`Catalogue capability role ${roleName} is unsafe`);
    }
    if (role.outgoingMemberships.length !== 0) {
      throw new Error(`Catalogue capability role ${roleName} has outgoing membership`);
    }
    const reviewerClass = REVIEWER_CLASSES.find(
      (candidate) => CATALOGUE_REVIEWER_CAPABILITIES[candidate] === roleName,
    );
    assertMemberships(
      role.incomingMemberships,
      roleName,
      reviewerClass ? [policy.reviewerLogins[reviewerClass]] : [],
      policy.databaseOwner,
    );
  }

  const expectedLogins = [
    ...REVIEWER_CLASSES.map((role) => policy.reviewerLogins[role]),
    ...NON_REVIEWER_CLASSES.map((role) => policy.nonReviewerLogins[role]),
  ].sort();
  const loginByName = new Map(evidence.logins.map((login) => [login.name, login]));
  if (
    loginByName.size !== expectedLogins.length ||
    evidence.logins.length !== expectedLogins.length
  ) {
    throw new Error("Catalogue deployment login evidence has missing or duplicate entries");
  }
  for (const loginName of expectedLogins) {
    const login = loginByName.get(loginName);
    if (
      !login?.canLogin ||
      !login.inherit ||
      login.superuser ||
      login.canCreateDatabase ||
      login.canCreateRole ||
      login.replication ||
      login.bypassRls ||
      login.ownedObjectCount !== 0 ||
      login.schemaCreate ||
      !login.schemaUsage ||
      login.effectiveTablePrivileges.length !== 0 ||
      login.effectiveColumnPrivileges.length !== 0 ||
      login.effectiveSequencePrivileges.length !== 0
    ) {
      throw new Error(`Catalogue deployment login ${loginName} is unsafe`);
    }
    const reviewerClass = REVIEWER_CLASSES.find(
      (candidate) => policy.reviewerLogins[candidate] === loginName,
    );
    if (reviewerClass) {
      if (!login.approvalFunctionExecute) {
        throw new Error(`Reviewer login ${loginName} cannot execute its approval function`);
      }
      assertMemberships(
        login.memberships,
        CATALOGUE_REVIEWER_CAPABILITIES[reviewerClass],
        [loginName],
        policy.databaseOwner,
      );
    } else {
      if (login.approvalFunctionExecute) {
        throw new Error(`Non-reviewer login ${loginName} can execute the approval function`);
      }
      if (login.memberships.length !== 0) {
        throw new Error(`Non-reviewer login ${loginName} has a catalogue capability`);
      }
    }
  }
}

export function assertCatalogueAuthorityCanaryEvidence(
  policy: CatalogueAuthorityDeploymentPolicy,
  evidence: CatalogueAuthorityCanaryEvidence,
): void {
  if (
    evidence.schemaVersion !== 1 ||
    evidence.policySha256 !== catalogueAuthorityDeploymentPolicySha256(policy)
  ) {
    throw new Error("Catalogue authority canary evidence identity differs");
  }
  if (
    evidence.beforeStructureSha256 !== evidence.afterStructureSha256 ||
    evidence.beforeApprovalRowCount !== evidence.afterApprovalRowCount
  ) {
    throw new Error("Catalogue authority canaries changed protected database state");
  }
  const persistedStructureSha256 = digest(evidence.structure as unknown as JsonValue);
  if (evidence.beforeStructureSha256 !== persistedStructureSha256) {
    throw new Error("Catalogue authority canary structure digest binding differs");
  }
  assertCatalogueAuthorityDeploymentStructureEvidence(policy, evidence.structure);
  const expected = new Map<CatalogueAuthorityCanaryName, "23503" | "42501">([
    ["data-matching", "23503"],
    ["quality-matching", "23503"],
    ["rights-matching", "23503"],
    ["data-requesting-quality", "42501"],
    ["unassigned-execute", "42501"],
    ["api-execute", "42501"],
    ["worker-execute", "42501"],
    ["data-direct-dml", "42501"],
  ]);
  if (evidence.results.length !== expected.size) {
    throw new Error("Catalogue authority canary result set differs");
  }
  for (const result of evidence.results) {
    if (expected.get(result.canary) !== result.sqlstate) {
      throw new Error(`Catalogue authority canary ${result.canary} did not fail closed`);
    }
    expected.delete(result.canary);
  }
  if (expected.size !== 0) throw new Error("Catalogue authority canary result is missing");
}

function assertCatalogueAuthorityDeploymentStructureEvidence(
  policy: CatalogueAuthorityDeploymentPolicy,
  structure: CatalogueAuthorityDeploymentStructureEvidence,
): void {
  const deploymentEvidence: CatalogueAuthorityDeploymentEvidence = {
    ...structure,
    database: {
      ...structure.database,
      verifierSessions: structure.database.verifierSessions.map((session, index) => ({
        ...session,
        pid: index + 1,
      })),
    },
  };
  assertCatalogueAuthorityDeploymentEvidence(policy, deploymentEvidence);
  if (
    canonicalJson(
      catalogueAuthorityDeploymentStructure(deploymentEvidence) as unknown as JsonValue,
    ) !== canonicalJson(structure as unknown as JsonValue)
  ) {
    throw new Error("Catalogue authority canary structure is not canonical");
  }
}

function assertCatalogueAuthorityStructure(
  policy: CatalogueAuthorityDeploymentPolicy,
  evidence: CatalogueAuthorityDeploymentEvidence,
): void {
  if (
    evidence.authorityConstraints.length !== 1 ||
    canonicalJson(evidence.authorityConstraints[0] as unknown as JsonValue) !==
      canonicalJson({
        constraintType: "c",
        definition: "CHECK (database_principal IS NULL AND database_capability_role IS NULL)",
        name: "food_source_release_activation_expand_audit_null_check",
        tableName: "food_source_release_activation",
        validated: true,
      })
  ) {
    throw new Error("Catalogue activation authority constraint differs from policy");
  }
  if (evidence.defaultAcls.length !== 0) {
    throw new Error("Catalogue authority database has unreviewed default ACLs");
  }
  if (evidence.columnAcls.length !== 0 || evidence.explicitColumnAclAttributeCount !== 0) {
    throw new Error("Catalogue authority database has explicit column ACLs");
  }

  const relationByName = new Map(evidence.relations.map((relation) => [relation.name, relation]));
  if (
    relationByName.size !== evidence.relations.length ||
    !evidence.relations.some((relation) => relation.kind === "S") ||
    !evidence.relations.some((relation) => relation.kind === "r" || relation.kind === "p")
  ) {
    throw new Error("Catalogue authority relation set is malformed");
  }
  for (const [name, kind] of [
    ["food_import_batch", "r"],
    ["food_import_approval", "r"],
    ["food_import_record", "r"],
    ["food_source", "r"],
    ["food_source_release", "r"],
    ["food_source_release_activation", "r"],
    ["food_import_approval_id_seq", "S"],
    ["food_source_release_activation_id_seq", "S"],
  ] as const) {
    if (relationByName.get(name)?.kind !== kind) {
      throw new Error(`Catalogue authority relation ${name} is unavailable`);
    }
  }
  for (const relation of evidence.relations) {
    if (
      relation.owner !== policy.databaseOwner ||
      !relation.aclIsDefault ||
      relation.acl.some(
        (entry) =>
          entry.grantee !== policy.databaseOwner ||
          entry.grantor !== policy.databaseOwner ||
          entry.grantable,
      )
    ) {
      throw new Error(`Catalogue relation ${relation.name} owner or ACL differs from policy`);
    }
  }

  if (
    evidence.types.length === 0 ||
    new Set(evidence.types.map((type) => `${type.name}:${type.kind}`)).size !==
      evidence.types.length
  ) {
    throw new Error("Catalogue authority type set is malformed");
  }
  for (const type of evidence.types) {
    if (
      type.owner !== policy.databaseOwner ||
      !type.aclIsDefault ||
      type.acl.some(
        (entry) =>
          ![policy.databaseOwner, "PUBLIC"].includes(entry.grantee) ||
          entry.grantor !== policy.databaseOwner ||
          entry.privilege !== "USAGE" ||
          entry.grantable,
      )
    ) {
      throw new Error(`Catalogue type ${type.name} owner or ACL differs from policy`);
    }
  }

  const authorityFunctionNames = new Set(
    CATALOGUE_AUTHORITY_FUNCTION_POLICY.map((entry) => entry.name),
  );
  const authorityFunctions = evidence.functions.filter((entry) =>
    authorityFunctionNames.has(entry.name),
  );
  const functionByName = new Map(
    authorityFunctions.map((authorityFunction) => [authorityFunction.name, authorityFunction]),
  );
  if (
    functionByName.size !== CATALOGUE_AUTHORITY_FUNCTION_POLICY.length ||
    authorityFunctions.length !== CATALOGUE_AUTHORITY_FUNCTION_POLICY.length ||
    new Set(evidence.functions.map((entry) => `${entry.name}(${entry.arguments})`)).size !==
      evidence.functions.length
  ) {
    throw new Error("Catalogue authority function set has missing or unexpected overloads");
  }
  for (const actual of evidence.functions) {
    if (actual.owner !== policy.databaseOwner) {
      throw new Error(`Catalogue function ${actual.name} has an unexpected owner`);
    }
    const expected = CATALOGUE_AUTHORITY_FUNCTION_POLICY.find(
      (entry) => entry.name === actual.name,
    );
    if (!expected) {
      if (actual.securityDefiner || !actual.aclIsDefault) {
        throw new Error(`Non-authority function ${actual.name} has unexpected authority`);
      }
      continue;
    }
    const expectedSearchPath =
      expected.configuration === "application-schema"
        ? [`search_path=pg_catalog, ${policy.applicationSchema}, pg_temp`]
        : [];
    if (
      actual.arguments !== expected.arguments ||
      actual.resultType !== expected.resultType ||
      actual.language !== expected.language ||
      actual.volatility !== expected.volatility ||
      actual.strict !== expected.strict ||
      actual.leakproof !== expected.leakproof ||
      actual.parallel !== expected.parallel ||
      actual.securityDefiner !== expected.securityDefiner ||
      actual.sourceSha256 !== expected.sourceSha256 ||
      canonicalJson(actual.searchPath as unknown as JsonValue) !== canonicalJson(expectedSearchPath)
    ) {
      throw new Error(`Catalogue authority function ${expected.name} differs from policy`);
    }
    const hardened =
      expected.name === "catalogue_record_import_approval" ||
      expected.name === "guard_food_import_approval_authority";
    if (actual.aclIsDefault === hardened || actual.publicExecute === hardened) {
      throw new Error(`Catalogue authority function ${expected.name} ACL representation differs`);
    }
    const grantees =
      expected.name === "catalogue_record_import_approval"
        ? [
            policy.databaseOwner,
            ...REVIEWER_CLASSES.map((role) => CATALOGUE_REVIEWER_CAPABILITIES[role]),
          ]
        : expected.name === "guard_food_import_approval_authority"
          ? [policy.databaseOwner]
          : ["PUBLIC", policy.databaseOwner];
    assertExactAcl(
      actual.acl,
      grantees.map((grantee) => expectedAcl(grantee, policy.databaseOwner, "EXECUTE")),
      `${expected.name} ACL`,
    );
  }

  const triggerByName = new Map(evidence.triggers.map((trigger) => [trigger.name, trigger]));
  if (
    triggerByName.size !== CATALOGUE_AUTHORITY_TRIGGER_POLICY.length ||
    evidence.triggers.length !== CATALOGUE_AUTHORITY_TRIGGER_POLICY.length
  ) {
    throw new Error("Catalogue authority trigger set has missing or unexpected entries");
  }
  for (const expected of CATALOGUE_AUTHORITY_TRIGGER_POLICY) {
    const actual = triggerByName.get(expected.name);
    if (
      !actual ||
      actual.tableName !== expected.tableName ||
      actual.functionSchema !== policy.applicationSchema ||
      actual.functionName !== expected.functionName ||
      actual.functionArguments !== "" ||
      actual.enabled !== "O" ||
      actual.definition !== expected.definition
    ) {
      throw new Error(`Catalogue authority trigger ${expected.name} differs from policy`);
    }
  }
}

function assertMemberships(
  actual: readonly CatalogueRoleMembershipEvidence[],
  role: CatalogueCapabilityRole,
  expectedMembers: readonly string[],
  expectedGrantor: string,
): void {
  if (actual.length !== expectedMembers.length) {
    throw new Error(`Catalogue capability ${role} membership differs`);
  }
  const members = actual.map((membership) => {
    if (
      membership.role !== role ||
      membership.grantor !== expectedGrantor ||
      membership.adminOption ||
      !membership.inheritOption ||
      membership.setOption
    ) {
      throw new Error(`Catalogue capability ${role} membership options differ`);
    }
    return membership.member;
  });
  assertExactStrings(members, expectedMembers, `${role} members`);
}

function assertExactMembershipGraph(
  actual: readonly CatalogueRoleMembershipEvidence[],
  expected: readonly CatalogueRoleMembershipEvidence[],
): void {
  const tokens = (memberships: readonly CatalogueRoleMembershipEvidence[]) =>
    memberships.map((membership) => canonicalJson(membership as unknown as JsonValue));
  assertExactStrings(tokens(actual), tokens(expected), "catalogue membership graph");
}

function assertVerifierSessions(
  actual: CatalogueAuthorityDeploymentEvidence["database"]["verifierSessions"],
  policy: CatalogueAuthorityDeploymentPolicy,
): void {
  const expected = [
    { applicationName: "catalogue-authority-deploy-zero-owner", login: policy.databaseOwner },
    ...REVIEWER_CLASSES.map((role) => ({
      applicationName: `catalogue-authority-deploy-zero-${role}`,
      login: policy.reviewerLogins[role],
    })),
    ...NON_REVIEWER_CLASSES.map((role) => ({
      applicationName: `catalogue-authority-deploy-zero-${role}`,
      login: policy.nonReviewerLogins[role],
    })),
  ];
  if (
    actual.length !== expected.length ||
    new Set(actual.map((session) => session.pid)).size !== expected.length ||
    actual.some((session) => !Number.isSafeInteger(session.pid) || session.pid <= 0)
  ) {
    throw new Error("Catalogue authority verifier session set differs");
  }
  assertExactStrings(
    actual.map((session) => `${session.login}:${session.applicationName}`),
    expected.map((session) => `${session.login}:${session.applicationName}`),
    "catalogue authority verifier sessions",
  );
}

function expectedAcl(grantee: string, grantor: string, privilege: string): CatalogueAclEvidence {
  return { grantable: false, grantee, grantor, privilege };
}

function assertExactAcl(
  actual: readonly CatalogueAclEvidence[],
  expected: readonly CatalogueAclEvidence[],
  label: string,
): void {
  const tokens = (entries: readonly CatalogueAclEvidence[]) =>
    entries.map((entry) => canonicalJson(entry as unknown as JsonValue));
  assertExactStrings(tokens(actual), tokens(expected), label);
}

function exactRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  assertExactStrings(Object.keys(record), keys, `${label} fields`);
  return record;
}

function identifierMap<K extends string>(
  value: unknown,
  keys: readonly K[],
  label: string,
): Readonly<Record<K, string>> {
  const record = exactRecord(value, label, keys);
  return Object.fromEntries(
    keys.map((key) => [key, identifier(record[key], `${label}.${key}`)]),
  ) as Readonly<Record<K, string>>;
}

function identifierArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be non-empty`);
  const result = value.map((entry, index) => identifier(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must be unique`);
  const sorted = [...result].sort();
  if (result.some((entry, index) => entry !== sorted[index])) {
    throw new Error(`${label} must be sorted`);
  }
  return result;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value) || value.startsWith("pg_")) {
    throw new Error(`${label} must be a safe PostgreSQL identifier`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertExactStrings(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${label} differs from policy`);
  }
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
