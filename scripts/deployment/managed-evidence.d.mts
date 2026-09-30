export declare const BACKEND_ADMISSION_SCHEMA: "nutrition-tracker-backend-admission-v1";
export declare const MANAGED_DEPLOYMENT_SCHEMA: "nutrition-tracker-release-deployment-v8";
export declare const QUALIFICATION_BUNDLE_SCHEMA: "nutrition-tracker-managed-qualification-bundle-v1";
export declare const CAPTURE_REVIEW_SCHEMA: "nutrition-tracker-browser-capture-review-v1";
export declare const MANAGED_PROFILE: "appwrite-cloud-azure-v1";
export declare const BACKEND_COMPONENTS: readonly string[];
export declare const EVIDENCE_LIMITS: Readonly<{
  bundleBytes: number;
  reportBytes: number;
  reviewMs: number;
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
  captureReview: JsonRecord;
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
export function loadReviewerTrustStore(): unknown;
export type ManagedPolicy = {
  schemaVersion: string;
  profile: string;
  approvedReviewSha256: string;
  endpoint: string;
  projectId: string;
  infrastructureTrust: string;
  observableRuntime: {
    node: string;
    openssl: string;
    opensslFixCommit: string;
    architectures: string[];
  };
  reviewMaximumAgeHours: number;
  observationMaximumAgeMinutes: number;
  applicationAccess: string;
  backendComponents: string[];
};
export function loadManagedPolicy(): ManagedPolicy;
export function policySha256(policy?: unknown): string;
export function validateBackendAdmission(
  bundle: QualificationBundle,
  expected: BackendContext,
  trustStore?: unknown,
  policy?: unknown,
): BackendAdmission;
export function validateManagedDeployment(
  bundle: QualificationBundle,
  expected: ManagedContext,
  trustStore?: unknown,
  policy?: unknown,
): ManagedDeployment;
export function validateCaptureReview(
  capture: unknown,
  expected: {
    sourceRevision: string;
    summarySha256: string;
    sessionId: string;
    runId: number;
    attempt: number;
    now: number;
  },
  trustStore?: unknown,
): unknown;
export function validateStagingIsolation(
  productionBackend: BackendAdmission,
  stagingBackend: BackendAdmission,
): void;
export function parseQualificationBundle(raw: string): QualificationBundle;
export function readQualificationBundle(path: string): QualificationBundle;
export function qualificationNonce(): string;
export declare const managedPolicyPath: string;

export declare const MANAGED_ACTIVATION_SCHEMA: "nutrition-tracker-managed-activation-v1";
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
  trustStore?: unknown,
): unknown;
