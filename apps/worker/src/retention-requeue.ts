import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  assertDatabaseReady,
  createDatabaseFromEnvironment,
  type RetentionRecoveryRecord,
  requeueDeadLetteredAccountErasureJob,
  requeueDeadLetteredPrivacyExportArtifactDeletion,
  requeueDeadLetteredPrivacyExportJob,
  requeueDeadLetteredPrivacyExportStagedArtifactDeletion,
} from "@nutrition-tracker/db";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type RetentionRequeueKind = "artifact" | "erasure" | "export" | "staged-artifact";

export interface RetentionRequeueRequest {
  readonly approvalDigest: string;
  readonly id: string;
  readonly kind: RetentionRequeueKind;
}

export interface RetentionRequeueRepository {
  requeueArtifact(input: {
    readonly artifactId: string;
    readonly approvalDigest: string;
    readonly requeuedAt: string;
  }): Promise<void>;
  requeueErasure(input: {
    readonly jobId: string;
    readonly approvalDigest: string;
    readonly requeuedAt: string;
  }): Promise<void>;
  requeueExport(input: {
    readonly jobId: string;
    readonly approvalDigest: string;
    readonly requeuedAt: string;
  }): Promise<void>;
  requeueStagedArtifact(input: {
    readonly artifactId: string;
    readonly approvalDigest: string;
    readonly requeuedAt: string;
  }): Promise<void>;
}

export function parseRetentionRequeueArguments(
  arguments_: readonly string[],
): RetentionRequeueRequest {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !key ||
      !value ||
      !["--approval-digest", "--id", "--kind"].includes(key) ||
      values.has(key)
    ) {
      throw new Error("Invalid retention requeue arguments");
    }
    values.set(key, value);
  }
  if (values.size !== 3 || arguments_.length !== 6) {
    throw new Error("Invalid retention requeue arguments");
  }
  const kind = values.get("--kind");
  const id = values.get("--id");
  const approvalDigest = values.get("--approval-digest");
  if (!kind || !["artifact", "erasure", "export", "staged-artifact"].includes(kind)) {
    throw new Error("Invalid retention requeue kind");
  }
  if (!id || !UUID_PATTERN.test(id)) throw new Error("Invalid retention requeue identifier");
  if (!approvalDigest || !/^[0-9a-f]{64}$/.test(approvalDigest)) {
    throw new Error("Invalid retention requeue approval digest");
  }
  return { approvalDigest, id, kind: kind as RetentionRequeueKind };
}

export async function requeueRetentionDeadLetter(input: {
  readonly request: RetentionRequeueRequest;
  readonly repository: RetentionRequeueRepository;
  readonly clock?: () => Date;
}): Promise<RetentionRecoveryRecord> {
  const common = {
    approvalDigest: input.request.approvalDigest,
    requeuedAt: (input.clock ?? (() => new Date()))().toISOString(),
  };
  let recoveryKind: RetentionRecoveryRecord["recoveryKind"];
  switch (input.request.kind) {
    case "artifact":
      await input.repository.requeueArtifact({ ...common, artifactId: input.request.id });
      recoveryKind = "artifact_deletion";
      break;
    case "erasure":
      await input.repository.requeueErasure({ ...common, jobId: input.request.id });
      recoveryKind = "account_erasure";
      break;
    case "export":
      await input.repository.requeueExport({ ...common, jobId: input.request.id });
      recoveryKind = "privacy_export";
      break;
    case "staged-artifact":
      await input.repository.requeueStagedArtifact({ ...common, artifactId: input.request.id });
      recoveryKind = "staged_artifact_deletion";
      break;
  }
  return { recoveryKind, requeuedAt: common.requeuedAt, targetId: input.request.id };
}

function restoreEpoch(environment: NodeJS.ProcessEnv): string {
  const value = environment.DATABASE_RESTORE_EPOCH;
  if (!value || value.length < 32 || value.length > 500 || value.trim() !== value) {
    throw new Error(
      "DATABASE_RESTORE_EPOCH must contain 32 to 500 non-whitespace-boundary characters",
    );
  }
  return value;
}

export async function runRetentionRequeueFromEnvironment(input: {
  readonly arguments: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<RetentionRecoveryRecord> {
  const environment = input.environment ?? process.env;
  const request = parseRetentionRequeueArguments(input.arguments);
  const database = createDatabaseFromEnvironment(environment);
  try {
    await assertDatabaseReady(database, {
      requireRestoreAttestation: true,
      restoreEpoch: restoreEpoch(environment),
    });
    return await requeueRetentionDeadLetter({
      request,
      repository: {
        async requeueArtifact(item) {
          await requeueDeadLetteredPrivacyExportArtifactDeletion(database, item);
        },
        async requeueErasure(item) {
          await requeueDeadLetteredAccountErasureJob(database, item);
        },
        async requeueExport(item) {
          await requeueDeadLetteredPrivacyExportJob(database, item);
        },
        async requeueStagedArtifact(item) {
          await requeueDeadLetteredPrivacyExportStagedArtifactDeletion(database, item);
        },
      },
    });
  } finally {
    await database.destroy();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void runRetentionRequeueFromEnvironment({ arguments: process.argv.slice(2) })
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({ event: "retention.requeue.completed", kind: result.recoveryKind, level: "info" })}\n`,
      );
    })
    .catch((error: unknown) => {
      const errorType =
        error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
          ? error.name
          : "UnknownError";
      process.stderr.write(
        `${JSON.stringify({ event: "retention.requeue.failed", errorType, level: "fatal" })}\n`,
      );
      process.exitCode = 1;
    });
}
