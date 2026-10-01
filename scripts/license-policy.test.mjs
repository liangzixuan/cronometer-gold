import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLicensePolicy } from "./license-policy.mjs";

const exception = () => ({
  packageName: "reviewed",
  license: "MPL-2.0",
  versions: ["1.2.3"],
  owner: "engineering",
  reason: "Exact unmodified package with source and notices.",
  noticeToken: "reviewed source",
  expires: "2999-12-31",
});
const policy = (reviewedExceptions = []) => ({
  allowedLicenseGroups: ["MIT", "Apache-2.0"],
  alwaysDeniedIdentifiers: ["AGPL", "BUSL", "NC"],
  reviewedExceptions,
});
const report = (license = "MPL-2.0", name = "reviewed", versions = ["1.2.3"]) => ({
  [license]: [{ name, versions }],
});
const evaluate = (entry = exception(), inventory = report(), notices = "reviewed source") =>
  evaluateLicensePolicy(policy([entry]), notices, inventory);

test("allowed literal licenses need no exception and count each package", () => {
  assert.deepEqual(
    evaluateLicensePolicy(policy(), "", {
      MIT: [
        { name: "a", versions: ["1"] },
        { name: "b", versions: ["2", "3"] },
      ],
    }),
    { violations: [], reviewedExceptionCount: 0, packageCount: 2 },
  );
});
test("exact reviewed package/version and notice are accepted", () => {
  assert.deepEqual(evaluate(), { violations: [], reviewedExceptionCount: 1, packageCount: 1 });
});
test("an exception never overrides the unconditional deny list", () => {
  const result = evaluate(
    { ...exception(), license: "MIT OR AGPL-3.0" },
    report("MIT OR AGPL-3.0"),
  );
  assert.deepEqual(
    result.violations.map((item) => item.reason),
    [
      "contains denied identifier AGPL",
      "reviewed exception is unused and must be removed or re-reviewed",
    ],
  );
});
test("denial is case insensitive and precedes allowed literal groups", () => {
  const value = policy();
  value.allowedLicenseGroups.push("agpl-3.0");
  assert.match(evaluateLicensePolicy(value, "", report("agpl-3.0")).violations[0].reason, /AGPL/);
});
for (const [label, inventory] of [
  ["another package", report("MPL-2.0", "other")],
  ["another version", report("MPL-2.0", "reviewed", ["1.2.4"])],
  ["one unreviewed mixed version", report("MPL-2.0", "reviewed", ["1.2.3", "2.0.0"])],
  ["another license expression", report("MPL-2.0 OR Apache-2.0")],
])
  test(`rejects ${label} and reports the unused exception`, () => {
    assert.equal(evaluate(exception(), inventory).violations.length, 2);
  });
test("unused exception remains a failure even with otherwise allowed packages", () => {
  assert.match(evaluate(exception(), report("MIT")).violations[0].reason, /unused/);
});
test("anchored exact package patterns remain supported", () => {
  const value = exception();
  delete value.packageName;
  value.packagePattern = "^reviewed$";
  assert.equal(evaluate(value).violations.length, 0);
  assert.equal(evaluate(value, report("MPL-2.0", "reviewed-extra")).violations.length, 2);
});
for (const field of ["owner", "reason", "noticeToken", "versions", "expires"]) {
  test(`requires exception ${field}`, () => {
    const value = exception();
    delete value[field];
    assert.throws(() => evaluate(value));
  });
}
test("rejects missing notice bytes", () => {
  assert.throws(
    () => evaluate(exception(), report(), ""),
    /Third-party notices omit exception token/,
  );
});
test("rejects ambiguous or absent package selectors", () => {
  assert.throws(() => evaluate({ ...exception(), packagePattern: "^reviewed$" }), /one exact name/);
  const value = exception();
  delete value.packageName;
  assert.throws(() => evaluate(value), /one exact name/);
});
test("rejects unanchored pattern, empty versions and expired exception", () => {
  const value = exception();
  delete value.packageName;
  value.packagePattern = "reviewed";
  assert.throws(() => evaluate(value), /must be anchored/);
  assert.throws(
    () => evaluate({ ...exception(), versions: [] }),
    /requires an owner|require an owner/,
  );
  assert.throws(() => evaluate({ ...exception(), expires: "2000-01-01" }), /expired/);
});
test("expiry uses the real current Date.now boundary, inclusive at the final millisecond", (context) => {
  context.mock.method(Date, "now", () => Date.parse("2026-10-01T23:59:59.999Z"));
  assert.equal(evaluate({ ...exception(), expires: "2026-10-01" }).violations.length, 0);
  Date.now.mock.mockImplementation(() => Date.parse("2026-10-02T00:00:00.000Z"));
  assert.throws(() => evaluate({ ...exception(), expires: "2026-10-01" }), /expired/);
});
