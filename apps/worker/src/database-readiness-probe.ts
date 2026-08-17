import process from "node:process";
import { pathToFileURL } from "node:url";

import { assertDatabaseReady, createDatabaseFromEnvironment } from "@nutrition-tracker/db";

function databaseRestoreEpoch(environment: NodeJS.ProcessEnv): string {
  const value = environment.DATABASE_RESTORE_EPOCH;
  if (!value || value.length < 32 || value.length > 500 || value.trim() !== value) {
    throw new Error(
      "DATABASE_RESTORE_EPOCH must contain 32 to 500 non-whitespace-boundary characters",
    );
  }
  return value;
}

/** Bounded, offline-safe readiness check. It never starts search or retention polling. */
export async function runDatabaseReadinessProbeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const restoreEpoch = databaseRestoreEpoch(environment);
  const database = createDatabaseFromEnvironment(environment);
  try {
    await assertDatabaseReady(database, {
      requireRestoreAttestation: true,
      restoreEpoch,
    });
  } finally {
    await database.destroy();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void runDatabaseReadinessProbeFromEnvironment()
    .then(() => {
      process.stdout.write(
        `${JSON.stringify({ event: "database.readiness.attested", level: "info" })}\n`,
      );
    })
    .catch((error: unknown) => {
      const errorType =
        error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
          ? error.name
          : "UnknownError";
      process.stderr.write(
        `${JSON.stringify({ event: "database.readiness.failed", errorType, level: "fatal" })}\n`,
      );
      process.exitCode = 1;
    });
}
