import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  AzureArtifactStoreError,
  AzureBlobCredentialCanaryError,
  type AzureBlobCredentialCanaryExecution,
  runAzureBlobCredentialCanary,
  validateAzureBlobCredentialCanaryConfiguration,
} from "@nutrition-tracker/artifact-store";

/** This maintenance command reads only explicit Azure values; it never starts the worker. */
export function parseAzureObjectStorageCanaryConfiguration(environment: NodeJS.ProcessEnv) {
  const required = (name: string) => {
    const value = environment[name];
    if (
      !value ||
      value.length > 8192 ||
      /\s/u.test(value) ||
      [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new AzureArtifactStoreError();
    return value;
  };
  for (const [name, value] of Object.entries({
    NODE_ENV: "development",
    NOURISHING_API_PROFILE: "hosted-development",
    EXPORT_ARTIFACT_STORE: "azure",
    ERASURE_REPLAY_LEDGER_STORE: "azure",
  }))
    if (environment[name] !== value) throw new AzureArtifactStoreError();
  return validateAzureBlobCredentialCanaryConfiguration({
    exports: {
      containerUrl: required("EXPORT_ARTIFACT_AZURE_CONTAINER_URL"),
      prefix: required("EXPORT_ARTIFACT_AZURE_PREFIX"),
      readerSas: required("EXPORT_ARTIFACT_AZURE_READ_SAS"),
      writerSas: required("EXPORT_ARTIFACT_AZURE_WRITE_SAS"),
      observerSas: required("EXPORT_ARTIFACT_AZURE_DELETE_OBSERVER_SAS"),
    },
    ledger: {
      containerUrl: required("ERASURE_REPLAY_LEDGER_AZURE_CONTAINER_URL"),
      prefix: required("ERASURE_REPLAY_LEDGER_AZURE_PREFIX"),
      writerSas: required("ERASURE_REPLAY_LEDGER_AZURE_WRITE_SAS"),
      restoreSas: required("ERASURE_REPLAY_LEDGER_AZURE_RESTORE_SAS"),
    },
  });
}

export async function runAzureObjectStorageCredentialCanaryFromEnvironment(
  environment: NodeJS.ProcessEnv,
  execution: AzureBlobCredentialCanaryExecution,
) {
  return runAzureBlobCredentialCanary(
    parseAzureObjectStorageCanaryConfiguration(environment),
    execution,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  void runAzureObjectStorageCredentialCanaryFromEnvironment(process.env, {
    signal: cancellation.signal,
    onStart: (identity) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(
          `${JSON.stringify({ event: "azure_object_storage.credentials.started", ...identity })}\n`,
          (error) => (error ? reject(error) : resolve()),
        );
      }),
  })
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({ event: "azure_object_storage.credentials.attested", ...result })}\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({ event: "azure_object_storage.credentials.failed", level: "fatal", ...(error instanceof AzureBlobCredentialCanaryError ? { canaryId: error.canaryId } : {}) })}\n`,
      );
      process.exitCode = 1;
    })
    .finally(() => {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    });
}
