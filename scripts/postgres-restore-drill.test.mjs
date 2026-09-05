import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProtectedDumpDestination,
  assertRegularDumpArtifact,
  assertRestoreAuthorityPolicyDigest,
  canonicalizeRestoreAuthorityEvidence,
  compareRestoreEvidence,
  parseRestoreDrillArguments,
  RESTORE_AUTHORITY_POLICY_SHA256,
  removeDumpArtifact,
  runPostgresRestoreDrill,
  validateDumpArtifactAttestation,
  validateRestoreAuthorityEvidence,
  validateTargetDatabaseBoundary,
} from "./postgres-restore-drill.mjs";

const capabilityRoles = [
  "nutrition_catalogue_stage",
  "nutrition_catalogue_validate",
  "nutrition_catalogue_approve_data",
  "nutrition_catalogue_approve_quality",
  "nutrition_catalogue_approve_rights",
  "nutrition_catalogue_promote_activate",
  "nutrition_catalogue_rollback",
];
const expectedOwner = "nutrition_owner";

test("accepts only an explicit isolated restore target and owner", () => {
  assert.deepEqual(
    parseRestoreDrillArguments([
      "--container",
      "postgres-test-1",
      "--connect-allowlist",
      expectedOwner,
      "--dump-directory",
      "/dev/shm",
      "--dump-protection",
      "tmpfs",
      "--expected-owner",
      expectedOwner,
      "--source-db",
      "nutrition_source",
      "--target-db",
      "nutrition_restore_ci_20260816",
      "--user",
      "nutrition",
    ]),
    {
      connectAllowlist: [expectedOwner],
      container: "postgres-test-1",
      dumpDirectory: "/dev/shm",
      dumpProtection: "tmpfs",
      expectedOwner,
      sourceDatabase: "nutrition_source",
      targetDatabase: "nutrition_restore_ci_20260816",
      user: "nutrition",
    },
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--connect-allowlist",
        expectedOwner,
        "--dump-directory",
        "/dev/shm",
        "--dump-protection",
        "tmpfs",
        "--expected-owner",
        expectedOwner,
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_source",
      ]),
    /Restore target/,
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--connect-allowlist",
        expectedOwner,
        "--dump-directory",
        "/dev/shm",
        "--dump-protection",
        "tmpfs",
        "--expected-owner",
        expectedOwner,
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_restore_ci;drop_database",
      ]),
    /bounded/,
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--connect-allowlist",
        expectedOwner,
        "--dump-directory",
        "/tmp",
        "--dump-protection",
        "tmpfs",
        "--expected-owner",
        expectedOwner,
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_restore_ci_20260816",
      ]),
    /protected absolute directory/,
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--connect-allowlist",
        expectedOwner,
        "--dump-directory",
        "/approved/backup",
        "--dump-protection",
        "unverified",
        "--expected-owner",
        expectedOwner,
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_restore_ci_20260816",
      ]),
    /tmpfs or encrypted_volume/,
  );
  assert.throws(
    () =>
      parseRestoreDrillArguments([
        "--container",
        "postgres-test-1",
        "--connect-allowlist",
        expectedOwner,
        "--dump-directory",
        "/dev/shm",
        "--dump-protection",
        "tmpfs",
        "--expected-owner",
        "unsafe-owner;set-role",
        "--source-db",
        "nutrition_source",
        "--target-db",
        "nutrition_restore_ci_20260816",
      ]),
    /expected PostgreSQL owner/,
  );
});

test("requires exact migration, constraint, table, row-count, policy, and authority evidence", () => {
  const fingerprint = canonicalizeRestoreAuthorityEvidence(validAuthorityEvidence());
  const source = {
    authorityFingerprint: fingerprint,
    authorityPolicySha256: RESTORE_AUTHORITY_POLICY_SHA256,
    migrationLedger: '[{"name":"0001.sql","checksum":"abc"}]',
    tableCounts: new Map([
      ["app_user", "2"],
      ["diary", "4"],
    ]),
    unvalidatedConstraints: "0",
  };
  compareRestoreEvidence(source, {
    ...source,
    tableCounts: new Map(source.tableCounts),
  });
  assert.throws(
    () => compareRestoreEvidence(source, { ...source, authorityFingerprint: `${fingerprint}x` }),
    /fingerprint/,
  );
  assert.throws(
    () => compareRestoreEvidence(source, { ...source, authorityPolicySha256: "0".repeat(64) }),
    /policy digest/,
  );
  assert.throws(
    () =>
      compareRestoreEvidence(source, {
        ...source,
        tableCounts: new Map([
          ["app_user", "2"],
          ["diary", "3"],
        ]),
      }),
    /diary/,
  );
  assert.throws(
    () => compareRestoreEvidence(source, { ...source, unvalidatedConstraints: "1" }),
    /unvalidated/,
  );
});

