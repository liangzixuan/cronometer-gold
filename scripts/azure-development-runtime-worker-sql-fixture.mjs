import assert from "node:assert/strict";

// Exact compiled SQL for the selected empty worker queues. These are raw PG replies, not repositories.
const specs = [
  {
    stage: "search-lock",
    sql: "select pg_try_advisory_lock(hashtext($1)) as acquired",
    values: ["nutrition-tracker:food-search-rebuild:v1"],
    tables: [],
    mutation: null,
  },
  {
    stage: "search-claim",
    sql: "with candidate as ( select event.id from outbox_event as event where event.event_type = $1 and event.aggregate_type = 'food_source' and event.published_at is null and event.dead_lettered_at is null and event.attempt_count < $2 and ($3::text is null or event.aggregate_id = $4) and event.available_at <= clock_timestamp() and ( event.locked_at is null or event.locked_at < clock_timestamp() - make_interval(secs => $5) ) order by event.available_at, event.occurred_at, event.id for update skip locked limit $6 ) update outbox_event as event set locked_at = clock_timestamp(), locked_by = $7 from candidate where event.id = candidate.id returning event.id, event.aggregate_id, event.event_version, event.payload, event.occurred_at, event.attempt_count",
    values: [
      "catalogue.source_release_activated",
      8,
      null,
      null,
      300,
      100,
      "local-food-search-worker",
    ],
    tables: ["outbox_event"],
    mutation: {
      table: "outbox_event",
      right: "UPDATE",
    },
  },
  {
    stage: "search-unlock",
    sql: "select pg_advisory_unlock(hashtext($1)) as released",
    values: ["nutrition-tracker:food-search-rebuild:v1"],
    tables: [],
    mutation: null,
  },
  {
    stage: "exports-expired-upload",
    sql: 'update "privacy_export_upload_artifact" set "cancelled_at" = coalesce(cancelled_at,$1::timestamptz), "status" = $2, "upload_lease_expires_at" = $3 where "status" = $4 and "upload_lease_expires_at" <= $5 and exists (select "retry_job"."id" from "privacy_export_job" as "retry_job" where "retry_job"."id" = "privacy_export_upload_artifact"."job_id" and "retry_job"."status" in ($6, $7) and ("retry_job"."status" = $8 or "retry_job"."locked_at" <= $9))',
    values: [
      "2026-10-18T00:00:00.000Z",
      "cancelled",
      null,
      "uploading",
      "2026-10-18T00:00:00.000Z",
      "failed",
      "running",
      "failed",
      "2026-10-17T23:45:00.000Z",
    ],
    tables: ["privacy_export_job", "privacy_export_upload_artifact"],
    mutation: {
      table: "privacy_export_upload_artifact",
      right: "UPDATE",
    },
  },
  {
    stage: "cancelled-dead-letter",
    sql: 'update "privacy_export_upload_artifact" set "dead_lettered_at" = $1, "last_error_code" = $2, "locked_at" = $3, "locked_by" = $4 where "status" = $5 and "attempt_count" >= $6 and "dead_lettered_at" is null and ("locked_at" is null or "locked_at" <= $7) returning "id"',
    values: [
      "2026-10-18T00:00:00.000Z",
      "STAGED_ARTIFACT_DELETE_ATTEMPTS_EXHAUSTED",
      null,
      null,
      "cancelled",
      20,
      "2026-10-17T23:45:00.000Z",
    ],
    tables: ["privacy_export_upload_artifact"],
    mutation: {
      table: "privacy_export_upload_artifact",
      right: "UPDATE",
    },
  },
  {
    stage: "expired-dead-letter",
    sql: 'update "privacy_export_artifact_deletion" set "dead_lettered_at" = $1, "last_error_code" = $2, "locked_at" = $3, "locked_by" = $4, "status" = $5 where "status" != $6 and "attempt_count" >= $7 and "dead_lettered_at" is null and (("status" in ($8, $9) and "locked_at" is null) or ("status" = $10 and "locked_at" <= $11)) returning "artifact_id"',
    values: [
      "2026-10-18T00:00:00.000Z",
      "ARTIFACT_DELETE_ATTEMPTS_EXHAUSTED",
      null,
      null,
      "failed",
      "completed",
      20,
      "queued",
      "failed",
      "running",
      "2026-10-17T23:45:00.000Z",
    ],
    tables: ["privacy_export_artifact_deletion"],
    mutation: {
      table: "privacy_export_artifact_deletion",
      right: "UPDATE",
    },
  },
  {
    stage: "erasure-dead-letter",
    sql: 'update "account_erasure_job" set "dead_lettered_at" = $1, "last_error_code" = $2, "locked_at" = $3, "locked_by" = $4, "status" = $5 where "status" != $6 and "attempt_count" >= $7 and "dead_lettered_at" is null and (("status" in ($8, $9) and "locked_at" is null) or ("status" = $10 and "locked_at" <= $11)) returning "id"',
    values: [
      "2026-10-18T00:00:00.000Z",
      "ERASURE_FAILED",
      null,
      null,
      "failed",
      "completed",
      20,
      "queued",
      "failed",
      "running",
      "2026-10-17T23:45:00.000Z",
    ],
    tables: ["account_erasure_job"],
    mutation: {
      table: "account_erasure_job",
      right: "UPDATE",
    },
  },
  {
    stage: "dead-letter-claim",
    sql: 'select * from "retention_dead_letter_event" where ("status" = $1 or ("status" = $2 and "locked_at" <= $3)) order by "occurred_at", "id" limit $4 for update skip locked',
    values: ["pending", "processing", "2026-10-17T23:45:00.000Z", 100],
    tables: ["retention_dead_letter_event"],
    mutation: null,
  },
  {
    stage: "exports-pending-upload",
    sql: 'update "privacy_export_upload_artifact" set "cancelled_at" = coalesce(cancelled_at,$1::timestamptz) where "status" = $2 and exists (select "retry_job"."id" from "privacy_export_job" as "retry_job" where "retry_job"."id" = "privacy_export_upload_artifact"."job_id" and "retry_job"."status" in ($3, $4) and ("retry_job"."status" = $5 or "retry_job"."locked_at" <= $6))',
    values: [
      "2026-10-18T00:00:00.000Z",
      "uploading",
      "failed",
      "running",
      "failed",
      "2026-10-17T23:45:00.000Z",
    ],
    tables: ["privacy_export_job", "privacy_export_upload_artifact"],
    mutation: {
      table: "privacy_export_upload_artifact",
      right: "UPDATE",
    },
  },
  {
    stage: "cancelled-claim",
    sql: 'select * from "privacy_export_upload_artifact" where "status" = $1 and "attempt_count" < $2 and "dead_lettered_at" is null and "available_at" <= $3 and ("locked_at" is null or "locked_at" <= $4) order by "staged_at" limit $5 for update skip locked',
    values: ["cancelled", 20, "2026-10-18T00:00:00.000Z", "2026-10-17T23:45:00.000Z", 1],
    tables: ["privacy_export_upload_artifact"],
    mutation: null,
  },
  {
    stage: "expired-claim",
    sql: 'select "deletion"."artifact_id", "deletion"."attempt_count", "artifact"."format", "artifact"."job_id", "artifact"."object_key" from "privacy_export_artifact_deletion" as "deletion" inner join "privacy_export_artifact" as "artifact" on "artifact"."id" = "deletion"."artifact_id" where "deletion"."attempt_count" < $1 and "deletion"."dead_lettered_at" is null and ((deletion.status in (\'queued\',\'failed\') and deletion.available_at <= $2) or (deletion.status = \'running\' and deletion.locked_at <= $3)) order by "deletion"."available_at", "deletion"."artifact_id" limit $4 for update of "deletion" skip locked',
    values: [20, "2026-10-18T00:00:00.000Z", "2026-10-17T23:45:00.000Z", 1],
    tables: ["privacy_export_artifact", "privacy_export_artifact_deletion"],
    mutation: null,
  },
  {
    stage: "erasure-claim",
    sql: 'select * from "account_erasure_job" where "execute_after" <= $1 and "user_id" is not null and "attempt_count" < $2 and "dead_lettered_at" is null and ((status in (\'queued\',\'failed\') and available_at <= $3) or (status = \'running\' and locked_at <= $4)) order by "requested_at" limit $5 for update skip locked',
    values: [
      "2026-10-18T00:00:00.000Z",
      20,
      "2026-10-18T00:00:00.000Z",
      "2026-10-17T23:45:00.000Z",
      1,
    ],
    tables: ["account_erasure_job"],
    mutation: null,
  },
  {
    stage: "exports-staged-upload",
    sql: 'update "privacy_export_upload_artifact" set "available_at" = $1, "cancelled_at" = coalesce(cancelled_at,$2::timestamptz), "locked_at" = $3, "locked_by" = $4, "status" = $5 where "status" in ($6, $7) and exists (select "retry_job"."id" from "privacy_export_job" as "retry_job" where "retry_job"."id" = "privacy_export_upload_artifact"."job_id" and "retry_job"."status" in ($8, $9) and ("retry_job"."status" = $10 or "retry_job"."locked_at" <= $11))',
    values: [
      "2026-10-18T00:00:00.000Z",
      "2026-10-18T00:00:00.000Z",
      null,
      null,
      "cancelled",
      "staged",
      "uploaded",
      "failed",
      "running",
      "failed",
      "2026-10-17T23:45:00.000Z",
    ],
    tables: ["privacy_export_job", "privacy_export_upload_artifact"],
    mutation: {
      table: "privacy_export_upload_artifact",
      right: "UPDATE",
    },
  },
  {
    stage: "exports-dead-letter",
    sql: 'update "privacy_export_job" set "dead_lettered_at" = $1, "failure_code" = $2, "locked_at" = $3, "locked_by" = $4, "status" = $5 where "status" != $6 and "attempt_count" >= $7 and "dead_lettered_at" is null and (("status" in ($8, $9) and "locked_at" is null) or ("status" = $10 and "locked_at" <= $11)) returning "attempt_count", "id"',
    values: [
      "2026-10-18T00:00:00.000Z",
      "EXPORT_FAILED",
      null,
      null,
      "failed",
      "completed",
      20,
      "queued",
      "failed",
      "running",
      "2026-10-17T23:45:00.000Z",
    ],
    tables: ["privacy_export_job"],
    mutation: {
      table: "privacy_export_job",
      right: "UPDATE",
    },
  },
  {
    stage: "exports-record-prune",
    sql: 'delete from "privacy_export_record" where "job_id" in (select "id" from "privacy_export_job" where "dead_lettered_at" is not null)',
    values: [],
    tables: ["privacy_export_job", "privacy_export_record"],
    mutation: {
      table: "privacy_export_record",
      right: "DELETE",
    },
  },
  {
    stage: "exports-entity-prune",
    sql: 'delete from "privacy_export_entity_snapshot" where "job_id" in (select "id" from "privacy_export_job" where "dead_lettered_at" is not null)',
    values: [],
    tables: ["privacy_export_entity_snapshot", "privacy_export_job"],
    mutation: {
      table: "privacy_export_entity_snapshot",
      right: "DELETE",
    },
  },
  {
    stage: "exports-claim",
    sql: 'select * from "privacy_export_job" where "attempt_count" < $1 and "dead_lettered_at" is null and not exists (select "id" from "privacy_export_upload_artifact" where "job_id" = "privacy_export_job"."id" and "status" = $2) and ((status in (\'queued\',\'failed\') and available_at <= $3) or (status = \'running\' and locked_at <= $4)) order by "created_at" limit $5 for update skip locked',
    values: [20, "uploading", "2026-10-18T00:00:00.000Z", "2026-10-17T23:45:00.000Z", 1],
    tables: ["privacy_export_job", "privacy_export_upload_artifact"],
    mutation: null,
  },
];
export const expectedWorkerPoll = [
  "search-lock",
  "search-claim",
  "search-unlock",
  "begin",
  "exports-expired-upload",
  "exports-pending-upload",
  "exports-staged-upload",
  "exports-dead-letter",
  "exports-record-prune",
  "exports-entity-prune",
  "exports-claim",
  "commit",
  "begin",
  "cancelled-dead-letter",
  "cancelled-claim",
  "commit",
  "begin",
  "expired-dead-letter",
  "expired-claim",
  "commit",
  "begin",
  "erasure-dead-letter",
  "erasure-claim",
  "commit",
  "begin",
  "dead-letter-claim",
  "commit",
];
const queues = [
  "outbox_event",
  "privacy_export_upload_artifact",
  "privacy_export_job",
  "privacy_export_record",
  "privacy_export_entity_snapshot",
  "privacy_export_artifact_deletion",
  "privacy_export_artifact",
  "account_erasure_job",
  "retention_dead_letter_event",
];
export function runtimeWorkerSql(state, tables, grants, relationNames) {
  let observations = [],
    lockConnection,
    transactionConnection,
    claimed = [],
    rebuilt = false;
  const normalized = (sql) => sql.replace(/\s+/gu, " ").trim();
  const result = (rows = [], command = "SELECT") => ({ rows, rowCount: rows.length, command });
  const right = (principal, table, permission) =>
    assert(
      grants.get(`${principal}:${table}`)?.has(permission),
      `Missing actual emitted ${table} ${permission} grant`,
    );
  const emptyRetention = () => {
    for (const table of queues.filter((name) => name !== "outbox_event"))
      assert.equal((tables.get(table) ?? []).length, 0, `Queue ${table} must actually be empty`);
  };
  return {
    beginPoll() {
      assert(!state.workerPolling && !lockConnection && !transactionConnection);
      emptyRetention();
      observations = [];
      claimed = [];
      rebuilt = false;
      state.workerPolling = true;
    },
    endPoll() {
      state.workerPolling = false;
      assert(!lockConnection && !transactionConnection);
    },
    observations: () => structuredClone(observations),
    assertComplete() {
      assert(!lockConnection && !transactionConnection);
      const stages = observations.map((row) => row.stage),
        unlock = stages.indexOf("search-unlock");
      if (!rebuilt) assert.deepEqual(stages, expectedWorkerPoll);
      else {
        assert.deepEqual(stages.slice(0, 2), ["search-lock", "search-claim"]);
        assert(
          stages.slice(2, unlock).includes("search-source") &&
            stages.slice(2, unlock).includes("search-ack"),
        );
        assert.deepEqual(stages.slice(unlock + 1), expectedWorkerPoll.slice(3));
        assert(
          claimed.length > 0 &&
            claimed.every(
              (row) =>
                row.published_at instanceof Date &&
                row.locked_at === null &&
                row.locked_by === null,
            ),
        );
      }
      assert(observations.every((row) => row.completed));
      return { rebuilt, claimedIds: claimed.map((row) => row.id) };
    },
    query(sql, values, principal, connectionId) {
      assert(
        state.workerPolling &&
          principal === state.input.database.worker &&
          Number.isSafeInteger(connectionId),
      );
      const text = normalized(sql);
      if (
        [
          "begin",
          "commit",
          "rollback",
          "start transaction isolation level repeatable read read only",
        ].includes(text)
      ) {
        assert.deepEqual(values, []);
        const begin = text === "begin" || text.startsWith("start transaction ");
        if (begin) {
          assert(!transactionConnection && (!lockConnection || lockConnection === connectionId));
          transactionConnection = connectionId;
        } else {
          assert.equal(transactionConnection, connectionId);
          transactionConnection = undefined;
        }
        observations.push({ stage: begin ? "begin" : text, completed: true, connectionId });
        return result([], begin ? "BEGIN" : text.toUpperCase());
      }
      const spec = specs.find((row) => row.sql === text);
      if (!spec) {
        assert.equal(
          lockConnection,
          connectionId,
          "Rebuild SQL must retain the actual search-lock connection",
        );
        const ids = claimed.map((row) => row.id);
        const ack =
          'update "outbox_event" set "last_error" = $1, "locked_at" = $2, "locked_by" = $3, "published_at" = clock_timestamp() where "id" in ($4, $5) and "aggregate_type" = $6 and "event_type" = $7 and "published_at" is null and "dead_lettered_at" is null and "locked_by" = $8 returning "id"';
        if (text === ack) {
          assert.equal(transactionConnection, connectionId);
          assert.equal(ids.length, 2);
          assert.deepEqual(values, [
            null,
            null,
            null,
            ...ids,
            "food_source",
            "catalogue.source_release_activated",
            "local-food-search-worker",
          ]);
          right(principal, "outbox_event", "SELECT");
          right(principal, "outbox_event", "UPDATE");
          const now = new Date();
          assert(
            claimed.every(
              (row) =>
                row.locked_by === values.at(-1) &&
                row.published_at === null &&
                row.dead_lettered_at === null,
            ),
          );
          for (const row of claimed)
            Object.assign(row, {
              last_error: null,
              locked_at: null,
              locked_by: null,
              published_at: now,
            });
          observations.push({ stage: "search-ack", completed: true, connectionId });
          rebuilt = true;
          return result(
            ids.map((id) => ({ id })),
            "UPDATE",
          );
        }
        const sourceRead =
          text.includes("with releases as") ||
          text.startsWith('select * from "promoted_food_search_catalogue_v1"') ||
          text.includes("join food_barcode") ||
          text.includes("join food_serving");
        const revisionRead = text.startsWith('select "current_revision"');
        const revisionWrite = text.startsWith('update "food_search_projection_revision"');
        assert(
          sourceRead || revisionRead || revisionWrite,
          `Unsupported worker rebuild SQL: ${text}`,
        );
        right(
          principal,
          sourceRead ? "promoted_food_search_catalogue_v1" : "food_search_projection_revision",
          "SELECT",
        );
        for (const match of text.matchAll(/\b(?:from|join) "?([a-z_][a-z0-9_]*)"?/gu))
          if (relationNames.has(match[1])) right(principal, match[1], "SELECT");
        if (revisionWrite) {
          assert.equal(transactionConnection, connectionId);
          right(principal, "food_search_projection_revision", "UPDATE");
        }
        observations.push({ stage: "search-source", completed: true, connectionId });
        return undefined; // Existing finite source/publication reply model derives rows from actual seed state.
      }
      assert(values.every((value) => value !== undefined));
      assert.deepEqual(
        JSON.parse(JSON.stringify(values)),
        spec.values,
        `Worker parameters changed for ${spec.stage}`,
      );
      emptyRetention();
      if (spec.stage.startsWith("search-")) {
        assert(!transactionConnection);
        if (spec.stage !== "search-lock") assert.equal(lockConnection, connectionId);
      } else assert.equal(transactionConnection, connectionId);
      for (const table of spec.tables) right(principal, table, "SELECT");
      if (spec.mutation) right(principal, spec.mutation.table, spec.mutation.right);
      const observation = { stage: spec.stage, completed: false, connectionId };
      observations.push(observation);
      if (state.options.workerPollSqlFailure === spec.stage)
        throw new Error("Controlled worker retention SQL failure");
      if (spec.stage === "search-lock") {
        assert(!lockConnection);
        lockConnection = connectionId;
      }
      if (spec.stage === "search-unlock") {
        assert.equal(lockConnection, connectionId);
        lockConnection = undefined;
      }
      let rows = [];
      if (spec.stage === "search-claim") {
        const now = new Date(),
          stale = now.getTime() - values[4] * 1000;
        claimed = (tables.get("outbox_event") ?? [])
          .filter(
            (row) =>
              row.event_type === values[0] &&
              row.aggregate_type === "food_source" &&
              row.published_at === null &&
              row.dead_lettered_at === null &&
              row.attempt_count < values[1] &&
              (values[2] === null || row.aggregate_id === values[3]) &&
              row.available_at <= now &&
              (row.locked_at === null || row.locked_at.getTime() < stale),
          )
          .sort(
            (a, b) =>
              a.available_at - b.available_at ||
              a.occurred_at - b.occurred_at ||
              a.id.localeCompare(b.id),
          )
          .slice(0, values[5]);
        for (const row of claimed) Object.assign(row, { locked_at: now, locked_by: values[6] });
        rows = claimed.map((row) => structuredClone(row));
      }
      observation.completed = true;
      return result(
        spec.stage === "search-lock"
          ? [{ acquired: true }]
          : spec.stage === "search-unlock"
            ? [{ released: true }]
            : rows,
        spec.mutation?.right ?? "SELECT",
      );
    },
  };
}
