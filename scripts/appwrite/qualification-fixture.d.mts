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
export declare const RECORDED: string;
export declare const SHA: string;
export declare const REVISION: string;
export type FixtureRecord = {
  deployedBy: string;
  recordedAt: string;
};
export type QualificationFixture = {
  policy: ManagedPolicy;
  config: TargetConfig;
  recordEvidence: <T extends object>(input: T) => T & FixtureRecord;
  observe: (kind: string, details: unknown) => JsonRecord;
  backendReports: Record<string, JsonRecord>;
  backend: BackendAdmission & FixtureRecord;
  deployment: ManagedDeployment & FixtureRecord;
  runtimeReports: Record<string, JsonRecord>;
  captureObservation: JsonRecord & FixtureRecord;
  bundle: QualificationBundle;
  expected: ManagedContext & { output: OutputIdentity };
  context: QualificationContext;
  activation: JsonRecord & FixtureRecord;
};
export function fixture(target?: "staging" | "production"): QualificationFixture;
