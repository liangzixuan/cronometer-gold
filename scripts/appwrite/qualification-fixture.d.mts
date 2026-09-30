import type {
  BackendAdmission,
  JsonRecord,
  ManagedContext,
  ManagedDeployment,
  ManagedPolicy,
  QualificationBundle,
} from "../deployment/managed-evidence.mjs";
import type { OutputIdentity, QualificationContext, TargetConfig } from "./site-release.ts";
export declare const NOW: number;
export declare const OBSERVED: string;
export declare const REVIEWED: string;
export declare const SHA: string;
export declare const REVISION: string;
export type FixtureSignature = {
  deployedBy: string;
  reviewedBy: string;
  reviewedAt: string;
  reviewerAttestation: { keyId: string; algorithm: string; signatureBase64: string };
};
export type QualificationFixture = {
  trust: {
    schemaVersion: string;
    reviewers: {
      algorithm: string;
      keyId: string;
      principal: string;
      publicKeySpkiDerBase64: string;
      validFrom: string;
      validUntil: string;
    }[];
  };
  policy: ManagedPolicy;
  config: TargetConfig;
  signRecord: <T extends object>(input: T) => T & FixtureSignature;
  observe: (kind: string, details: unknown) => JsonRecord;
  backendReports: Record<string, JsonRecord>;
  backend: BackendAdmission & FixtureSignature;
  deployment: ManagedDeployment & FixtureSignature;
  runtimeReports: Record<string, JsonRecord>;
  captureReview: JsonRecord & FixtureSignature;
  bundle: QualificationBundle;
  expected: ManagedContext & { output: OutputIdentity };
  context: QualificationContext;
  activation: JsonRecord & FixtureSignature;
};
export function fixture(target?: "staging" | "production"): QualificationFixture;