test("rejects PUBLIC execute and wrong reviewer grants", () => {
  const publicExecute = validAuthorityEvidence();
  authorityFunction(publicExecute).acl.push({
    grantee: "PUBLIC",
    grantor: expectedOwner,
    grantable: false,
    privilege: "EXECUTE",
  });
  assert.throws(
    () => validateRestoreAuthorityEvidence(publicExecute, expectedOwner),
    /function ACL/,
  );

  const missingReviewer = validAuthorityEvidence();
  authorityFunction(missingReviewer).acl = authorityFunction(missingReviewer).acl.filter(
    (entry) => entry.grantee !== "nutrition_catalogue_approve_rights",
  );
  assert.throws(
    () => validateRestoreAuthorityEvidence(missingReviewer, expectedOwner),
    /function ACL/,
  );

  const wrongApprovalGrantor = validAuthorityEvidence();
  authorityFunction(wrongApprovalGrantor).acl[0].grantor = "restore_operator";
  assert.throws(
    () => validateRestoreAuthorityEvidence(wrongApprovalGrantor, expectedOwner),
    /approval authority function ACL has an unexpected grantor/,
  );

  const publicGuardExecute = validAuthorityEvidence();
  approvalGuardFunction(publicGuardExecute).acl.push({
    grantee: "PUBLIC",
    grantor: expectedOwner,
    grantable: false,
    privilege: "EXECUTE",
  });
  assert.throws(
    () => validateRestoreAuthorityEvidence(publicGuardExecute, expectedOwner),
    /approval guard function ACL/,
  );

  const wrongGuardGrantor = validAuthorityEvidence();
  approvalGuardFunction(wrongGuardGrantor).acl[0].grantor = "restore_operator";
  assert.throws(
    () => validateRestoreAuthorityEvidence(wrongGuardGrantor, expectedOwner),
    /approval guard function ACL has an unexpected grantor/,
  );
});

test("rejects unsafe role attributes and every incoming membership option", () => {
  const unsafeAttribute = validAuthorityEvidence();
  unsafeAttribute.roles[0].superuser = true;
  assert.throws(
    () => validateRestoreAuthorityEvidence(unsafeAttribute, expectedOwner),
    /unsafe attributes/,
  );

  const unsafeMembership = validAuthorityEvidence();
  unsafeMembership.roles[1].incoming_memberships.push({
    admin_option: false,
    inherit_option: false,
    member: "unreviewed_login",
    set_option: false,
  });
  assert.throws(
    () => validateRestoreAuthorityEvidence(unsafeMembership, expectedOwner),
    /unsafe incoming membership/,
  );
});

test("pins the validated 0015 activation-audit null constraint", () => {
  const missingConstraint = validAuthorityEvidence();
  missingConstraint.authorityConstraints = [];
  assert.throws(
    () => validateRestoreAuthorityEvidence(missingConstraint, expectedOwner),
    /activation authority constraint/,
  );

  for (const [property, value] of [
    ["name", "renamed_constraint"],
    ["table_name", "food_source_release"],
    ["constraint_type", "u"],
    ["validated", false],
    ["definition", "CHECK (database_principal IS NULL)"],
  ]) {
    const evidence = validAuthorityEvidence();
    evidence.authorityConstraints[0][property] = value;
    assert.throws(
      () => validateRestoreAuthorityEvidence(evidence, expectedOwner),
      /activation authority constraint/,
      property,
    );
  }
});

