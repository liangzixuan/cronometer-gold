export interface SourceIdentity {
  revision: string;
  tree: string;
  sourceManifestSha256: string;
}
export interface RuntimeObservation {
  schemaVersion: "nutrition-tracker-appwrite-runtime-observation-v1";
  phase: "build" | "ssr";
  sourceRevision: string;
  sourceTree: string;
  sourceManifestSha256: string;
  outputTreeSha256: string | null;
  provider: { endpoint: string; projectId: string; siteId: string; deploymentId: string } | null;
  observedAt: string;
  node: string;
  openssl: string;
  platform: string;
  architecture: string;
  libc: string;
  nativeInventory: { path: string; sha256: string }[];
  nonFileSharedObjects: string[];
  qualificationPerformed: false;
}
export function observeBuild(
  identity: SourceIdentity,
  env?: Readonly<Record<string, string | undefined>>,
): RuntimeObservation;
export function observeServer(
  env?: Readonly<Record<string, string | undefined>>,
): RuntimeObservation;
export function providerIdentity(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeObservation["provider"];

export function validateBuildObservation(value: unknown, identity: SourceIdentity): void;
