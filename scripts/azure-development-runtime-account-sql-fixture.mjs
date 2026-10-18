import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Finite raw-PG replies for the maintained account journey. No repository/service replacement.
export function runtimeAccountSql(state, tables) {
  const allowed = new Set([
    "app_user",
    "user_profile",
    "user_password_credential",
    "user_session",
    "auth_action_token",
    "reauthentication_proof",
    "audit_log",
    "user_data_watermark",
    "nutrient",
    "retention_operation",
    "food",
    "food_version",
    "food_nutrient_value",
    "food_serving",
    "custom_food",
    "custom_food_version",
    "custom_food_version_nutrient",
    "food_source",
    "diary",
    "diary_entry",
    "diary_entry_revision",
    "diary_entry_revision_nutrient",
    "diary_operation",
  ]);
  const rows = (name) => tables.get(name) ?? [];
  const authorize = (table, right, columns = []) => {
    assert(allowed.has(table));
    const key = `${state.input.database.api}:${table}`;
    assert(
      state.sql.grants.get(key)?.has(right) ||
        (right === "UPDATE" &&
          columns.length > 0 &&
          columns.every((name) => state.sql.columnGrants.get(key)?.includes(name))),
      `Missing actual emitted ${table} ${right} grant`,
    );
  };
  const bump = (table, row) => {
    if (!["user_profile", "custom_food", "diary"].includes(table)) return;
    assert(rows("app_user").some((u) => u.id === row.user_id));
    const current = rows("user_data_watermark");
    let watermark = current.find((w) => w.user_id === row.user_id);
    if (!watermark) {
      watermark = { user_id: row.user_id, revision: "0", updated_at: new Date() };
      current.push(watermark);
      tables.set("user_data_watermark", current);
    }
    watermark.revision = String(BigInt(watermark.revision) + 1n);
    watermark.updated_at = new Date();
  };
  const result = (values = [], count = values.length, command = "SELECT") => ({
    rows: values,
    rowCount: count,
    command,
  });
  const value = (binding, token) => {
    const match = /^(?:"([a-z_][a-z0-9_]*)"\.)?"([a-z_][a-z0-9_]*)"$/u.exec(token);
    assert(match, `Unexpected account SQL column ${token}`);
    const row = binding[match[1] ?? "row"];
    if (row === null) return null;
    assert(row && Object.hasOwn(row, match[2]), `Unknown account SQL column ${token}`);
    return row[match[2]];
  };
  const where = (binding, clause, parameters) => {
    const tests = clause
      .replace(/ for (?:update(?: of "(?:account|user)")?|share)$/u, "")
      .split(" and ");
    return tests
      .map((term) => {
        const list =
          /^((?:"[a-z_][a-z0-9_]*"\.)?"[a-z_][a-z0-9_]*") in \((\$[1-9][0-9]*(?:, \$[1-9][0-9]*)*)\)$/u.exec(
            term,
          );
        if (list)
          return list[2]
            .split(", ")
            .map((token) => parameters[Number(token.slice(1)) - 1])
            .includes(value(binding, list[1]));
        const match =
          /^((?:"[a-z_][a-z0-9_]*"\.)?"[a-z_][a-z0-9_]*") (=|!=|>|<=|is not|is) (\$[1-9][0-9]*|null)$/u.exec(
            term,
          );
        assert(match, `Unexpected account SQL predicate ${term}`);
        const left = value(binding, match[1]),
          right = match[3] === "null" ? null : parameters[Number(match[3].slice(1)) - 1];
        assert(right !== undefined);
        if (match[2] === "=" || match[2] === "is") return left === right;
        if (["is not", "!="].includes(match[2])) return left !== right;
        if (match[2] === ">") return new Date(left).getTime() > new Date(right).getTime();
        return new Date(left).getTime() <= new Date(right).getTime();
      })
      .every(Boolean);
  };
  const project = (binding, fields) =>
    fields === "*"
      ? structuredClone(binding.row)
      : Object.fromEntries(
          fields
            .replace(
              "to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')",
              "to_char(updated_at at time zone 'UTC'|'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')",
            )
            .split(", ")
            .map((field) => {
              const match = /^(.+?)(?: as "([A-Za-z_][A-Za-z0-9_]*)")?$/u.exec(field),
                token = match[1];
              if (match[2] && ["100", "'g'", "null"].includes(token))
                return [match[2], token === "null" ? null : token === "100" ? "100" : "g"];
              if (token.startsWith("to_char(updated_at at time zone")) {
                assert.equal(match[2], "updated_at_microseconds");
                return [
                  match[2],
                  binding.row.updated_at.toISOString().replace(/\.([0-9]{3})Z$/u, ".$1000Z"),
                ];
              }
              const key = match[2] ?? /"([a-z_][a-z0-9_]*)"$/u.exec(token)?.[1];
              assert(key);
              return [key, value(binding, token)];
            }),
        );
  const changes = (assignments, parameters, row = {}) =>
    Object.fromEntries(
      assignments.split(", ").map((item) => {
        if (item === '"revision" = revision + 1')
          return ["revision", String(BigInt(row.revision ?? "0") + 1n)];
        const m = /^"([a-z_][a-z0-9_]*)" = (\$[1-9][0-9]*|clock_timestamp\(\))$/u.exec(item);
        assert(m, `Unexpected account assignment ${item}`);
        return [
          m[1],
          m[2] === "clock_timestamp()" ? new Date() : parameters[Number(m[2].slice(1)) - 1],
        ];
      }),
    );
  const normalize = (row) => {
    for (const [name, v] of Object.entries(row)) {
      if (name.endsWith("_at") && typeof v === "string") row[name] = new Date(v);
      if (
        [
          "password_parameters",
          "preferences",
          "after_state",
          "before_state",
          "context",
          "attributes",
          "metadata",
          "result_payload",
          "unknown_reasons",
          "recipe_calculation_assumptions",
          "recipe_warnings",
        ].includes(name) &&
        typeof v === "string"
      )
        row[name] = JSON.parse(v);
    }
    return row;
  };
  const defaults = (name) => {
    const now = new Date();
    const common = { created_at: now, updated_at: now };
    if (["food", "food_version", "food_serving", "food_nutrient_value"].includes(name))
      return {
        ...common,
        id: String(
          rows(name).reduce((max, row) => (BigInt(row.id) > max ? BigInt(row.id) : max), 0n) + 1n,
        ),
      };
    if (name === "diary")
      return { ...common, id: randomUUID(), revision: "0", status: "open", note: null };
    if (name === "diary_entry_revision")
      return {
        ...common,
        recipe_id: null,
        recipe_name: null,
        recipe_version_number: null,
        recipe_yield_grams: null,
        recipe_yield_source: null,
        recipe_serving_count: null,
        recipe_serving_label: null,
        recipe_calculation_version: null,
        recipe_retention_policy_code: null,
        recipe_retention_policy_version: null,
        recipe_calculation_assumptions: null,
        recipe_warnings: null,
      };
    if (name === "custom_food") return { ...common, status: "active", deleted_at: null };
    if (name === "app_user")
      return {
        ...common,
        status: "active",
        email_verified_at: null,
        deleted_at: null,
        deletion_requested_at: null,
      };
    if (name === "user_profile")
      return {
        ...common,
        revision: "0",
        display_name: null,
        birth_date: null,
        sex_at_birth: "not_specified",
        height_cm: null,
        baseline_weight_kg: null,
        activity_level_code: null,
        locale: "en-US",
        time_zone: "UTC",
        unit_system: "metric",
        preferences: {},
        onboarding_completed_at: null,
        wellness_disclaimer_acknowledged_at: null,
      };
    if (name === "user_session")
      return { ...common, id: randomUUID(), last_used_at: now, revoked_at: null };
    if (name === "auth_action_token" || name === "audit_log")
      return { ...common, id: randomUUID() };
    return common;
  };
  return (sql, parameters) => {
    if (/^\s*select to_char\(/u.test(sql)) {
      assert(sql.includes("greatest(clock_timestamp(), $1::timestamptz)"));
      return result([
        {
          completed_at: new Date(
            Math.max(Date.now(), new Date(parameters[0]).getTime()),
          ).toISOString(),
        },
      ]);
    }
    const insert = /^insert into "([a-z_][a-z0-9_]*)" \(([^)]+)\) values \(([^)]+)\)(.*)$/u.exec(
      sql,
    );
    if (insert && allowed.has(insert[1])) {
      const [, table, columns, firstTokens] = insert;
      let tail = insert[4];
      authorize(table, "INSERT");
      const names = columns.split(", ").map((c) => {
        assert(/^"[a-z_][a-z0-9_]*"$/u.test(c));
        return c.slice(1, -1);
      });
      const tuples = [firstTokens];
      while (tail.startsWith(", (")) {
        const match = /^, \(([^)]+)\)(.*)$/u.exec(tail);
        assert(match);
        tuples.push(match[1]);
        tail = match[2];
      }
      const records = tuples.map((tokens) => {
        const vals = tokens.split(", ");
        assert.equal(names.length, vals.length);
        return normalize(
          Object.fromEntries(
            names.map((name, i) => {
              assert(/^\$[1-9][0-9]*$/u.test(vals[i]));
              return [name, parameters[Number(vals[i].slice(1)) - 1]];
            }),
          ),
        );
      });
      const values = rows(table),
        returning = / returning (.+)$/u.exec(tail)?.[1];
      if (tail === ' on conflict ("user_id", "local_date") do nothing') {
        assert.equal(table, "diary");
        assert.equal(records.length, 1);
        if (
          values.some(
            (r) => r.user_id === records[0].user_id && r.local_date === records[0].local_date,
          )
        )
          return result([], 0, "INSERT");
        tail = "";
      }
      const conflict = /^ on conflict \("user_id", "purpose"\) do update set (.+)$/u.exec(tail);
      if (conflict) {
        assert.equal(table, "auth_action_token");
        authorize(table, "UPDATE");
        assert.equal(records.length, 1);
        const record = records[0],
          prior = values.find((r) => r.user_id === record.user_id && r.purpose === record.purpose);
        if (prior) {
          Object.assign(prior, normalize(changes(conflict[1], parameters)));
          return result([], 1, "INSERT");
        }
      } else
        assert(
          tail === "" || tail === ` returning ${returning}`,
          `Unexpected account INSERT tail ${tail}`,
        );
      const inserted = [];
      for (const record of records) {
        const row = { ...defaults(table), ...record };
        const keys = ["user_profile", "user_password_credential", "user_data_watermark"].includes(
          table,
        )
          ? ["user_id"]
          : ["retention_operation", "diary_operation"].includes(table)
            ? ["user_id", "client_operation_id"]
            : table === "custom_food_version"
              ? ["food_version_id"]
              : table === "custom_food_version_nutrient"
                ? ["food_version_id", "nutrient_id"]
                : table === "diary_entry_revision_nutrient"
                  ? ["diary_entry_revision_id", "nutrient_id"]
                  : ["id"];
        assert(
          !values.some(
            (r) =>
              keys.every((key) => r[key] === row[key]) ||
              (table === "app_user" && r.email === row.email),
          ),
        );
        values.push(row);
        tables.set(table, values);
        bump(table, row);
        inserted.push(row);
      }
      return result(
        returning ? inserted.map((row) => project({ row }, returning)) : [],
        inserted.length,
        "INSERT",
      );
    }
    const update = /^update "([a-z_][a-z0-9_]*)" set (.+) where (.+)$/u.exec(sql);
    if (update && allowed.has(update[1])) {
      const [, table, sets, tail] = update;
      const returning = / returning (.+)$/u.exec(tail)?.[1],
        filter = returning ? tail.slice(0, tail.indexOf(" returning ")) : tail;
      const patch = normalize(changes(sets, parameters));
      authorize(table, "UPDATE", Object.keys(patch));
      const matched = rows(table).filter((row) => where({ row }, filter, parameters));
      for (const row of matched) {
        Object.assign(row, normalize(changes(sets, parameters, row)));
        if (Object.hasOwn(row, "updated_at")) row.updated_at = new Date();
        bump(table, row);
      }
      return result(
        returning ? matched.map((row) => project({ row }, returning)) : [],
        matched.length,
        "UPDATE",
      );
    }
    const deletion = /^delete from "([a-z_][a-z0-9_]*)" where (.+)$/u.exec(sql);
    if (deletion && allowed.has(deletion[1])) {
      const [, table, filter] = deletion;
      authorize(table, "DELETE");
      const original = rows(table),
        kept = original.filter((row) => !where({ row }, filter, parameters));
      tables.set(table, kept);
      return result([], original.length - kept.length, "DELETE");
    }
    const select = /^select (.+) from (.+) where (.+)$/u.exec(sql);
    if (!select) return undefined;
    const [, fields, from, filter] = select;
    const cleanFilter = filter.replace(/ for (?:update(?: of "[a-z_]+")?|share)$/u, "");
    const limitToken = / limit \$([1-9][0-9]*)$/u.exec(cleanFilter)?.[1];
    const limitedFilter = limitToken
      ? cleanFilter.slice(0, cleanFilter.lastIndexOf(" limit "))
      : cleanFilter;
    const order = / order by (.+)$/u.exec(limitedFilter)?.[1];
    const predicate = order
      ? limitedFilter.slice(0, limitedFilter.indexOf(" order by "))
      : limitedFilter;
    const base = /^"([a-z_][a-z0-9_]*)"(?: as "([a-z_][a-z0-9_]*)")?/u.exec(from);
    if (!base || !allowed.has(base[1])) return undefined;
    authorize(base[1], "SELECT");
    let bindings = rows(base[1]).map((row) => ({
      [base[2] ?? "row"]: row,
      ...(base[2] ? {} : { [base[1]]: row }),
    }));
    let tail = from.slice(base[0].length),
      joined = 0;
    while (tail) {
      const join =
        /^ (inner|left) join "([a-z_][a-z0-9_]*)"(?: as "([a-z_][a-z0-9_]*)")? on ((?:"[a-z_][a-z0-9_]*"\.)"[a-z_][a-z0-9_]*") = ((?:"[a-z_][a-z0-9_]*"\.)"[a-z_][a-z0-9_]*")/u.exec(
          tail,
        );
      if (!join) return undefined;
      assert(++joined <= 3);
      const [, kind, table, alias, left, right] = join,
        bindingName = alias ?? table;
      authorize(table, "SELECT");
      bindings = bindings.flatMap((binding) => {
        const matches = rows(table)
          .map((row) => ({ ...binding, [bindingName]: row }))
          .filter((candidate) => value(candidate, left) === value(candidate, right));
        return matches.length || kind === "inner" ? matches : [{ ...binding, [bindingName]: null }];
      });
      tail = tail.slice(join[0].length);
    }
    if (fields.startsWith('created_at > $1::timestamptz as "created_after_completion"')) {
      assert.equal(from, '"auth_action_token"');
      return result(
        bindings
          .filter((r) => where(r, filter, parameters))
          .map(({ row }) => ({
            created_after_completion: row.created_at > new Date(parameters[0]),
            expired: row.expires_at <= new Date(parameters[1]),
          })),
      );
    }
    let selected = bindings.filter((binding) => where(binding, predicate, parameters));
    if (order) {
      const tokens = order.split(", ");
      const mealOrder =
        "case revision.meal_slot when 'breakfast' then 0 when 'lunch' then 1 when 'dinner' then 2 when 'snacks' then 3 end";
      assert(
        tokens.every(
          (token) =>
            token === mealOrder ||
            /^(?:"[a-z_][a-z0-9_]*"\.)?"[a-z_][a-z0-9_]*"(?: asc)?$/u.test(token),
        ),
      );
      const orderedValue = (binding, token) => {
        if (token !== mealOrder) return value(binding, token.replace(/ asc$/u, ""));
        const rank = ["breakfast", "lunch", "dinner", "snacks"].indexOf(
          value(binding, '"revision"."meal_slot"'),
        );
        assert(rank >= 0);
        return rank;
      };
      selected = selected.sort((a, b) => {
        for (const token of tokens) {
          const left = orderedValue(a, token),
            right = orderedValue(b, token);
          if (left !== right)
            return typeof left === "string" && /^[0-9]+$/u.test(left)
              ? BigInt(left) < BigInt(right)
                ? -1
                : 1
              : left < right
                ? -1
                : 1;
        }
        return 0;
      });
    }
    if (fields === 'count(*) as "count"') return result([{ count: String(selected.length) }]);
    let projected = selected.map((binding) => project(binding, fields.replace(/^distinct /u, "")));
    if (fields.startsWith("distinct "))
      projected = [...new Map(projected.map((r) => [JSON.stringify(r), r])).values()];
    if (limitToken) projected = projected.slice(0, parameters[Number(limitToken) - 1]);
    return result(projected);
  };
}