test("rejects wrong owners, search paths, and non-definer authority functions", () => {
  const wrongRelationOwner = validAuthorityEvidence();
  wrongRelationOwner.relations[0].owner = "restore_operator";
  assert.throws(
    () => validateRestoreAuthorityEvidence(wrongRelationOwner, expectedOwner),
    /wrong owner/,
  );

  const wrongFunctionOwner = validAuthorityEvidence();
  authorityFunction(wrongFunctionOwner).owner = "restore_operator";
  assert.throws(
    () => validateRestoreAuthorityEvidence(wrongFunctionOwner, expectedOwner),
    /wrong owner/,
  );

  const wrongSearchPath = validAuthorityEvidence();
  authorityFunction(wrongSearchPath).config = ["search_path=pg_catalog, pg_temp, public"];
  assert.throws(
    () => validateRestoreAuthorityEvidence(wrongSearchPath, expectedOwner),
    /authority function.*differs from policy/,
  );

  const invokerFunction = validAuthorityEvidence();
  authorityFunction(invokerFunction).security_definer = false;
  assert.throws(
    () => validateRestoreAuthorityEvidence(invokerFunction, expectedOwner),
    /authority function.*differs from policy/,
  );
});

test("rejects unexpected table or sequence DML authority", () => {
  for (const kind of ["r", "S"]) {
    const evidence = validAuthorityEvidence();
    const relation = evidence.relations.find((entry) => entry.kind === kind);
    relation.acl_is_default = false;
    relation.acl.push({
      grantee: "nutrition_catalogue_approve_data",
      grantor: expectedOwner,
      grantable: false,
      privilege: kind === "S" ? "USAGE" : "INSERT",
    });
    assert.throws(
      () => validateRestoreAuthorityEvidence(evidence, expectedOwner),
      /explicit DML privileges/,
    );
  }
});

test("pins every reviewed authority function and trigger", () => {
  for (const [property, value] of [
    ["source_sha256", "0".repeat(64)],
    ["result_type", "text"],
    ["language", "sql"],
    ["volatility", "s"],
    ["strict", true],
    ["leakproof", true],
    ["parallel", "s"],
  ]) {
    const evidence = validAuthorityEvidence();
    authorityFunction(evidence)[property] = value;
    assert.throws(
      () => validateRestoreAuthorityEvidence(evidence, expectedOwner),
      /executable semantics/,
    );
  }

  for (const reviewedFunction of validAuthorityEvidence().functions.filter(
    (entry) => entry.name !== "ordinary_function",
  )) {
    const bodyDrift = validAuthorityEvidence();
    bodyDrift.functions.find((entry) => entry.name === reviewedFunction.name).source_sha256 =
      "0".repeat(64);
    assert.throws(
      () => validateRestoreAuthorityEvidence(bodyDrift, expectedOwner),
      /authority function.*executable semantics/,
      reviewedFunction.name,
    );
  }

  const signatureDrift = validAuthorityEvidence();
  signatureDrift.functions.find(
    (entry) => entry.name === "catalogue_evidence_bundle_uri_is_valid",
  ).arguments = "digest text, value text";
  assert.throws(
    () => validateRestoreAuthorityEvidence(signatureDrift, expectedOwner),
    /unexpected signature/,
  );

  const missingFunction = validAuthorityEvidence();
  missingFunction.functions = missingFunction.functions.filter(
    (entry) => entry.name !== "guard_food_source_release_update",
  );
  assert.throws(
    () => validateRestoreAuthorityEvidence(missingFunction, expectedOwner),
    /function set/,
  );

  const disabledTrigger = validAuthorityEvidence();
  disabledTrigger.triggers[0].enabled = "D";
  assert.throws(
    () => validateRestoreAuthorityEvidence(disabledTrigger, expectedOwner),
    /trigger.*differs from policy/,
  );

  const crossSchemaTrigger = validAuthorityEvidence();
  crossSchemaTrigger.triggers[0].function_schema = "untrusted_shadow";
  assert.throws(
    () => validateRestoreAuthorityEvidence(crossSchemaTrigger, expectedOwner),
    /trigger.*differs from policy/,
  );

  for (const reviewedTrigger of validAuthorityEvidence().triggers) {
    const triggerDefinitionDrift = validAuthorityEvidence();
    triggerDefinitionDrift.triggers.find(
      (entry) => entry.name === reviewedTrigger.name,
    ).definition += " WHEN (true)";
    assert.throws(
      () => validateRestoreAuthorityEvidence(triggerDefinitionDrift, expectedOwner),
      /trigger.*differs from policy/,
      reviewedTrigger.name,
    );
  }
});

