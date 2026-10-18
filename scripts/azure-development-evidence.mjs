import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectorSourceDigest, openDevelopmentCollector } from "./azure-development-collector.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = resolve(REPO, "infra/development/azure/collect-evidence.py");
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
];
const requireValue = (condition) => {
  if (!condition) throw new Error("Development evidence input or conservation check failed");
};

export const sourceDigest = () => collectorSourceDigest(REPO, SOURCES);

/** Fixed six-family sequence. The CLI admits no executor or request overrides. */
export async function collectDevelopmentEvidence(inputPath, options, execute) {
  const collector = await openDevelopmentCollector(
    inputPath,
    { helper: HELPER, sourceDigest },
    options,
    execute,
  );
  for (const [label, args] of collector.session.auth_commands)
    await collector.read(`auth-${label}`, [...args, "--only-show-errors", "--output", "json"]);
  await collector.stage("authenticate");
  for (const stage of ["requests", "remaining"])
    for (const descriptor of await collector.stage(stage))
      await collector.read(`read-${descriptor.label}`, descriptor.arguments);
  return collector.finish();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--source-digest") {
    console.log(await sourceDigest());
    return;
  }
  requireValue(args.length === 2 && args[0] === "--input");
  process.umask(0o077);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Collector interrupted"));
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, stop);
  try {
    await collectDevelopmentEvidence(args[1], { signal: controller.signal });
    console.log(
      "Private native evidence policy passed; no plan, allocation or runtime acceptance.",
    );
  } finally {
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(name, stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(
      "Development evidence did not complete. Private partial or published files may remain; no acceptance established.",
    );
    process.exitCode = 1;
  });
}
