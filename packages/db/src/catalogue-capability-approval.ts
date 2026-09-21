import { type Kysely, sql } from "kysely";
import { CATALOGUE_CAPABILITY_ROLES } from "./catalogue-authority-deployment.js";
import type { Database } from "./types.js";

export type CatalogueApprovalRole = "data" | "quality" | "rights";
export interface SubmitCatalogueApprovalInput {
  readonly batchId: string;
  readonly approvalRole: CatalogueApprovalRole;
  readonly rightsManifestSha256: string;
  readonly validationDigest: string;
  readonly principalId: string;
  readonly approvalReference: string;
}
export interface CatalogueApprovalReceipt {
  readonly approvalRole: CatalogueApprovalRole;
  readonly wasAlreadyApproved: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const PRINCIPAL = /^[a-z][-a-z0-9._:@/]{2,255}$/u;
const INPUT_KEYS = [
  "batchId",
  "approvalRole",
  "rightsManifestSha256",
  "validationDigest",
  "principalId",
  "approvalReference",
];

/**
 * Submit an explicitly reviewed decision through the unchanged SQL authority.
 * This consumer has no owner fallback and never needs direct workflow table access.
 * An uncertain response is retried with the same inputs; SQL rejects divergent replay.
 */
export async function submitCatalogueApproval(
  database: Kysely<Database>,
  input: SubmitCatalogueApprovalInput,
): Promise<CatalogueApprovalReceipt> {
  assertKeys(input, INPUT_KEYS, "Catalogue approval input");
  const request = { ...input };
  if (typeof request.batchId !== "string" || !UUID.test(request.batchId))
    throw new Error("batchId must be a canonical UUID");
  if (!["data", "quality", "rights"].includes(request.approvalRole))
    throw new Error("Approval role must be data, quality, or rights");
  for (const value of [request.rightsManifestSha256, request.validationDigest])
    if (typeof value !== "string" || !SHA.test(value))
      throw new Error("Approval digests must be lowercase SHA-256 values");
  if (
    typeof request.principalId !== "string" ||
    !PRINCIPAL.test(request.principalId) ||
    Buffer.byteLength(request.principalId) > 63
  )
    throw new Error("Approval principal must be a canonical database principal");
  if (
    typeof request.approvalReference !== "string" ||
    request.approvalReference.trim() !== request.approvalReference ||
    request.approvalReference.length === 0 ||
    Buffer.byteLength(request.approvalReference) > 2_048 ||
    [...request.approvalReference].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(
      "Approval reference must be explicit, trimmed, and at most 2048 UTF-8 bytes without controls",
    );

  const authority = await sql<{ result: unknown }>`
    select pg_catalog.jsonb_build_object(
      'databasePrincipal', session_user::text,
      'effectivePrincipal', current_user::text,
      'canLogin', actor.rolcanlogin,
      'privileged', actor.rolsuper or actor.rolcreatedb or actor.rolcreaterole
        or actor.rolreplication or actor.rolbypassrls,
      'ownerMember', pg_catalog.pg_has_role(session_user, target.relowner, 'member'),
      'capabilities', (
        select coalesce(pg_catalog.jsonb_agg(role_name order by role_name), '[]'::jsonb)
        from pg_catalog.unnest(${[...CATALOGUE_CAPABILITY_ROLES]}::text[]) as names(role_name)
        where pg_catalog.pg_has_role(session_user, role_name, 'member')
      )
    ) as result
    from pg_catalog.pg_roles as actor
    join pg_catalog.pg_class as target
      on target.oid = 'public.food_import_batch'::pg_catalog.regclass
    where actor.rolname = session_user
  `.execute(database);
  if (authority.rows.length !== 1)
    throw new Error("Unexpected catalogue reviewer authority result");
  const principal = authority.rows[0]?.result;
  assertKeys(
    principal,
    [
      "databasePrincipal",
      "effectivePrincipal",
      "canLogin",
      "privileged",
      "ownerMember",
      "capabilities",
    ],
    "Catalogue reviewer authority",
  );
  if (
    principal.databasePrincipal !== request.principalId ||
    principal.effectivePrincipal !== principal.databasePrincipal ||
    principal.canLogin !== true ||
    principal.privileged !== false ||
    principal.ownerMember !== false ||
    !Array.isArray(principal.capabilities) ||
    principal.capabilities.length !== 1 ||
    principal.capabilities[0] !== `nutrition_catalogue_approve_${request.approvalRole}`
  )
    throw new Error(
      "Catalogue approval requires the exact non-owner login with only the requested reviewer capability",
    );

  const result = await sql<{ result: unknown }>`
    select public.catalogue_record_import_approval(
      p_batch_id => ${request.batchId}::uuid,
      p_requested_approval_role => ${request.approvalRole}::text,
      p_validation_digest => ${request.validationDigest}::text,
      p_rights_digest => ${request.rightsManifestSha256}::text,
      p_external_principal_id => ${request.principalId}::text,
      p_approval_reference => ${request.approvalReference}::text
    ) as result
  `.execute(database);
  if (result.rows.length !== 1 || typeof result.rows[0]?.result !== "boolean")
    throw new Error("Unexpected catalogue approval receipt; retain the exact request for retry");
  return { approvalRole: request.approvalRole, wasAlreadyApproved: !result.rows[0].result };
}

function assertKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")
  )
    throw new Error(`${label} has missing or unexpected fields`);
}