test("rejects public type and global or public-schema default ACL drift", () => {
  const explicitTypeAcl = validAuthorityEvidence();
  explicitTypeAcl.types[0].acl_is_default = false;
  assert.throws(
    () => validateRestoreAuthorityEvidence(explicitTypeAcl, expectedOwner),
    /type.*explicit privileges/,
  );

  const defaultAcl = validAuthorityEvidence();
  defaultAcl.defaultAcls.push({
    acl: [acl("nutrition_catalogue_stage", "INSERT")],
    object_type: "r",
    owner: "unreviewed_owner",
    schema_name: "public",
  });
  assert.throws(() => validateRestoreAuthorityEvidence(defaultAcl, expectedOwner), /default ACL/);
});

test("requires the exact database owner, ACL, effective CONNECT allowlist, and isolation", () => {
  const options = { connectAllowlist: [expectedOwner], expectedOwner };
  const boundary = validDatabaseBoundary();
  validateTargetDatabaseBoundary(boundary, options);

  assert.throws(
    () => validateTargetDatabaseBoundary({ ...boundary, owner: "restore_operator" }, options),
    /wrong owner/,
  );
  assert.throws(
    () =>
      validateTargetDatabaseBoundary(
        { ...boundary, acl: [...boundary.acl, acl("PUBLIC", "CONNECT")] },
        options,
      ),
    /database ACL/,
  );
  assert.throws(
    () =>
      validateTargetDatabaseBoundary(
        { ...boundary, effectiveConnectRoles: [expectedOwner, "runtime_login"] },
        options,
      ),
    /CONNECT login allowlist/,
  );
  assert.throws(
    () => validateTargetDatabaseBoundary({ ...boundary, otherClientSessions: "1" }, options),
    /client session/,
  );
});

test("fails closed on unverifiable or unsafe dump storage and mandatory cleanup", () => {
  const dumpPath = "/dev/shm/nutrition_restore_ci.dump";
  const options = {
    container: "postgres-test-1",
    dumpDirectory: "/dev/shm",
    dumpProtection: "tmpfs",
  };
  const calls = [];
  const run = (_command, arguments_) => {
    calls.push(arguments_);
    if (arguments_.includes("restore-dump-preflight")) return "/dev/shm\n";
    if (arguments_.includes("restore-dump-artifact")) {
      return dumpAttestationOutput(validDumpAttestation(dumpPath));
    }
    return "";
  };

  assertProtectedDumpDestination(run, options, dumpPath);
  assertRegularDumpArtifact(run, options, dumpPath);
  removeDumpArtifact(run, options, dumpPath);
  assert.match(calls[0].join(" "), /readlink -f/);
  assert.match(calls[0].join(" "), /stat -f -c %T/);
  assert.match(calls[0].join(" "), /\[ ! -e "\$dump_path" \]/);
  assert.match(calls[0].join(" "), /\[ ! -L "\$dump_path" \]/);
  assert.match(calls[1].join(" "), /stat -c %a/);
  assert.match(calls[1].join(" "), /stat -f -c %T/);
  assert.deepEqual(calls[2].slice(-4), ["rm", "-f", "--", dumpPath]);
  assert.match(calls[3].join(" "), /\[ ! -e "\$1" \].*\[ ! -L "\$1" \]/);

  assert.throws(
    () =>
      assertProtectedDumpDestination(
        () => "",
        { ...options, dumpProtection: "encrypted_volume" },
        dumpPath,
      ),
    /not independently verifiable/,
  );
  assert.throws(
    () => assertProtectedDumpDestination(() => "/run/not-tmpfs\n", options, dumpPath),
    /exact verified tmpfs/,
  );
  assert.throws(
    () =>
      removeDumpArtifact(
        (_command, arguments_) => {
          if (arguments_.includes("restore-dump-cleanup")) throw new Error("artifact remains");
          return "";
        },
        options,
        dumpPath,
      ),
    /artifact remains/,
  );

  for (const [property, value] of [
    ["mountType", "ext2/ext3"],
    ["ownerUid", "1001"],
    ["ownerGid", "1001"],
    ["mode", "640"],
    ["linkCount", "2"],
    ["fileType", "symbolic link"],
  ]) {
    assert.throws(
      () =>
        validateDumpArtifactAttestation(
          { ...validDumpAttestation(dumpPath), [property]: value },
          options,
          dumpPath,
        ),
      /exact private tmpfs policy/,
      property,
    );
  }
});

test("orchestration rejects source body drift before dump creation", () => {
  const evidence = validAuthorityEvidence();
  authorityFunction(evidence).source_sha256 = "0".repeat(64);
  const { calls, run } = authorityEvidenceRunner(evidence);

  assert.throws(() => runPostgresRestoreDrill(restoreOptions(), { run }), /executable semantics/);
  assert.equal(
    calls.some((arguments_) => arguments_.join(" ").includes("pg_dump")),
    false,
  );
});

