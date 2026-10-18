import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectorPrivateJson,
  collectorSourceDigest,
  openDevelopmentCollector,
} from "./azure-development-collector.mjs";
import { limitedTool, PYTHON, rejectAmbient } from "./azure-development-plan.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = resolve(REPO, "infra/development/azure/subscription-baseline.py");
const SOURCES = [
  ...[
    ".terraform.lock.hcl",
    "versions.tf",
    "variables.tf",
    "main.tf",
    "outputs.tf",
    "audit-plan.py",
    "auth-preflight.py",
    "collect-evidence.py",
  ].map((name) => `infra/development/azure/${name}`),
  "infra/azure/tests/audit_saved_plan.py",
  "scripts/azure-development-evidence.mjs",
  "scripts/azure-development-plan.mjs",
  "scripts/postgres-operator-process.mjs",
  "scripts/azure-development-collector.mjs",
  "infra/development/azure/subscription-baseline.py",
  "scripts/azure-development-baseline.mjs",
];
export const sourceDigest = () => collectorSourceDigest(REPO, SOURCES);

/** Six fixed CLI invocations. The injected executor is a synthetic-test seam, never a CLI option. */
export async function collectDevelopmentBaseline(inputPath, options, execute) {
  const collector = await openDevelopmentCollector(
    inputPath,
    { helper: HELPER, sourceDigest },
    options,
    execute,
  );
  for (const [label, args] of collector.session.auth_commands)
    await collector.read(`auth-${label}`, [...args, "--only-show-errors", "--output", "json"]);
  await collector.stage("authenticate");
  for (const descriptor of await collector.stage("requests"))
    await collector.read(`read-${descriptor.label}`, descriptor.arguments, 1_048_576);
  const result = await collector.finish();
  await collector.stage("verify-result", [result.indexSha256]);
  return result;
}

/** Local retained-result consumer. Requires an independently recorded index hash and an admitted input scope. */
export async function verifyDevelopmentBaseline(
  inputPath,
  indexSha256,
  { signal = new AbortController().signal, environment = process.env } = {},
  execute = limitedTool,
) {
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    !/^[a-f0-9]{64}$/u.test(indexSha256)
  )
    throw new Error("Baseline verification input rejected");
  rejectAmbient(environment);
  signal.throwIfAborted();
  const source = await sourceDigest();
  const input = await collectorPrivateJson(inputPath);
  if (
    input.value.source_sha256 !== source ||
    !/^nourishing-baseline-[0-9a-f]{12}$/u.test(input.value.operation_name)
  )
    throw new Error("Baseline verification source rejected");
  const directory = resolve(dirname(inputPath), input.value.operation_name);
  const session = await collectorPrivateJson(resolve(directory, "session.json"));
  const stopAt = Date.parse(input.value.not_after_utc) - 30_000;
  const remaining = Math.min(60_000, stopAt - Date.now());
  if (!Number.isFinite(remaining) || remaining < 1)
    throw new Error("Baseline verification deadline expired");
  const monotonicDeadline = performance.now() + remaining;
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.floor(remaining))]);
  const conserveDeadline = () => {
    boundedSignal.throwIfAborted();
    if (Date.now() >= stopAt || performance.now() >= monotonicDeadline)
      throw new Error("Baseline verification deadline expired");
  };
  conserveDeadline();
  const result = await execute(
    PYTHON,
    ["-I", "-B", HELPER, "verify-result", inputPath, directory, session.sha256, indexSha256],
    {
      signal: boundedSignal,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" },
      directory: dirname(inputPath),
      limit: 131_072,
    },
  );
  conserveDeadline();
  if (
    (await sourceDigest()) !== source ||
    (await collectorPrivateJson(inputPath)).sha256 !== input.sha256 ||
    (await collectorPrivateJson(resolve(directory, "session.json"))).sha256 !== session.sha256
  )
    throw new Error("Baseline verification input changed");
  conserveDeadline();
  const value = JSON.parse(result.text);
  if (value.completed !== true || value.index_sha256 !== indexSha256)
    throw new Error("Baseline result rejected");
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--source-digest") {
    console.log(await sourceDigest());
    return;
  }
  const collect = args.length === 2 && args[0] === "--input";
  const verify = args.length === 4 && args[0] === "--verify-result" && args[2] === "--index-sha256";
  if (!collect && !verify) throw new Error("Fixed baseline arguments required");
  process.umask(0o077);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Baseline interrupted"));
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, stop);
  try {
    if (collect) await collectDevelopmentBaseline(args[1], { signal: controller.signal });
    else await verifyDevelopmentBaseline(args[1], args[3], { signal: controller.signal });
    console.log(
      "Private subscription baseline policy passed; no credit, spending or hosted acceptance.",
    );
  } finally {
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(name, stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(
      "Subscription baseline did not complete. Private partial or published evidence may remain.",
    );
    process.exitCode = 1;
  });
