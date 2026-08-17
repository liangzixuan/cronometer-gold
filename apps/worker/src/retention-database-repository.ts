import {
  acknowledgeRetentionDeadLetterEvent,
  beginPrivacyExportStagedArtifactUpload,
  claimAccountErasureJobs,
  claimCancelledPrivacyExportStagedArtifacts,
  claimExpiredPrivacyExportArtifacts,
  claimPrivacyExportJobs,
  claimRetentionDeadLetterEvents,
  completePrivacyExportArtifactDeletion,
  completePrivacyExportJob,
  completePrivacyExportStagedArtifactDeletion,
  executeAccountErasureJob,
  failAccountErasureJob,
  failPrivacyExportArtifactDeletion,
  failPrivacyExportJob,
  failPrivacyExportStagedArtifactDeletion,
  getPrivacyExportJob,
  listAccountPrivacyExportArtifactsForErasure,
  markPrivacyExportStagedArtifactUploaded,
  renewPrivacyExportStagedArtifactUploadLease,
  renewRetentionWorkLease,
  stagePrivacyExportArtifacts,
  withPrivacyExportSnapshot,
  withUserRetentionSerialization,
} from "@nutrition-tracker/db";

import type {
  RetentionSerializedUserRepository,
  RetentionWorkerRepository,
} from "./retention-worker.js";

type RetentionDatabase = Parameters<typeof claimPrivacyExportJobs>[0];

function serializedRepository(database: RetentionDatabase): RetentionSerializedUserRepository {
  return {
    async executeAccountErasureJob(input) {
      await executeAccountErasureJob(database, input);
    },
    listAccountPrivacyExportArtifactsForErasure(input) {
      return listAccountPrivacyExportArtifactsForErasure(database, input);
    },
  };
}

/** Thin production adapter. Every method delegates to the DB's fenced, bounded port. */
export function createRetentionWorkerRepository(
  database: RetentionDatabase,
): RetentionWorkerRepository {
  return {
    async acknowledgeRetentionDeadLetterEvent(input) {
      await acknowledgeRetentionDeadLetterEvent(database, input);
    },
    beginPrivacyExportStagedArtifactUpload(input) {
      return beginPrivacyExportStagedArtifactUpload(database, input);
    },
    claimAccountErasureJobs(input) {
      return claimAccountErasureJobs(database, input);
    },
    claimCancelledPrivacyExportStagedArtifacts(input) {
      return claimCancelledPrivacyExportStagedArtifacts(database, input);
    },
    claimExpiredPrivacyExportArtifacts(input) {
      return claimExpiredPrivacyExportArtifacts(database, input);
    },
    claimPrivacyExportJobs(input) {
      return claimPrivacyExportJobs(database, input);
    },
    claimRetentionDeadLetterEvents(input) {
      return claimRetentionDeadLetterEvents(database, input);
    },
    async completePrivacyExportArtifactDeletion(input) {
      await completePrivacyExportArtifactDeletion(database, input);
    },
    async completePrivacyExportJob(input) {
      await completePrivacyExportJob(database, input);
    },
    async completePrivacyExportStagedArtifactDeletion(input) {
      await completePrivacyExportStagedArtifactDeletion(database, input);
    },
    async failAccountErasureJob(input) {
      return failAccountErasureJob(database, input);
    },
    async failPrivacyExportArtifactDeletion(input) {
      return failPrivacyExportArtifactDeletion(database, input);
    },
    async failPrivacyExportJob(input) {
      return failPrivacyExportJob(database, input);
    },
    async failPrivacyExportStagedArtifactDeletion(input) {
      return failPrivacyExportStagedArtifactDeletion(database, input);
    },
    getPrivacyExportJob(input) {
      return getPrivacyExportJob(database, input);
    },
    markPrivacyExportStagedArtifactUploaded(input) {
      return markPrivacyExportStagedArtifactUploaded(database, input);
    },
    async renewPrivacyExportStagedArtifactUploadLease(input) {
      await renewPrivacyExportStagedArtifactUploadLease(database, input);
    },
    async renewRetentionWorkLease(input) {
      await renewRetentionWorkLease(database, input);
    },
    stagePrivacyExportArtifacts(input) {
      return stagePrivacyExportArtifacts(database, input);
    },
    withPrivacyExportSnapshot(input, callback) {
      return withPrivacyExportSnapshot(database, input, callback);
    },
    withUserRetentionSerialization(input, callback) {
      return withUserRetentionSerialization(database, input, async (reservedDatabase) =>
        callback(serializedRepository(reservedDatabase)),
      );
    },
  };
}