test("orchestration rejects cross-schema trigger drift before dump creation", () => {
  const evidence = validAuthorityEvidence();
  evidence.triggers[0].function_schema = "untrusted_shadow";
  const { calls, run } = authorityEvidenceRunner(evidence);

  assert.throws(
    () => runPostgresRestoreDrill(restoreOptions(), { run }),
    /trigger.*differs from policy/,
  );
  assert.equal(
    calls.some((arguments_) => arguments_.join(" ").includes("pg_dump")),
    false,
  );
});

test("orchestration makes cleanup failure-terminal after a post-dump policy failure", () => {
  const cleanupError = new Error("cleanup verification failed");
  const { calls, run } = authorityEvidenceRunner(validAuthorityEvidence(), {
    cleanupError,
    policyError: new Error("policy rejected authority drift"),
  });

  assert.throws(
    () => runPostgresRestoreDrill(restoreOptions(), { run }),
    /cleanup verification failed/,
  );
  assert.equal(
    calls.some(
      (arguments_) =>
        arguments_.slice(-4).join(" ") ===
        "rm -f -- /dev/shm/nutrition_restore_ci_orchestration.dump",
    ),
    true,
  );
  assert.equal(
    calls.some((arguments_) => arguments_.join(" ").includes("umask 077")),
    true,
  );
});

test("pins the exact versioned policy bytes", () => {
  assert.equal(RESTORE_AUTHORITY_POLICY_SHA256.length, 64);
  assert.throws(
    () => assertRestoreAuthorityPolicyDigest("begin; commit;\n", RESTORE_AUTHORITY_POLICY_SHA256),
    /policy digest/,
  );
});

function validAuthorityEvidence() {
  return {
    authorityConstraints: [
      {
        constraint_type: "c",
        definition: "CHECK (database_principal IS NULL AND database_capability_role IS NULL)",
        name: "food_source_release_activation_expand_audit_null_check",
        table_name: "food_source_release_activation",
        validated: true,
      },
    ],
    defaultAcls: [],
    functions: validAuthorityFunctions(),
    relations: [
      {
        acl: [acl(expectedOwner, "SELECT")],
        acl_is_default: true,
        kind: "r",
        name: "food_import_batch",
        owner: expectedOwner,
      },
      {
        acl: [acl(expectedOwner, "USAGE")],
        acl_is_default: true,
        kind: "S",
        name: "food_import_approval_id_seq",
        owner: expectedOwner,
      },
    ],
    roles: capabilityRoles.map((name) => ({
      bypass_rls: false,
      can_login: false,
      create_database: false,
      create_role: false,
      incoming_memberships: [],
      name,
      outgoing_memberships: [],
      owned_object_count: "0",
      replication: false,
      superuser: false,
    })),
    schema: {
      acl: [
        acl("PUBLIC", "USAGE", "pg_database_owner"),
        acl("nutrition_catalogue_approve_data", "USAGE", "pg_database_owner"),
        acl("nutrition_catalogue_approve_quality", "USAGE", "pg_database_owner"),
        acl("nutrition_catalogue_approve_rights", "USAGE", "pg_database_owner"),
        acl("pg_database_owner", "CREATE", "pg_database_owner"),
        acl("pg_database_owner", "USAGE", "pg_database_owner"),
      ],
      acl_is_default: false,
      name: "public",
      owner: "pg_database_owner",
    },
    triggers: validAuthorityTriggers(),
    types: [
      {
        acl: [acl("PUBLIC", "USAGE"), acl(expectedOwner, "USAGE")],
        acl_is_default: true,
        kind: "e",
        name: "food_import_state",
        owner: expectedOwner,
      },
    ],
    version: 4,
  };
}

function functionSemantics(sourceSha256, resultType) {
  return {
    language: "plpgsql",
    leakproof: false,
    parallel: "u",
    result_type: resultType,
    source_sha256: sourceSha256,
    strict: false,
    volatility: "v",
  };
}

