import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../packages/contracts/dist/index.js";
export const DEVELOPMENT_RUNTIME_DATABASE_PROFILE = "synthetic-private-custom-food-journey-v1";
/** @type {Readonly<Record<"api"|"worker", readonly (readonly [string,string])[]>>} */
export const DEVELOPMENT_RUNTIME_RELATION_GROUPS = {
  api: [
    [
      "SELECT",
      "app_schema_migration database_restore_attestation nutrient food_source food_source_release food_barcode promoted_food_search_catalogue_v1 food_search_projection_revision diary_entry_revision_source",
    ],
    [
      "SELECT,INSERT,UPDATE",
      "app_user user_password_credential user_profile user_session user_data_watermark diary diary_entry",
    ],
    ["SELECT,INSERT,UPDATE,DELETE", "auth_action_token"],
    ["SELECT,UPDATE", "reauthentication_proof"],
    ["INSERT", "audit_log outbox_event"],
    [
      "SELECT,INSERT",
      "food food_version food_nutrient_value food_serving custom_food custom_food_version custom_food_version_nutrient retention_operation diary_operation diary_entry_revision diary_entry_revision_nutrient",
    ],
  ],
  worker: [
    [
      "SELECT",
      "app_schema_migration database_restore_attestation privacy_export_artifact promoted_food_search_catalogue_v1 food_barcode food_serving",
    ],
    [
      "SELECT,UPDATE",
      "privacy_export_job privacy_export_upload_artifact privacy_export_artifact_deletion account_erasure_job retention_dead_letter_event outbox_event food_search_projection_revision",
    ],
    ["SELECT,DELETE", "privacy_export_record privacy_export_entity_snapshot"],
    ["INSERT", "retention_dead_letter_event"],
  ],
};
/** @type {Readonly<Record<string, readonly string[]>>} */
export const DEVELOPMENT_RUNTIME_COLUMN_UPDATES = {
  food: ["current_version_id"],
  food_version: ["id"],
  custom_food: ["current_revision"],
};

export const DEVELOPMENT_RUNTIME_DATABASE_POLICY_SHA256 = createHash("sha256")
  .update(
    canonicalJson({
      profile: DEVELOPMENT_RUNTIME_DATABASE_PROFILE,
      groups: DEVELOPMENT_RUNTIME_RELATION_GROUPS,
      columns: DEVELOPMENT_RUNTIME_COLUMN_UPDATES,
    }),
  )
  .digest("hex");
