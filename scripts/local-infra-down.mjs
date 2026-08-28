import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalInfrastructureError, stopLocalInfrastructure } from "./local-infra-up.mjs";

const scriptPath = fileURLToPath(import.meta.url);

if (resolve(process.argv[1] ?? "") === scriptPath) {
  if (process.argv.length !== 2) {
    process.stderr.write("[local-infra] No arguments are accepted.\n");
    process.exitCode = 1;
  } else {
    try {
      stopLocalInfrastructure();
    } catch (error) {
      const message =
        error instanceof LocalInfrastructureError
          ? error.message
          : "Local infrastructure failed before completion.";
      process.stderr.write(`[local-infra] ${message}\n`);
      process.exitCode = 1;
    }
  }
}