function validAuthorityFunctions() {
  const triggerFunctions = [
    [
      "guard_food_import_approval_authority",
      "f96feb298d900165172c56a3fa1e99e91aaca010657155e5a996ee04015fdbbd",
    ],
    [
      "guard_food_import_batch_initial_state",
      "2561714155de31151c79f95977156072a66451d1f13f7b5c6e85d13abe9ecb0c",
    ],
    [
      "guard_food_import_batch_update",
      "59dc41d73ec62b554caa721e13a2581a75327688f840cab922fddad0ca7be249",
    ],
    [
      "guard_food_import_batch_validation_digest",
      "511c01c16477a31c2de7639a5b48c65e421167c129dfd83377f9256210288ba2",
    ],
    [
      "guard_food_import_record_update",
      "b111a6db4f4bd43bf2e9183ecf0ee8b19ccda1ed3679c598ef2f73d58d9cb2d9",
    ],
    [
      "guard_food_source_active_release_authority",
      "306eec1771a7bbf7961bd6d46ba752801fe98f07d27fbf96291a1c454750cd11",
    ],
    [
      "guard_food_source_initial_active_release",
      "e3cbc51f28aafd274ea2bc3b71b824d51180d8e741dbcfd22d0af9e21849be43",
    ],
    [
      "guard_food_source_release_initial_state",
      "797445724ddd8d37cdbcc1891c724e9bd8af543548d322db5cf9c3d22ac13b3d",
    ],
    [
      "guard_food_source_release_legacy_promotion_grandfather",
      "22340dfcbb5f98e1d0504703b0fb37830b31a4ecde5cbe81e55844968b86f214",
    ],
    [
      "guard_food_source_release_update",
      "191701f20750b6e98b8acf290a1df2417bf17bd9c3a4e5e87a7ac7ef56453726",
    ],
    [
      "guard_new_food_source_release_authority",
      "93f189e2c097009ac1cbf1129ce10a24d0c7fd2e4cee66c2ea5cdbb1537462b3",
    ],
    [
      "reject_new_legacy_unbound_catalogue_evidence",
      "f972295c68b0774f901ce592801a0c8d25ddf6384194a702ca576844f088b14e",
    ],
  ].map(([name, sourceSha256]) => ({
    ...functionSemantics(sourceSha256, "trigger"),
    acl:
      name === "guard_food_import_approval_authority"
        ? [acl(expectedOwner, "EXECUTE")]
        : [acl("PUBLIC", "EXECUTE"), acl(expectedOwner, "EXECUTE")],
    acl_is_default: name !== "guard_food_import_approval_authority",
    arguments: "",
    config: ["search_path=pg_catalog, public, pg_temp"],
    name,
    owner: expectedOwner,
    security_definer: false,
  }));
  return [
    {
      ...functionSemantics(
        "89b10b9f12cee731953c14a80b18fcf5f565eb7a7a80d92be55f1cabdab697ac",
        "boolean",
      ),
      acl: [
        acl(expectedOwner, "EXECUTE"),
        acl("nutrition_catalogue_approve_data", "EXECUTE"),
        acl("nutrition_catalogue_approve_quality", "EXECUTE"),
        acl("nutrition_catalogue_approve_rights", "EXECUTE"),
      ],
      acl_is_default: false,
      arguments:
        "p_batch_id uuid, p_requested_approval_role text, p_validation_digest text, p_rights_digest text, p_external_principal_id text, p_approval_reference text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      name: "catalogue_record_import_approval",
      owner: expectedOwner,
      security_definer: true,
    },
    {
      ...functionSemantics(
        "5403779dc4398446c61d0a27ad8b95d904e2552a5e694496b9e7e8612e0c902e",
        "boolean",
      ),
      acl: [acl("PUBLIC", "EXECUTE"), acl(expectedOwner, "EXECUTE")],
      acl_is_default: true,
      arguments: "value text, digest text",
      config: ["search_path=pg_catalog, public, pg_temp"],
      language: "sql",
      name: "catalogue_evidence_bundle_uri_is_valid",
      owner: expectedOwner,
      security_definer: false,
      strict: true,
      volatility: "i",
    },
    ...triggerFunctions,
    {
      ...functionSemantics("a".repeat(64), "boolean"),
      acl: [acl("PUBLIC", "EXECUTE"), acl(expectedOwner, "EXECUTE")],
      acl_is_default: true,
      arguments: "",
      config: [],
      name: "ordinary_function",
      owner: expectedOwner,
      security_definer: false,
    },
  ];
}