export function snapshotDevelopmentRuntimePrincipals(value, owner) {
  if (value === undefined) return undefined;
  assert(
    value && typeof value === "object" && Object.keys(value).sort().join(",") === "api,worker",
  );
  const copy = { api: value.api, worker: value.worker };
  assert(new Set([owner, ...Object.values(copy)]).size === 3);
  for (const name of Object.values(copy))
    assert(
      typeof name === "string" &&
        /^[a-z][a-z0-9_]{0,62}$/u.test(name) &&
        !/^(?:pg_|catalogue_|nutrition_catalogue_)/u.test(name),
    );
  return Object.freeze(copy);
}
const token = (row) => JSON.stringify(row);
/** Check the complete selected delta before passing its base projection to catalogue policy. */
export function projectDevelopmentRuntimeAuthority(evidence, owner, input, explicitRelations) {
  const principals = snapshotDevelopmentRuntimePrincipals(input, owner);
  if (!principals) return evidence;
  const runtime = new Set(Object.values(principals)),
    expected = [],
    actual = [];
  const copy = structuredClone(evidence);
  for (const [role, groups] of Object.entries(DEVELOPMENT_RUNTIME_RELATION_GROUPS)) {
    for (const [rights, names] of groups)
      for (const name of names.split(" ")) {
        assert(
          evidence.relations.some((r) => r.name === name),
          "Missing runtime relation",
        );
        for (const privilege of rights.split(","))
          expected.push(
            token({
              relation: name,
              grantee: principals[role],
              grantor: owner,
              privilege,
              grantable: false,
            }),
          );
      }
  }
  for (const relation of copy.relations) {
    let selected = false;
    relation.acl = relation.acl.filter((row) => {
      if (!runtime.has(row.grantee)) return true;
      assert(Object.keys(row).sort().join(",") === "grantable,grantee,grantor,privilege");
      actual.push(
        token({
          relation: relation.name,
          grantee: row.grantee,
          grantor: row.grantor,
          privilege: row.privilege,
          grantable: row.grantable,
        }),
      );
      selected = true;
      return false;
    });
    if (selected) {
      assert(relation.acl_is_default === false);
      relation.acl_is_default = !explicitRelations.includes(relation.name);
    }
  }
  assert.deepEqual(
    actual.sort(),
    expected.sort(),
    "Runtime relation privileges differ from the maintained profile",
  );
  const expectedColumns = Object.entries(DEVELOPMENT_RUNTIME_COLUMN_UPDATES).flatMap(
    ([relation_name, columns]) =>
      columns.map((column_name) => ({
        relation_name,
        column_name,
        grantee: principals.api,
        grantor: owner,
        privilege: "UPDATE",
        grantable: false,
      })),
  );
  const actualColumns = evidence.columnAcls.map((row) => {
    assert(
      Object.keys(row).sort().join(",") ===
        "column_name,grantable,grantee,grantor,privilege,relation_name",
    );
    return {
      relation_name: row.relation_name,
      column_name: row.column_name,
      grantee: row.grantee,
      grantor: row.grantor,
      privilege: row.privilege,
      grantable: row.grantable,
    };
  });
  assert.deepEqual(
    actualColumns.map(token).sort(),
    expectedColumns.map(token).sort(),
    "Runtime column privileges differ from the maintained profile",
  );
  assert.equal(evidence.explicitColumnAclAttributeCount, String(expectedColumns.length));
  copy.columnAcls = [];
  copy.explicitColumnAclAttributeCount = "0";
  return copy;
}
/** Reapply only reviewed table/column privileges; database CONNECT remains fenced. */
export function developmentRuntimeRestoreGrantsSql(input, owner) {
  const principals = snapshotDevelopmentRuntimePrincipals(input, owner);
  if (!principals) return "";
  const lines = ["BEGIN;"];
  for (const [role, groups] of Object.entries(DEVELOPMENT_RUNTIME_RELATION_GROUPS))
    for (const [rights, names] of groups)
      for (const name of names.split(" "))
        lines.push(`GRANT ${rights} ON TABLE public."${name}" TO "${principals[role]}";`);
  for (const [name, columns] of Object.entries(DEVELOPMENT_RUNTIME_COLUMN_UPDATES))
    lines.push(
      `GRANT UPDATE (${columns.map((c) => `"${c}"`).join(",")}) ON TABLE public."${name}" TO "${principals.api}";`,
    );
  lines.push("COMMIT;");
  return lines.join("\n");
}

// Excludes CONNECT: a source allows runtime traffic; a recovered target stays fenced.
export const DEVELOPMENT_RUNTIME_PRINCIPAL_QUERY = `select coalesce(json_agg(row_to_json(runtime_role) order by runtime_role.name)::text,'[]') from (
select r.rolname as name, r.rolcanlogin as login, r.rolsuper as superuser,
r.rolcreatedb as "createDb", r.rolcreaterole as "createRole", r.rolreplication as replication,
r.rolbypassrls as "bypassRls", r.rolinherit as inherit, r.rolconnlimit as "connectionLimit", r.rolconfig as configuration,
(select count(*)::text from pg_catalog.pg_auth_members m where m.member=r.oid or m.roleid=r.oid) as memberships
from pg_catalog.pg_roles r where r.rolname in ($1,$2)) runtime_role`;
export function validateDevelopmentRuntimePrincipalAttributes(text, input, owner) {
  const principals = snapshotDevelopmentRuntimePrincipals(input, owner),
    rows = JSON.parse(text);
  assert(principals && Array.isArray(rows) && rows.length === 2);
  assert.deepEqual(rows.map((r) => r.name).sort(), Object.values(principals).sort());
  for (const row of rows) {
    assert.deepEqual(
      Object.keys(row).sort(),
      [
        "name",
        "login",
        "superuser",
        "createDb",
        "createRole",
        "replication",
        "bypassRls",
        "inherit",
        "connectionLimit",
        "configuration",
        "memberships",
      ].sort(),
    );
    assert(
      row.login === true &&
        row.superuser === false &&
        row.createDb === false &&
        row.createRole === false &&
        row.replication === false &&
        row.bypassRls === false &&
        row.inherit === false &&
        row.connectionLimit === 16 &&
        row.memberships === "0",
    );
    assert.deepEqual(row.configuration, ["search_path=public"]);
  }
}
