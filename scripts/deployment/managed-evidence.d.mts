export declare const BACKEND_ADMISSION_SCHEMA: "nutrition-tracker-backend-admission-v2";
export declare const MANAGED_DEPLOYMENT_SCHEMA: "nutrition-tracker-release-deployment-v9";
export declare const QUALIFICATION_BUNDLE_SCHEMA: "nutrition-tracker-managed-qualification-bundle-v2";
export declare const CAPTURE_OBSERVATION_SCHEMA: "nutrition-tracker-browser-capture-observation-v1";
export declare const MANAGED_PROFILE: "appwrite-cloud-azure-v1";
export declare const BACKEND_COMPONENTS: readonly string[];
export declare const EVIDENCE_LIMITS: Readonly<{
  bundleBytes: number;
  reportBytes: number;
  recordMs: number;
  observationMs: number;
  futureSkewMs: number;
}>;
export type JsonRecord = Record<string, unknown>;
export type BackendAdmission = JsonRecord & {
  schemaVersion: typeof BACKEND_ADMISSION_SCHEMA;
  profile: typeof MANAGED_PROFILE;
  target: "staging" | "production";
  apiOrigin: string;
  sourceRevision: string;
  configurationSha256: string;
  policySha256: string;
  host: JsonRecord;
  images: Record<string, string>;
  isolation: {
    databaseSha256: string;
    searchNamespaceSha256: string;
    storagePrincipalSha256: string;
    dataScope: string;
  };
  reports: Record<string, string>;
};
export type ManagedDeployment = JsonRecord & {
  schemaVersion: typeof MANAGED_DEPLOYMENT_SCHEMA;
  sourceRevision: string;
  web: {
    endpoint: string;
    projectId: string;
    siteId: string;
    deploymentId: string;
    webOrigin: string;
    sourceArchiveSha256: string;
    output: JsonRecord;
  };
};
export type QualificationBundle = {
  schemaVersion: typeof QUALIFICATION_BUNDLE_SCHEMA;
  backend: BackendAdmission;
  backendReports: Record<string, JsonRecord>;
  deployment: ManagedDeployment | null;
  runtimeReports: Record<string, JsonRecord> | null;
  captureObservation: JsonRecord;
  staging: QualificationBundle | null;
};
export type BackendContext = {
  target: "staging" | "production";
  apiOrigin: string;
  sourceRevision: string;
  configurationSha256: string;
  now: number;
};
export type ManagedContext = BackendContext & {
  webOrigin: string;
  siteId: string;
  deploymentId: string;
  output: unknown;
  sourceArchiveSha256?: string;
};
export class QualificationEvidenceError extends Error {
  code: string;
  constructor(code: string);
}
export function canonicalEvidence(value: unknown): string;
export function evidenceSha256(value: unknown): string;
export function configurationSha256(value: unknown): string;
export type ManagedPolicy = {
  schemaVersion: string;
  profile: string;
  endpoint: string;
  projectId: string;
  infrastructureTrust: string;
  observableRuntime: {
    node: string;
    openssl: string;
    opensslFixCommit: string;
    architectures: string[];
  };
  recordMaximumAgeHours: number;
  observationMaximumAgeMinutes: number;
  applicationAccess: string;
  backendComponents: string[];
};
export function loadManagedPolicy(): ManagedPolicy;
export function policySha256(policy?: unknown): string;
export function validateBackendAdmission(
  bundle: QualificationBundle,
  expected: BackendContext,
  policy?: unknown,
): BackendAdmission;
export function validateManagedDeployment(
  bundle: QualificationBundle,
  expected: ManagedContext,
  policy?: unknown,
): ManagedDeployment;
export function validateCaptureObservation(
  capture: unknown,
  expected: {
    sourceRevision: string;
    summarySha256: string;
    sessionId: string;
    runId: number;
    attempt: number;
    now: number;
  },
): unknown;
export function validateStagingIsolation(
  productionBackend: BackendAdmission,
  stagingBackend: BackendAdmission,
): void;
export function parseQualificationBundle(raw: string): QualificationBundle;
export function readQualificationBundle(path: string): QualificationBundle;
export function qualificationNonce(): string;
export declare const managedPolicyPath: string;

export declare const MANAGED_ACTIVATION_SCHEMA: "nutrition-tracker-managed-activation-v2";
export function validateManagedActivation(
  activation: unknown,
  expected: {
    deploymentSha256: string;
    sourceRevision: string;
    apiOrigin: string;
    siteId: string;
    deploymentId: string;
    now: number;
  },
): unknown;