function validAuthorityTriggers() {
  return [
    [
      "food_import_approval_guard_authority",
      "food_import_approval",
      "guard_food_import_approval_authority",
      "CREATE TRIGGER food_import_approval_guard_authority BEFORE INSERT ON food_import_approval FOR EACH ROW EXECUTE FUNCTION guard_food_import_approval_authority()",
    ],
    [
      "food_import_batch_guard_initial_state",
      "food_import_batch",
      "guard_food_import_batch_initial_state",
      "CREATE TRIGGER food_import_batch_guard_initial_state BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_initial_state()",
    ],
    [
      "food_import_batch_guard_update",
      "food_import_batch",
      "guard_food_import_batch_update",
      "CREATE TRIGGER food_import_batch_guard_update BEFORE DELETE OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_update()",
    ],
    [
      "food_import_batch_guard_validation_digest",
      "food_import_batch",
      "guard_food_import_batch_validation_digest",
      "CREATE TRIGGER food_import_batch_guard_validation_digest BEFORE INSERT OR UPDATE ON food_import_batch FOR EACH ROW EXECUTE FUNCTION guard_food_import_batch_validation_digest()",
    ],
    [
      "food_import_batch_reject_new_legacy_unbound",
      "food_import_batch",
      "reject_new_legacy_unbound_catalogue_evidence",
      "CREATE TRIGGER food_import_batch_reject_new_legacy_unbound BEFORE INSERT ON food_import_batch FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()",
    ],
    [
      "food_import_record_guard_update",
      "food_import_record",
      "guard_food_import_record_update",
      "CREATE TRIGGER food_import_record_guard_update BEFORE UPDATE ON food_import_record FOR EACH ROW EXECUTE FUNCTION guard_food_import_record_update()",
    ],
    [
      "food_source_guard_active_release_authority",
      "food_source",
      "guard_food_source_active_release_authority",
      "CREATE TRIGGER food_source_guard_active_release_authority BEFORE UPDATE OF active_release_id ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_active_release_authority()",
    ],
    [
      "food_source_guard_initial_active_release",
      "food_source",
      "guard_food_source_initial_active_release",
      "CREATE TRIGGER food_source_guard_initial_active_release BEFORE INSERT ON food_source FOR EACH ROW EXECUTE FUNCTION guard_food_source_initial_active_release()",
    ],
    [
      "food_source_release_guard_initial_state",
      "food_source_release",
      "guard_food_source_release_initial_state",
      "CREATE TRIGGER food_source_release_guard_initial_state BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_initial_state()",
    ],
    [
      "food_source_release_guard_legacy_grandfather_insert",
      "food_source_release",
      "guard_food_source_release_legacy_promotion_grandfather",
      "CREATE TRIGGER food_source_release_guard_legacy_grandfather_insert BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()",
    ],
    [
      "food_source_release_guard_legacy_grandfather_update",
      "food_source_release",
      "guard_food_source_release_legacy_promotion_grandfather",
      "CREATE TRIGGER food_source_release_guard_legacy_grandfather_update BEFORE UPDATE OF legacy_promotion_grandfathered_at ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_legacy_promotion_grandfather()",
    ],
    [
      "food_source_release_guard_new_authority",
      "food_source_release",
      "guard_new_food_source_release_authority",
      "CREATE TRIGGER food_source_release_guard_new_authority BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_new_food_source_release_authority()",
    ],
    [
      "food_source_release_guard_update",
      "food_source_release",
      "guard_food_source_release_update",
      "CREATE TRIGGER food_source_release_guard_update BEFORE UPDATE ON food_source_release FOR EACH ROW EXECUTE FUNCTION guard_food_source_release_update()",
    ],
    [
      "food_source_release_reject_new_legacy_unbound",
      "food_source_release",
      "reject_new_legacy_unbound_catalogue_evidence",
      "CREATE TRIGGER food_source_release_reject_new_legacy_unbound BEFORE INSERT ON food_source_release FOR EACH ROW EXECUTE FUNCTION reject_new_legacy_unbound_catalogue_evidence()",
    ],
  ].map(([name, tableName, functionName, definition]) => ({
    definition,
    enabled: "O",
    function_arguments: "",
    function_name: functionName,
    function_schema: "public",
    name,
    table_name: tableName,
  }));
}

function validDatabaseBoundary() {
  return {
    acl: [
      acl("PUBLIC", "TEMPORARY"),
      acl(expectedOwner, "CONNECT"),
      acl(expectedOwner, "CREATE"),
      acl(expectedOwner, "TEMPORARY"),
    ],
    effectiveConnectRoles: [expectedOwner],
    otherClientSessions: "0",
    owner: expectedOwner,
  };
}

