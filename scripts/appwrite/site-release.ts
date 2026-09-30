import { closeSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, DeploymentDownloadType, Sites } from "node-appwrite";
import { InputFile } from "node-appwrite/file";
import { Agent, DecoratorHandler, type Dispatcher } from "undici";
import { collectGitHubEvidence, validateGitHubEvidence } from "./github-checks.ts";
import { configurationSha256, createQualificationVerifier } from "./qualification.ts";
import {
  canonical,
  parseArgs,
  readTarGzip,
  SOURCE_LIMITS,
  type SourceArtifact,
  safePath,
  sha256,
  verifySourceArtifact,
} from "./source-artifact.ts";

export const APPWRITE_TARGET = {
  endpoint: "https://nyc.cloud.appwrite.io/v1",
  projectId: "6abac02e002f10c31ac2",
} as const;
export const SITE_COMMANDS = {
  installCommand: "corepack pnpm@11.19.0 install --frozen-lockfile --ignore-scripts",
  buildCommand:
    "corepack pnpm@11.19.0 exec turbo run build --filter=@nutrition-tracker/web... --force && node scripts/appwrite/pack-site.mjs --source-root . --output appwrite-output",
  startCommand: "node start-site.cjs",
  outputDirectory: "appwrite-output",
} as const;
export const RELEASE_LIMITS = {
  requestMs: 30_000,
  uploadMs: 60_000,
  totalMs: 15 * 60_000,
  requests: 160,
  polls: 60,
  pollMs: 5_000,
  outputArchiveBytes: 128 * 1024 * 1024,
  outputBytes: 512 * 1024 * 1024,
  outputFiles: 20_000,
} as const;
type TargetName = "staging" | "production";
export type TargetConfig = {
  target: TargetName;
  siteId: string;
  otherSiteId: string;
  webOrigin: string;
  apiOrigin: string;
  buildSpecification: string;
  runtimeSpecification: string;
};
export type SiteRecord = {
  $id: string;
  enabled: boolean;
  framework: string;
  adapter: string;
  buildRuntime: string;
  deploymentId: string;
  deploymentRetention: number;
  scopes: string[];
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  outputDirectory: string;
  installationId: string;
  providerRepositoryId: string;
  buildSpecification: string;
  runtimeSpecification: string;
  vars: { key: string; value: string }[];
};
export type DeploymentRecord = {
  $id: string;
  resourceId: string;
  resourceType: string;
  status: string;
  activate: boolean;
  sourceSize: number;
};
export type OutputIdentity = {
  revision: string;
  tree: string;
  sourceManifestSha256: string;
  buildId: string;
  outputTreeSha256: string;
  outputArchiveSha256: string;
};
export type ReleaseReceipt = {
  schemaVersion: 2;
  operation: "prepare" | "activate";
  status: "candidate-prepared" | "activated" | "failed";
  configSha256: string;
  activationOutcome:
    | "not-attempted"
    | "confirmed-candidate"
    | "confirmed-previous"
    | "confirmed-other"
    | "unknown";
  target: TargetName | "invalid";
  revision: string;
  tree: string;
  sourceArchiveSha256: string;
  sourceManifestSha256: string;
  siteId: string;
  previousDeploymentId: string | null;
  uploadedDeploymentId: string | null;
  activeDeploymentId: string | null;
  output: OutputIdentity | null;
  phase: string;
  failure: string | null;
  cleanupFailure: "transport_cleanup_failed" | null;
  completedAt: string;
};
export class ReleaseError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ReleaseError";
  }
}
function reject(code: string): never {
  throw new ReleaseError(code);
}
const isId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(value);
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function exactHttpsOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject("invalid_target_origin");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.port ||
    /(^|\.)(localhost|local|internal|invalid|test)$/.test(url.hostname) ||
    /^\d+(\.\d+){3}$/.test(url.hostname) ||
    url.hostname.includes(":")
  )
    reject("invalid_target_origin");
  return value;
}
export function validateTarget(config: TargetConfig) {
  if (
    !["staging", "production"].includes(config.target) ||
    !isId(config.siteId) ||
    !isId(config.otherSiteId) ||
    config.siteId === config.otherSiteId ||
    !/^s-[a-z0-9-]+$/.test(config.buildSpecification) ||
    !/^s-[a-z0-9-]+$/.test(config.runtimeSpecification)
  )
    reject("invalid_target_configuration");
  exactHttpsOrigin(config.webOrigin);
  exactHttpsOrigin(config.apiOrigin);
  if (config.webOrigin === config.apiOrigin) reject("backend_origin_must_be_distinct");
}
export function validateSite(site: SiteRecord, config: TargetConfig) {
  if (
    site.$id !== config.siteId ||
    site.enabled !== true ||
    site.framework !== "nextjs" ||
    site.adapter !== "ssr" ||
    site.buildRuntime !== "node-22" ||
    site.installationId !== "" ||
    site.providerRepositoryId !== "" ||
    !Array.isArray(site.scopes) ||
    site.scopes.length ||
    site.deploymentRetention !== 0 ||
    site.buildSpecification !== config.buildSpecification ||
    site.runtimeSpecification !== config.runtimeSpecification ||
    (site.deploymentId !== "" && !isId(site.deploymentId))
  )
    reject("site_configuration_mismatch");
  for (const [key, value] of Object.entries(SITE_COMMANDS))
    if (site[key as keyof SiteRecord] !== value) reject("site_command_mismatch");
  if (!Array.isArray(site.vars)) reject("site_environment_mismatch");
  for (const [key, expected] of Object.entries({
    WEB_PUBLIC_ORIGIN: config.webOrigin,
    API_INTERNAL_URL: config.apiOrigin,
    NODE_ENV: "production",
  })) {
    const vars = site.vars.filter((item) => item.key === key);
    if (vars.length !== 1 || vars[0]?.value !== expected) reject("site_environment_mismatch");
  }
}
function validateDeployment(deployment: DeploymentRecord, siteId: string, deploymentId?: string) {
  if (
    !isId(deployment.$id) ||
    (deploymentId && deployment.$id !== deploymentId) ||
    deployment.resourceId !== siteId ||
    deployment.resourceType !== "sites" ||
    deployment.activate !== false ||
    !["waiting", "processing", "building", "ready", "failed", "canceled"].includes(
      deployment.status,
    )
  )
    reject("deployment_identity_mismatch");
}
export function verifyOutputArchive(archive: Buffer, source: SourceArtifact): OutputIdentity {
  const entries = readTarGzip(archive, {
    archiveBytes: RELEASE_LIMITS.outputArchiveBytes,
    totalBytes: RELEASE_LIMITS.outputBytes,
    files: RELEASE_LIMITS.outputFiles,
  });
  const files = new Map(
    entries.filter((entry) => entry.type !== "directory").map((entry) => [entry.path, entry]),
  );
  const manifestEntry = files.get("output-manifest.json");
  if (manifestEntry?.type !== "file" || manifestEntry.data.length > 8 * 1024 * 1024)
    reject("output_manifest_missing");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestEntry.data.toString());
  } catch {
    return reject("output_manifest_invalid");
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.revision !== source.revision ||
    manifest.tree !== source.tree ||
    manifest.sourceManifestSha256 !== source.manifestSha256 ||
    manifest.entrypoint !== "start-site.cjs" ||
    manifest.payloadEntrypoint !== "payload/apps/web/server.js" ||
    typeof manifest.buildId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(manifest.buildId) ||
    !Array.isArray(manifest.files) ||
    !isHash(manifest.outputTreeSha256) ||
    sha256(JSON.stringify(manifest.files)) !== manifest.outputTreeSha256
  )
    reject("output_identity_mismatch");
  let previous = "";
  const expected = new Set(["output-manifest.json"]);
  for (const value of manifest.files) {
    const row = value as {
      path: string;
      type: string;
      mode: string;
      size: number;
      sha256: string;
      target?: string;
    };
    safePath(row.path);
    if (
      row.path <= previous ||
      expected.has(row.path) ||
      !isHash(row.sha256) ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0
    )
      reject("output_entry_invalid");
    previous = row.path;
    expected.add(row.path);
    const entry = files.get(row.path);
    if (!entry || entry.type !== row.type) reject("output_file_mismatch");
    if (row.type === "file") {
      if (
        !["100644", "100755"].includes(row.mode) ||
        entry.mode !== (row.mode === "100755" ? 0o755 : 0o644) ||
        entry.data.length !== row.size ||
        sha256(entry.data) !== row.sha256
      )
        reject("output_file_mismatch");
    } else if (row.type === "symlink") {
      if (
        row.mode !== "120000" ||
        !row.target ||
        row.target.startsWith("/") ||
        entry.target !== row.target ||
        Buffer.byteLength(row.target) !== row.size ||
        sha256(row.target) !== row.sha256 ||
        row.target.includes("\\")
      )
        reject("output_symlink_mismatch");
      let resolved = posix.normalize(posix.join(posix.dirname(row.path), row.target));
      const seen = new Set([row.path]);
      while (true) {
        if (resolved === ".." || resolved.startsWith("../") || seen.has(resolved))
          reject("output_symlink_escape_or_cycle");
        seen.add(resolved);
        const target = files.get(resolved);
        if (target?.type === "symlink") {
          resolved = posix.normalize(posix.join(posix.dirname(resolved), target.target as string));
          continue;
        }
        if (
          !target &&
          !entries.some((item) => item.path === resolved || item.path.startsWith(`${resolved}/`))
        )
          reject("output_symlink_broken");
        break;
      }
    } else reject("output_entry_invalid");
  }
  for (const path of files.keys())
    if (
      !expected.has(path) &&
      !(
        path === ".open-runtimes" &&
        files.get(path)?.type === "file" &&
        [0o644, 0o755].includes(files.get(path)?.mode ?? -1) &&
        (files.get(path)?.data.length ?? Infinity) <= 4096
      )
    )
      reject("output_unexpected_file");
  const launcher = files.get("start-site.cjs");
  const expectedLauncher = source.files.find(
    (file) => file.path === "scripts/appwrite/start-site.cjs",
  );
  const server = files.get("payload/apps/web/server.js");
  const buildId = files.get("payload/apps/web/.next/BUILD_ID");
  if (
    launcher?.type !== "file" ||
    !expectedLauncher ||
    sha256(launcher.data) !== expectedLauncher.sha256 ||
    !server ||
    server.type !== "file" ||
    !buildId ||
    buildId.type !== "file" ||
    buildId.data.toString().trim() !== manifest.buildId ||
    ![...files.keys()].some((path) => path.startsWith("payload/apps/web/.next/static/"))
  )
    reject("output_required_file_mismatch");
  for (const file of source.files.filter((file) => file.path.startsWith("apps/web/public/"))) {
    const asset = files.get(`payload/${file.path}`);
    if (asset?.type !== "file" || sha256(asset.data) !== file.sha256)
      reject("output_public_asset_mismatch");
  }
  return {
    revision: source.revision,
    tree: source.tree,
    sourceManifestSha256: source.manifestSha256,
    buildId: manifest.buildId,
    outputTreeSha256: manifest.outputTreeSha256,
    outputArchiveSha256: sha256(archive),
  };
}
export interface SitesPort {
  getSite(siteId: string): Promise<SiteRecord>;
  createDeployment(
    siteId: string,
    archive: Buffer,
    progress: (deploymentId: string) => void,
  ): Promise<DeploymentRecord>;
  getDeployment(siteId: string, deploymentId: string): Promise<DeploymentRecord>;
  download(siteId: string, deploymentId: string, type: "source" | "output"): Promise<Buffer>;
  activate(siteId: string, deploymentId: string): Promise<SiteRecord>;
  close(): Promise<void>;
}
export type QualificationContext = {
  config: TargetConfig;
  source: SourceArtifact;
  githubEvidence: unknown;
  deploymentId?: string;
  output?: OutputIdentity;
  site?: SiteRecord;
  deployment?: DeploymentRecord;
  staging?: {
    config: TargetConfig;
    site: SiteRecord;
    deployment: DeploymentRecord;
    output: OutputIdentity;
  };
};
export interface QualificationVerifier {
  beforeUpload(context: QualificationContext): Promise<void>;
  beforeActivation(context: QualificationContext): Promise<void>;
  verifyStaging(receipt: ReleaseReceipt, context: QualificationContext): Promise<void>;
}
function sameOutput(actual: OutputIdentity, expected: OutputIdentity | null) {
  return (
    expected !== null &&
    Object.entries(actual).every(([key, value]) => expected[key as keyof OutputIdentity] === value)
  );
}
function receiptSourceMatches(receipt: ReleaseReceipt, source: SourceArtifact) {
  return (
    receipt.revision === source.revision &&
    receipt.tree === source.tree &&
    receipt.sourceArchiveSha256 === source.archiveSha256 &&
    receipt.sourceManifestSha256 === source.manifestSha256
  );
}
export function validateStaging(
  receipt: ReleaseReceipt | undefined,
  source: SourceArtifact,
  config: TargetConfig,
) {
  if (
    receipt?.schemaVersion !== 2 ||
    receipt.operation !== "activate" ||
    receipt.status !== "activated" ||
    receipt.activationOutcome !== "confirmed-candidate" ||
    receipt.failure !== null ||
    receipt.cleanupFailure !== null ||
    receipt.target !== "staging" ||
    receipt.siteId !== config.otherSiteId ||
    !receiptSourceMatches(receipt, source) ||
    !receipt.output ||
    receipt.uploadedDeploymentId !== receipt.activeDeploymentId ||
    !isId(receipt.activeDeploymentId)
  )
    reject("staging_acceptance_missing_or_mismatched");
}
function validateCandidate(
  receipt: ReleaseReceipt | undefined,
  source: SourceArtifact,
  config: TargetConfig,
) {
  if (
    receipt?.schemaVersion !== 2 ||
    receipt.operation !== "prepare" ||
    receipt.status !== "candidate-prepared" ||
    receipt.activationOutcome !== "not-attempted" ||
    receipt.failure !== null ||
    receipt.cleanupFailure !== null ||
    receipt.target !== config.target ||
    receipt.siteId !== config.siteId ||
    receipt.configSha256 !== configurationSha256(config) ||
    !receiptSourceMatches(receipt, source) ||
    !receipt.output ||
    !isId(receipt.uploadedDeploymentId) ||
    (receipt.previousDeploymentId !== null && !isId(receipt.previousDeploymentId)) ||
    receipt.activeDeploymentId !== receipt.previousDeploymentId ||
    receipt.uploadedDeploymentId === receipt.activeDeploymentId
  )
    reject("candidate_receipt_mismatch");
}
export type ReleaseOptions = {
  config: TargetConfig;
  source: SourceArtifact;
  archive: Buffer;
  githubEvidence: unknown;
  qualification: QualificationVerifier;
  // Production CLI always collects and validates current GitHub state here.
  // Tests may inject an offline authority; a saved input is never live authority.
  verifyGitHub: (
    value: unknown,
    expected: { revision: string; tree: string; lockfileSha256: string; target: TargetName },
  ) => Promise<unknown> | unknown;
  createPort: () => SitesPort;
  createStagingPort?: (() => SitesPort) | undefined;
  candidateReceipt?: ReleaseReceipt | undefined;
  stagingConfig?: TargetConfig | undefined;
  stagingReceipt?: ReleaseReceipt | undefined;
  saveReceipt: (receipt: ReleaseReceipt) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};
