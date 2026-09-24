import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0031_catalogue_paged_publication.sql", import.meta.url),
  "utf8",
);
const predecessor = readFileSync(
  new URL("../migrations/0019_catalogue_promotion_rollback_authority.sql", import.meta.url),
  "utf8",
);
const functions = new Map(
  [
    ...migration.matchAll(
      /^create(?: or replace)? function (\w+)\([\s\S]*?\bas \$\$([\s\S]*?)\$\$;/gmu,
    ),
  ].map((match) => [match[1] as string, match[2] as string]),
);
function body(name: string) {
  const value = functions.get(name);
  expect(value, `missing SQL function ${name}`).toBeDefined();
  return value as string;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("paged publication source authority and compatibility contracts", () => {
  it("attests the precise prior activation guard and preserves its legacy branch", () => {
    const original = predecessor.match(
      /create function guard_food_source_release_activation_authority\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/u,
    )?.[1];
    expect(original).toBeDefined();
    expect(migration).toContain(`'${hash(original as string)}'`);
    const updated = body("guard_food_source_release_activation_authority");
    expect(updated).toContain(
      "batch.status='promoting' and batch.release_id is not distinct from new.release_id",
    );
    expect(updated).toContain(
      "p.phase='sealed' and p.seal_sha256 is not null and p.publisher_principal=session_user::text",
    );
    expect(updated).toContain("new.database_principal is distinct from session_user::text");
    expect(migration).toContain("t.tgtype=7 and t.tgenabled='O' and not t.tgisinternal");
  });

  it("re-pins the replaced activation guard to the migration schema", () => {
    const finalize = migration.slice(migration.lastIndexOf("do $migration$"));
    expect(finalize).toContain(
      "execute format('alter function %I.guard_food_source_release_activation_authority() set search_path=pg_catalog,%I,pg_temp',schema_name,schema_name);",
    );
  });

  it("grants only the eight public capabilities and leaves helpers owner-only", () => {
    const grants = [
      ...migration.matchAll(/grant execute on function %I\.(\w+)\(([^)]*)\) to ([^']+)/gu),
    ].map((match) => [match[1], match[2], match[3]]);
    expect(grants).toEqual([
      ["catalogue_admit_publication_v2", "text", "nutrition_catalogue_approve_quality"],
      ["catalogue_begin_publication_v2", "text", "nutrition_catalogue_promote_activate"],
      ["catalogue_materialize_publication_page_v2", "text", "nutrition_catalogue_promote_activate"],
      ["catalogue_verify_publication_page_v2", "text", "nutrition_catalogue_promote_activate"],
      ["catalogue_finish_publication_v2", "text", "nutrition_catalogue_promote_activate"],
      ["catalogue_activate_publication_v2", "text", "nutrition_catalogue_promote_activate"],
      ["catalogue_rollback_publication_v2", "text", "nutrition_catalogue_rollback"],
      [
        "catalogue_read_publication_v2",
        "uuid",
        "nutrition_catalogue_promote_activate,nutrition_catalogue_rollback",
      ],
    ]);
    expect(migration).toContain("revoke all on function %I.%I(%s) from public");
    expect(migration).toContain("revoke all on table %I.%I from public");
    expect(migration).not.toMatch(/grant\s+(?:all|select|insert|update|delete)\s+on\s+table/iu);
    for (const name of functions.keys()) {
      if (name !== "guard_food_source_release_activation_authority") {
        expect(migration).toContain(`'${name}'`);
      }
    }
  });

  it("retains the original immutable validation and classification state", () => {
    expect(migration).not.toMatch(
      /(?:update|delete\s+from|insert\s+into)\s+(?:food_import_record|food_import_batch|catalogue_validation_context_v2)\b/iu,
    );
    expect(migration).not.toMatch(
      /(?:update|delete\s+from)\s+catalogue_validation_generation_v2\b/iu,
    );
    expect(migration).not.toMatch(/disable\s+trigger|session_replication_role|set\s+role/iu);
    expect(body("catalogue_lock_publication_v2")).toContain(
      "p.last_generation is distinct from epoch",
    );
  });

  it("acquires source and registry locks before the exclusive generation fence", () => {
    const lock = body("catalogue_lock_publication_v2");
    const order = [
      "from food_import_batch where id=p_batch_id for update",
      "from food_source where id=b.food_source_id for update",
      "pg_advisory_xact_lock",
      "lock_active_nutrient_registry_for_read",
      "from catalogue_validation_generation_v2 where singleton for update",
    ].map((token) => lock.indexOf(token));
    expect(order.every((value) => value >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(body("catalogue_publication_timeouts_v2")).toContain(
      "setting::bigint between 1 and 2000",
    );
    expect(body("catalogue_publication_timeouts_v2")).toContain(
      "setting::bigint between 1 and 30000",
    );
    expect(migration).not.toMatch(/set_config\([\s\S]*?(?:statement_timeout|lock_timeout)/u);
  });

  it("keeps current pointers and barcode replacement inside one cutover helper", () => {
    for (const [name, source] of functions) {
      if (name === "catalogue_cutover_publication_v2") continue;
      expect(source, name).not.toMatch(
        /update\s+food\s+(?:as\s+\w+\s+)?set\s+current_version_id/iu,
      );
      expect(source, name).not.toMatch(/update\s+food_source\s+set\s+active_release_id/iu);
      expect(source, name).not.toMatch(/insert\s+into\s+food_barcode\s*\(/iu);
    }
    const cutover = body("catalogue_cutover_publication_v2");
    expect(cutover).toContain("target barcode is active for another source");
    expect(cutover).toContain("'catalogue-activation:'||activation::text");
  });

  it("separates reconciliation context from the original nutrient validation context", () => {
    const approval = body("catalogue_assert_publication_approvals_v2");
    expect(approval).toContain("r.context_sha256 is distinct from p_context");
    expect(approval).not.toContain("c.context_sha256 is distinct from p_context");
    expect(body("catalogue_advance_publication_page_v2")).toContain(
      "array[c.context_sha256,item.sequence_number::text",
    );
  });

  it("independently rechecks materialization, retained pages, and complete coverage", () => {
    const pages = body("catalogue_advance_publication_page_v2");
    expect(pages).toContain("limit 250");
    expect(pages).toContain("total<=16777216");
    expect(pages).toContain("catalogue_verify_publication_record_v2(batch,item.sequence_number)");
    expect(pages).toContain(
      "material_page.request_sha256 is distinct from encode(sha256(convert_to(material_page.request_document,'UTF8')),'hex')",
    );
    expect(pages).toContain("material_page.receipt->>'receiptDocument'");
    expect(pages).toContain("commitment is distinct from material_page.record_commitment_sha256");
    expect(body("catalogue_finish_publication_v2")).toContain(
      "p.record_commitment_sha256<>p.verification_commitment_sha256",
    );
    const historical = body("catalogue_verify_publication_record_v2");
    expect(historical).not.toContain("catalogue_assert_validation_context_v2");
    expect(historical).not.toContain("current_version_id");
    expect(historical).toContain("food_nutrient_value");
    expect(historical).toContain("food_serving");
  });

  it.each(["finish", "activate"])(
    "serializes concurrent exact %s retries before inspecting retained terminal receipts",
    (operation) => {
      const source = body(`catalogue_${operation}_publication_v2`);
      const timeout = source.indexOf("perform catalogue_publication_timeouts_v2();");
      const lock = source.indexOf("perform 1 from food_import_batch where id=batch for update;");
      const read = source.indexOf("select * into strict p from catalogue_publication_v2");
      const receipt = source.indexOf(
        operation === "finish"
          ? "if p.finish_receipt is not null"
          : "if p.activation_receipt is not null",
      );
      const liveContext = source.indexOf("perform catalogue_lock_publication_v2(batch,actor);");
      expect([timeout, lock, read, receipt, liveContext].every((position) => position >= 0)).toBe(
        true,
      );
      expect([timeout, lock, read, receipt, liveContext]).toEqual(
        [timeout, lock, read, receipt, liveContext].sort((left, right) => left - right),
      );
    },
  );

  it("rechecks an exact concurrent rollback receipt after ordered locks before rejecting its old expected head", () => {
    const source = body("catalogue_rollback_publication_v2");
    const locked = source.indexOf(
      "perform 1 from catalogue_validation_generation_v2 where singleton for update;",
    );
    const reject = source.indexOf(
      "if source_row.active_release_id is distinct from expected or target is not distinct from expected then",
    );
    expect(locked).toBeGreaterThan(0);
    expect(reject).toBeGreaterThan(locked);
    const replay = source.slice(locked, reject);
    expect(replay).toContain(
      "select * into prior from catalogue_publication_rollback_v2 where request_id=request_uuid;",
    );
    expect(replay).toContain("prior.actor<>actor or prior.request_document<>p_document");
    expect(replay).toContain(
      "source_row.active_release_id is distinct from prior.target_release_id",
    );
    expect(replay).toContain("is distinct from prior.activation_id");
    expect(replay).toContain("rollback replay differs or has been superseded");
    expect(replay).toContain("return prior.receipt;");
  });

  it("does not reroute V2 rollback through legacy mutation or replay superseded state", () => {
    const rollback = body("catalogue_rollback_publication_v2");
    expect(rollback).not.toMatch(/catalogue_rollback_source_release(?:_v1)?\s*\(/u);
    expect(rollback).toContain("catalogue_verify_legacy_publication_record_v2(item.id,target)");
    expect(rollback).toContain(
      "catalogue_verify_publication_record_v2(target_pub.batch_id,item.sequence_number)",
    );
    expect(rollback).toContain("current_pub.batch_id,charge");
    expect(rollback).toContain("target_pub.batch_id,charge");
    expect(rollback).toContain("rollback replay differs or has been superseded");
    expect(body("catalogue_activate_publication_v2")).toContain(
      "activation retry differs or has been superseded",
    );
  });
});