function restoreOptions() {
  return {
    connectAllowlist: [expectedOwner],
    container: "postgres-test-1",
    dumpDirectory: "/dev/shm",
    dumpProtection: "tmpfs",
    expectedOwner,
    sourceDatabase: "nutrition_source",
    targetDatabase: "nutrition_restore_ci_orchestration",
    user: "nutrition",
  };
}

function validDumpAttestation(dumpPath) {
  return {
    executorGid: "0",
    executorUid: "0",
    fileType: "regular file",
    linkCount: "1",
    mode: "600",
    mountType: "tmpfs",
    ownerGid: "0",
    ownerUid: "0",
    resolvedArtifact: dumpPath,
    resolvedDirectory: "/dev/shm",
  };
}

function dumpAttestationOutput(attestation) {
  return `${[
    attestation.resolvedDirectory,
    attestation.mountType,
    attestation.resolvedArtifact,
    attestation.ownerUid,
    attestation.ownerGid,
    attestation.mode,
    attestation.linkCount,
    attestation.fileType,
    attestation.executorUid,
    attestation.executorGid,
  ].join("\n")}\n`;
}

function authorityEvidenceRunner(evidence, failures = {}) {
  const calls = [];
  const dumpPath = "/dev/shm/nutrition_restore_ci_orchestration.dump";
  const boundary = validDatabaseBoundary();
  const run = (_command, arguments_) => {
    calls.push(arguments_);
    const commandText = arguments_.join(" ");
    const sql = arguments_.at(-1) ?? "";

    if (arguments_.includes("restore-dump-preflight")) return "/dev/shm\n";
    if (arguments_.includes("restore-dump-artifact")) {
      return dumpAttestationOutput(validDumpAttestation(dumpPath));
    }
    if (arguments_.includes("restore-dump-cleanup")) {
      if (failures.cleanupError) throw failures.cleanupError;
      return "";
    }
    if (arguments_.includes("sha256sum")) return `${"a".repeat(64)}  ${dumpPath}\n`;
    if (commandText.includes("pg_dump") || arguments_.includes("createdb")) return "";
    if (arguments_.includes("pg_restore")) return "";
    if (arguments_.slice(-4).join(" ") === `rm -f -- ${dumpPath}`) return "";

    if (sql.includes("set role")) {
      if (failures.policyError) throw failures.policyError;
      return "";
    }
    if (sql.includes("select count(*) from pg_database")) return "0\n";
    if (sql.includes("database_acl")) return `${JSON.stringify(boundary.acl)}\n`;
    if (sql.includes("has_database_privilege")) {
      return `${JSON.stringify(boundary.effectiveConnectRoles)}\n`;
    }
    if (sql.includes("pg_stat_activity")) return `${boundary.otherClientSessions}\n`;
    if (sql.includes("pg_get_userbyid(database_row.datdba)")) return `${boundary.owner}\n`;
    if (sql.includes("authority_constraint_policy")) {
      return `${JSON.stringify(evidence.authorityConstraints)}\n`;
    }
    if (sql.includes("default_policy")) return `${JSON.stringify(evidence.defaultAcls)}\n`;
    if (sql.includes("function_policy")) return `${JSON.stringify(evidence.functions)}\n`;
    if (sql.includes("relation_policy")) return `${JSON.stringify(evidence.relations)}\n`;
    if (sql.includes("role_policy")) return `${JSON.stringify(evidence.roles)}\n`;
    if (sql.includes("schema_policy")) return `${JSON.stringify(evidence.schema)}\n`;
    if (sql.includes("trigger_policy")) return `${JSON.stringify(evidence.triggers)}\n`;
    if (sql.includes("type_policy")) return `${JSON.stringify(evidence.types)}\n`;
    if (sql.includes("revoke connect")) return "";
    throw new Error(`Unexpected mocked restore command: ${commandText}`);
  };
  return { calls, run };
}

function authorityFunction(evidence) {
  return evidence.functions[0];
}

function approvalGuardFunction(evidence) {
  const guardFunction = evidence.functions.find(
    (entry) => entry.name === "guard_food_import_approval_authority",
  );
  if (!guardFunction) throw new Error("Approval guard function fixture is missing");
  return guardFunction;
}

function acl(grantee, privilege, grantor = expectedOwner) {
  return { grantee, grantor, grantable: false, privilege };
}