export const prepareSite = (options: ReleaseOptions) => runSite("prepare", options);
export const activateSite = (options: ReleaseOptions) => runSite("activate", options);
async function runSite(
  operation: "prepare" | "activate",
  options: ReleaseOptions,
): Promise<ReleaseReceipt> {
  const { config, source } = options;
  const now = options.now ?? Date.now;
  const started = now();
  const receipt: ReleaseReceipt = {
    schemaVersion: 2,
    operation,
    status: "failed",
    configSha256: "",
    activationOutcome: "not-attempted",
    target: ["staging", "production"].includes(config.target) ? config.target : "invalid",
    revision: "",
    tree: "",
    sourceArchiveSha256: "",
    sourceManifestSha256: "",
    siteId: "",
    previousDeploymentId: null,
    uploadedDeploymentId: null,
    activeDeploymentId: null,
    output: null,
    phase: "admission",
    failure: null,
    cleanupFailure: null,
    completedAt: "",
  };
  let port: SitesPort | undefined;
  let stagingPort: SitesPort | undefined;
  let activationAttempted = false;
  const deadline = () => {
    if (now() - started >= RELEASE_LIMITS.totalMs) reject("release_deadline");
  };
  async function previousReady(site: SiteRecord) {
    if (!site.deploymentId) return;
    deadline();
    const previous = await (port as SitesPort).getDeployment(config.siteId, site.deploymentId);
    if (
      previous.$id !== site.deploymentId ||
      previous.resourceId !== config.siteId ||
      previous.resourceType !== "sites" ||
      previous.status !== "ready"
    )
      reject("rollback_deployment_unavailable");
  }
  async function artifacts(selectedPort: SitesPort, siteId: string, deploymentId: string) {
    deadline();
    const remoteSource = await selectedPort.download(siteId, deploymentId, "source");
    if (
      remoteSource.length !== source.archiveBytes ||
      sha256(remoteSource) !== source.archiveSha256
    )
      reject("uploaded_source_identity_mismatch");
    deadline();
    return verifyOutputArchive(await selectedPort.download(siteId, deploymentId, "output"), source);
  }
  async function observeStaging(context: QualificationContext) {
    if (config.target !== "production") return;
    const stagingConfig = options.stagingConfig;
    validateStaging(options.stagingReceipt, source, config);
    if (!stagingConfig || !options.createStagingPort) reject("staging_configuration_missing");
    validateTarget(stagingConfig);
    if (
      stagingConfig.target !== "staging" ||
      stagingConfig.siteId !== config.otherSiteId ||
      stagingConfig.otherSiteId !== config.siteId ||
      stagingConfig.webOrigin === config.webOrigin ||
      stagingConfig.apiOrigin === config.apiOrigin ||
      options.stagingReceipt?.configSha256 !== configurationSha256(stagingConfig)
    )
      reject("staging_configuration_mismatch");
    deadline();
    stagingPort ??= options.createStagingPort();
    const site = await stagingPort.getSite(stagingConfig.siteId);
    validateSite(site, stagingConfig);
    if (site.deploymentId !== options.stagingReceipt?.activeDeploymentId)
      reject("staging_active_deployment_changed");
    deadline();
    const deployment = await stagingPort.getDeployment(stagingConfig.siteId, site.deploymentId);
    validateDeployment(deployment, stagingConfig.siteId, site.deploymentId);
    if (deployment.status !== "ready" || deployment.sourceSize !== source.archiveBytes)
      reject("staging_deployment_not_ready");
    const output = await artifacts(stagingPort, stagingConfig.siteId, deployment.$id);
    if (!sameOutput(output, (options.stagingReceipt as ReleaseReceipt).output))
      reject("staging_output_changed");
    context.staging = { config: stagingConfig, site, deployment, output };
    await options.qualification.verifyStaging(options.stagingReceipt as ReleaseReceipt, context);
    deadline();
    const confirmed = await stagingPort.getSite(stagingConfig.siteId);
    validateSite(confirmed, stagingConfig);
    if (confirmed.deploymentId !== deployment.$id) reject("staging_active_deployment_changed");
  }
  try {
    validateTarget(config);
    verifySourceArtifact(source, options.archive);
    Object.assign(receipt, {
      revision: source.revision,
      tree: source.tree,
      sourceArchiveSha256: source.archiveSha256,
      sourceManifestSha256: source.manifestSha256,
      siteId: config.siteId,
      configSha256: configurationSha256(config),
    });
    if (operation === "activate") validateCandidate(options.candidateReceipt, source, config);
    const lockfile = source.files.find((file) => file.path === "pnpm-lock.yaml");
    if (!lockfile) reject("source_lockfile_missing");
    const githubExpected = {
      revision: source.revision,
      tree: source.tree,
      lockfileSha256: lockfile.sha256,
      target: config.target,
    };
    const context: QualificationContext = {
      config,
      source,
      githubEvidence: await options.verifyGitHub(options.githubEvidence, githubExpected),
    };
    await options.qualification.beforeUpload(context);
    if (operation === "prepare") await observeStaging(context);
    deadline();
    port = options.createPort();
    receipt.phase = "site_preflight";
    const site = await port.getSite(config.siteId);
    validateSite(site, config);
    receipt.previousDeploymentId = site.deploymentId || null;
    receipt.activeDeploymentId = receipt.previousDeploymentId;
    await previousReady(site);
    let deployment: DeploymentRecord;
    if (operation === "prepare") {
      deadline();
      receipt.phase = "upload";
      deployment = await port.createDeployment(config.siteId, options.archive, (id) => {
        if (!isId(id)) reject("upload_identity_invalid");
        if (receipt.uploadedDeploymentId && receipt.uploadedDeploymentId !== id)
          reject("upload_identity_changed");
        receipt.uploadedDeploymentId = id;
      });
      validateDeployment(deployment, config.siteId, receipt.uploadedDeploymentId ?? undefined);
      receipt.uploadedDeploymentId = deployment.$id;
      if (deployment.$id === site.deploymentId) reject("candidate_already_active");
      if (deployment.sourceSize !== source.archiveBytes) reject("uploaded_source_size_mismatch");
      receipt.phase = "readiness";
      for (let attempt = 0; deployment.status !== "ready"; attempt++) {
        if (["failed", "canceled"].includes(deployment.status)) reject("deployment_build_failed");
        if (attempt >= RELEASE_LIMITS.polls) reject("deployment_readiness_timeout");
        deadline();
        await (options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))))(
          RELEASE_LIMITS.pollMs,
        );
        deadline();
        deployment = await port.getDeployment(config.siteId, receipt.uploadedDeploymentId);
        validateDeployment(deployment, config.siteId, receipt.uploadedDeploymentId);
      }
    } else {
      const candidate = options.candidateReceipt as ReleaseReceipt;
      if (receipt.previousDeploymentId !== candidate.previousDeploymentId)
        reject("active_deployment_changed");
      receipt.uploadedDeploymentId = candidate.uploadedDeploymentId;
      deadline();
      deployment = await port.getDeployment(
        config.siteId,
        candidate.uploadedDeploymentId as string,
      );
      validateDeployment(deployment, config.siteId, candidate.uploadedDeploymentId as string);
      if (deployment.status !== "ready" || deployment.sourceSize !== source.archiveBytes)
        reject("candidate_deployment_not_ready");
    }
    receipt.phase = "artifact_verification";
    receipt.output = await artifacts(port, config.siteId, deployment.$id);
    if (
      operation === "activate" &&
      !sameOutput(receipt.output, (options.candidateReceipt as ReleaseReceipt).output)
    )
      reject("candidate_output_changed");
    Object.assign(context, {
      site,
      deployment,
      deploymentId: deployment.$id,
      output: receipt.output,
    });
    if (operation === "activate") {
      receipt.phase = "hosted_qualification";
      // Recollect source/CI/approval state for this phase, then bind every signed
      // prerequisite to that verified response rather than the supplied JSON.
      deadline();
      context.githubEvidence = await options.verifyGitHub(options.githubEvidence, githubExpected);
      await options.qualification.beforeUpload(context);
      await options.qualification.beforeActivation(context);
      await observeStaging(context);
    }
    deadline();
    const current = await port.getSite(config.siteId);
    validateSite(current, config);
    if (current.deploymentId !== (receipt.previousDeploymentId ?? ""))
      reject("active_deployment_changed");
    if (operation === "prepare") {
      deadline();
      receipt.status = "candidate-prepared";
    } else {
      await previousReady(current);
      deadline();
      receipt.phase = "activation";
      activationAttempted = true;
      receipt.activationOutcome = "unknown";
      const activated = await port.activate(config.siteId, deployment.$id);
      validateSite(activated, config);
      if (activated.deploymentId !== deployment.$id) reject("activation_response_mismatch");
      deadline();
      const confirmed = await port.getSite(config.siteId);
      validateSite(confirmed, config);
      if (confirmed.deploymentId !== deployment.$id) reject("activation_confirmation_mismatch");
      receipt.activeDeploymentId = confirmed.deploymentId;
      receipt.activationOutcome = "confirmed-candidate";
      deadline();
      receipt.status = "activated";
    }
    receipt.phase = "complete";
  } catch (error) {
    receipt.failure =
      error instanceof ReleaseError && /^[a-z][a-z0-9_]{0,79}$/.test(error.code)
        ? error.code
        : "release_step_failed";
    if (activationAttempted && port) {
      // A timed-out PATCH may already have changed the provider. One read can
      // establish observed state; it never retries activation or rolls back.
      try {
        deadline();
        const observed = await port.getSite(config.siteId);
        validateSite(observed, config);
        receipt.activeDeploymentId = observed.deploymentId || null;
        receipt.activationOutcome =
          observed.deploymentId === receipt.uploadedDeploymentId
            ? "confirmed-candidate"
            : (observed.deploymentId || null) === receipt.previousDeploymentId
              ? "confirmed-previous"
              : "confirmed-other";
      } catch {
        receipt.activeDeploymentId = null;
        receipt.activationOutcome = "unknown";
      }
    }
  } finally {
    for (const opened of [port, stagingPort]) {
      try {
        await opened?.close();
      } catch {
        receipt.status = "failed";
        receipt.cleanupFailure = "transport_cleanup_failed";
        receipt.failure ??= "transport_cleanup_failed";
      }
    }
    receipt.completedAt = new Date(now()).toISOString();
    options.saveReceipt(receipt);
  }
  return receipt;
}
export type ProviderBudget = { requests: number; deadlineAt: number };
export function createSitesPort(
  config: TargetConfig,
  key: string,
  dispatcher?: Dispatcher,
  policy: { readOnly?: boolean; budget?: ProviderBudget } = {},
): SitesPort {
  validateTarget(config);
  if (!key || key.length > 4096 || /\s/.test(key)) reject("deployment_key_missing_or_invalid");
  const budget = policy.budget ?? { requests: 0, deadlineAt: Date.now() + RELEASE_LIMITS.totalMs };
  if (budget.deadlineAt <= Date.now()) reject("provider_request_limit_or_deadline");
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(),
    Math.min(RELEASE_LIMITS.totalMs, budget.deadlineAt - Date.now()),
  );
  timer.unref();
  const jsonAgent =
    dispatcher ??
    new Agent({
      connections: 8,
      pipelining: 0,
      connectTimeout: 10_000,
      headersTimeout: 30_000,
      bodyTimeout: 15_000,
      maxResponseSize: 1024 * 1024,
    });
  const downloadAgent =
    dispatcher ??
    new Agent({
      connections: 1,
      pipelining: 0,
      connectTimeout: 10_000,
      headersTimeout: 30_000,
      bodyTimeout: 15_000,
      maxResponseSize: RELEASE_LIMITS.outputArchiveBytes,
    });
  let closed = false;
  class BoundedClient extends Client {
    override prepareRequest(
      method: string,
      url: URL,
      headers: Parameters<Client["prepareRequest"]>[2] = {},
      params: Parameters<Client["prepareRequest"]>[3] = {},
    ) {
      method = method.toUpperCase();
      const base = `/v1/sites/${config.siteId}`;
      const tail = url.pathname.slice(base.length);
      const upload = method === "POST" && tail === "/deployments";
      const download =
        method === "GET" &&
        /^\/deployments\/[A-Za-z0-9._-]+\/download$/.test(tail) &&
        ["source", "output"].includes(String(params.type));
      const allowed =
        (method === "GET" && tail === "") ||
        upload ||
        download ||
        (method === "GET" && /^\/deployments\/[A-Za-z0-9._-]+$/.test(tail)) ||
        (method === "PATCH" && tail === "/deployment" && isId(params.deploymentId));
      if (closed || deadline.signal.aborted) reject("provider_request_limit_or_deadline");
      if (
        url.origin !== "https://nyc.cloud.appwrite.io" ||
        !url.pathname.startsWith(base) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !allowed ||
        (policy.readOnly && method !== "GET") ||
        this.config.endpoint !== APPWRITE_TARGET.endpoint ||
        this.config.project !== APPWRITE_TARGET.projectId ||
        this.config.selfSigned
      )
        reject("provider_target_rejected");
      if (
        upload &&
        (params.activate !== false ||
          params.installCommand !== SITE_COMMANDS.installCommand ||
          params.buildCommand !== SITE_COMMANDS.buildCommand ||
          params.outputDirectory !== SITE_COMMANDS.outputDirectory)
      )
        reject("provider_upload_parameters_rejected");
      const prepared = super.prepareRequest(method, url, headers, params);
      const responsePolicy = new AbortController();
      prepared.options.signal = AbortSignal.any([
        deadline.signal,
        responsePolicy.signal,
        AbortSignal.timeout(
          upload || download ? RELEASE_LIMITS.uploadMs : RELEASE_LIMITS.requestMs,
        ),
      ]);
      prepared.options.redirect = "error";
      const maximum = download ? RELEASE_LIMITS.outputArchiveBytes : 1024 * 1024;
      prepared.options.dispatcher = (download ? downloadAgent : jsonAgent).compose(
        (dispatch) => (input, handler) => {
          if (
            closed ||
            deadline.signal.aborted ||
            Date.now() >= budget.deadlineAt ||
            ++budget.requests > RELEASE_LIMITS.requests
          )
            reject("provider_request_limit_or_deadline");
          if (input.origin?.toString() !== url.origin || !input.path.startsWith(url.pathname))
            reject("provider_target_rejected");
          let bytes = 0;
          let rejected = false;
          const abortResponse = () => {
            if (!rejected) {
              rejected = true;
              queueMicrotask(() => responsePolicy.abort());
            }
            return false;
          };
          const wrapped: Dispatcher.DispatchHandlers = new DecoratorHandler(handler);
          wrapped.onHeaders = (status, responseHeaders, resume, statusText) => {
            if ((status >= 300 && status < 400) || status === 421) {
              return abortResponse();
            }
            const filtered: Buffer[] = [];
            let json = false;
            for (let index = 0; index < responseHeaders.length; index += 2) {
              const name = responseHeaders[index];
              const value = responseHeaders[index + 1];
              if (!name || !value) {
                return abortResponse();
              }
              const key = name.toString().toLowerCase();
              const text = value.toString();
              if (
                (key === "content-encoding" && text.trim().toLowerCase() !== "identity") ||
                (key === "content-length" &&
                  (!/^(?:0|[1-9]\d*)$/.test(text) || Number(text) > maximum))
              ) {
                return abortResponse();
              }
              if (key === "content-type") json = /^application\/json(?:\s*;|$)/i.test(text);
              if (key !== "x-appwrite-warning") filtered.push(name, value);
            }
            if (!download && !json) {
              return abortResponse();
            }
            return handler.onHeaders?.(status, filtered, resume, statusText) ?? true;
          };
          wrapped.onData = (chunk) => {
            if (rejected) return false;
            bytes += chunk.byteLength;
            if (bytes > maximum) {
              return abortResponse();
            }
            return handler.onData?.(chunk) ?? true;
          };
          return dispatch({ ...input, idempotent: false }, wrapped);
        },
      );
      prepared.options.headers = { ...prepared.options.headers, "accept-encoding": "identity" };
      return prepared;
    }
    override async call(
      method: string,
      url: URL,
      headers: Parameters<Client["call"]>[2] = {},
      params: Parameters<Client["call"]>[3] = {},
      responseType = "json",
    ): Promise<unknown> {
      try {
        return await super.call(method, url, headers, params, responseType);
      } catch (error) {
        if (error instanceof ReleaseError) throw error;
        return reject("provider_request_failed");
      }
    }
  }
  const sdk = new Sites(
    new BoundedClient()
      .setEndpoint(APPWRITE_TARGET.endpoint)
      .setProject(APPWRITE_TARGET.projectId)
      .setKey(key),
  );
  return {
    getSite: async (siteId) => sdk.get({ siteId }) as unknown as SiteRecord,
    createDeployment: async (siteId, archive, progress) => {
      if (archive.length > SOURCE_LIMITS.archiveBytes) reject("upload_archive_limit");
      return sdk.createDeployment({
        siteId,
        code: InputFile.fromBuffer(archive, "source.tar.gz"),
        ...{
          installCommand: SITE_COMMANDS.installCommand,
          buildCommand: SITE_COMMANDS.buildCommand,
          outputDirectory: SITE_COMMANDS.outputDirectory,
        },
        activate: false,
        onProgress: (value) => {
          if (value.$id) progress(value.$id);
        },
      }) as unknown as DeploymentRecord;
    },
    getDeployment: async (siteId, deploymentId) =>
      sdk.getDeployment({ siteId, deploymentId }) as unknown as DeploymentRecord,
    download: async (siteId, deploymentId, type) =>
      Buffer.from(
        await sdk.getDeploymentDownload({
          siteId,
          deploymentId,
          type: type === "source" ? DeploymentDownloadType.Source : DeploymentDownloadType.Output,
        }),
      ),
    activate: async (siteId, deploymentId) =>
      sdk.updateSiteDeployment({ siteId, deploymentId }) as unknown as SiteRecord,
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      deadline.abort();
      if (dispatcher) {
        await dispatcher.close();
        return;
      }
      const results = await Promise.allSettled([
        Promise.resolve().then(() => jsonAgent.destroy()),
        Promise.resolve().then(() => downloadAgent.destroy()),
      ]);
      if (results.some((result) => result.status === "rejected"))
        reject("transport_cleanup_failed");
    },
  };
}
function readBounded(path: string, max: number) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > max) reject("invalid_local_evidence_file");
  const data = readFileSync(path);
  if (data.length !== stat.size || data.length > max) reject("local_evidence_changed");
  return data;
}
// GitHub represents an unset optional secret as an empty environment string.
// Only that representation is absent; whitespace or malformed nonempty input
// remains subject to the qualifier's exact credential validation.
export function qualificationOptionsFromEnvironment(
  qualificationPath: string,
  env: NodeJS.ProcessEnv,
) {
  return {
    qualificationPath,
    ...(env.APPWRITE_BACKEND_READINESS_TOKEN === undefined ||
    env.APPWRITE_BACKEND_READINESS_TOKEN === ""
      ? {}
      : { readinessToken: env.APPWRITE_BACKEND_READINESS_TOKEN }),
    ...(env.APPWRITE_STAGING_READINESS_TOKEN === undefined ||
    env.APPWRITE_STAGING_READINESS_TOKEN === ""
      ? {}
      : { stagingReadinessToken: env.APPWRITE_STAGING_READINESS_TOKEN }),
  };
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  const operation = argv[0];
  if (operation !== "prepare" && operation !== "activate") reject("invalid_arguments");
  const args = parseArgs(argv, operation, [
    "target",
    "artifact",
    "github-evidence",
    "qualification",
    "receipt",
    "candidate-receipt",
    "staging-config",
    "staging-receipt",
  ]);
  if (
    !args.target ||
    !args.artifact ||
    !args["github-evidence"] ||
    !args.qualification ||
    !args.receipt ||
    (operation === "activate") !== Boolean(args["candidate-receipt"]) ||
    (args.target === "production" && (!args["staging-config"] || !args["staging-receipt"])) ||
    (args.target === "staging" && (args["staging-config"] || args["staging-receipt"]))
  )
    reject("invalid_arguments");
  const source = JSON.parse(
    readBounded(join(args.artifact, "source-artifact.json"), 4 * 1024 * 1024).toString(),
  );
  const archive = readBounded(join(args.artifact, "source.tar.gz"), SOURCE_LIMITS.archiveBytes);
  const githubEvidence = JSON.parse(
    readBounded(args["github-evidence"], 8 * 1024 * 1024).toString(),
  );
  const receiptPath = resolve(args.receipt);
  if (!lstatSync(dirname(receiptPath)).isDirectory()) reject("receipt_parent_missing");
  const config: TargetConfig = {
    target: args.target as TargetName,
    siteId: env.APPWRITE_SITE_ID ?? "",
    otherSiteId: env.APPWRITE_OTHER_SITE_ID ?? "",
    webOrigin: env.WEB_PUBLIC_ORIGIN ?? "",
    apiOrigin: env.API_INTERNAL_URL ?? "",
    buildSpecification: env.APPWRITE_BUILD_SPECIFICATION ?? "",
    runtimeSpecification: env.APPWRITE_RUNTIME_SPECIFICATION ?? "",
  };
  const stagingConfig: TargetConfig | undefined = args["staging-config"]
    ? JSON.parse(readBounded(args["staging-config"], 16 * 1024).toString())
    : undefined;
  const qualification = createQualificationVerifier(
    qualificationOptionsFromEnvironment(args.qualification, env),
  );
  const budget = { requests: 0, deadlineAt: Date.now() + RELEASE_LIMITS.totalMs };
  const receiptFd = openSync(receiptPath, "wx", 0o600);
  try {
    return await (operation === "prepare" ? prepareSite : activateSite)({
      config,
      source,
      archive,
      githubEvidence,
      qualification,
      verifyGitHub: async (value, expected) => {
        const binding = {
          ...expected,
          releaseRunId: Number(env.GITHUB_RUN_ID),
          releaseAttempt: Number(env.GITHUB_RUN_ATTEMPT),
        };
        // Supplied workflow evidence is provenance only. Admission always reads
        // the provider's current branch, run, job and approval state again.
        validateGitHubEvidence(value, binding);
        const current = await collectGitHubEvidence({
          ...binding,
          token: env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "",
        });
        return validateGitHubEvidence(current, binding);
      },
      createPort: () =>
        createSitesPort(config, env.APPWRITE_DEPLOY_KEY ?? "", undefined, { budget }),
      createStagingPort: stagingConfig
        ? () =>
            createSitesPort(stagingConfig, env.APPWRITE_DEPLOY_KEY ?? "", undefined, {
              readOnly: true,
              budget,
            })
        : undefined,
      candidateReceipt: args["candidate-receipt"]
        ? JSON.parse(readBounded(args["candidate-receipt"], 16 * 1024).toString())
        : undefined,
      stagingConfig,
      stagingReceipt: args["staging-receipt"]
        ? JSON.parse(readBounded(args["staging-receipt"], 16 * 1024).toString())
        : undefined,
      saveReceipt: (receipt) => writeFileSync(receiptFd, canonical(receipt)),
    });
  } finally {
    closeSync(receiptFd);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((receipt) => {
      console.log(
        JSON.stringify({
          operation: receipt.operation,
          status: receipt.status,
          phase: receipt.phase,
          failure: receipt.failure,
          activationOutcome: receipt.activationOutcome,
        }),
      );
      if (receipt.status === "failed") process.exitCode = 1;
    })
    .catch(() => {
      console.error("Appwrite release admission failed; inspect the bounded receipt if present.");
      process.exitCode = 1;
    });
}
