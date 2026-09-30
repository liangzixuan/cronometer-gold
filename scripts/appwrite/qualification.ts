import { createHash } from "node:crypto";
import {
  configurationSha256,
  loadManagedPolicy,
  loadReviewerTrustStore,
  type QualificationBundle,
  QualificationEvidenceError,
  readQualificationBundle,
  validateBackendAdmission,
  validateCaptureReview,
  validateManagedDeployment,
  validateStagingIsolation,
} from "../deployment/managed-evidence.mjs";
import type { GitHubEvidence } from "./github-checks.ts";
import {
  exactHttpsOrigin,
  type QualificationContext,
  type QualificationVerifier,
  ReleaseError,
  type TargetConfig,
} from "./site-release.ts";

export { configurationSha256 } from "../deployment/managed-evidence.mjs";
export const READINESS_LIMITS = Object.freeze({ timeoutMs: 10_000, bytes: 1024 });
export type LiveReadinessObservation = {
  observedAt: string;
  apiOrigin: string;
  method: "GET";
  path: "/ready";
  httpStatus: 200;
  bodySha256: string;
  meaning: "live-database-readiness-only";
};
export type QualificationDependencies = {
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  // Tests may inject ephemeral public keys. CLI wiring never accepts a trust-store argument.
  trustStore?: unknown;
  policy?: unknown;
  readBundle?: (path: string) => QualificationBundle;
};
export type QualificationOptions = {
  qualificationPath: string;
  readinessToken?: string;
  stagingReadinessToken?: string;
};
type Context = QualificationContext & { githubEvidence?: unknown };
function reject(code: string): never {
  throw new ReleaseError(code);
}
function backendContext(config: TargetConfig, context: Context, now: number) {
  return {
    target: config.target,
    apiOrigin: config.apiOrigin,
    sourceRevision: context.source.revision,
    configurationSha256: configurationSha256(config),
    now,
  };
}
function githubCapture(context: Context, now: number) {
  const evidence = context.githubEvidence as GitHubEvidence | undefined;
  const browser = evidence?.browser?.summary?.browser as Record<string, unknown> | undefined;
  const run = evidence?.requiredRuns?.find(
    (entry) => entry.workflow === "browserstack-web.yml",
  )?.run;
  if (
    !evidence ||
    evidence.revision !== context.source.revision ||
    typeof evidence.browser?.summarySha256 !== "string" ||
    typeof browser?.sessionId !== "string" ||
    !run
  )
    reject("capture_source_evidence_missing");
  return {
    sourceRevision: context.source.revision,
    summarySha256: evidence.browser.summarySha256,
    sessionId: browser.sessionId,
    runId: run.id,
    attempt: run.run_attempt,
    now,
  };
}
export async function probeBackendReadiness(
  apiOrigin: string,
  token: string | undefined,
  request: typeof globalThis.fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<LiveReadinessObservation> {
  exactHttpsOrigin(apiOrigin);
  if (token !== undefined && !/^[0-9a-f]{64}$/.test(token)) reject("readiness_credential_invalid");
  const signal = AbortSignal.timeout(READINESS_LIMITS.timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await request(`${apiOrigin}/ready`, {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        accept: "application/json",
        "cache-control": "no-store",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (response.status !== 200 || response.redirected) reject("backend_live_readiness_failed");
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") reject("backend_live_readiness_invalid");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > READINESS_LIMITS.bytes))
      reject("backend_live_readiness_too_large");
    if (!response.body) reject("backend_live_readiness_invalid");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > READINESS_LIMITS.bytes) reject("backend_live_readiness_too_large");
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    const body = Buffer.concat(chunks, bytes);
    const text = body.toString("utf8");
    if (!Buffer.from(text).equals(body)) reject("backend_live_readiness_invalid");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      reject("backend_live_readiness_invalid");
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).join() !== "status" ||
      (parsed as { status?: unknown }).status !== "ok"
    )
      reject("backend_live_readiness_invalid");
    return {
      observedAt: new Date(now()).toISOString(),
      apiOrigin,
      method: "GET",
      path: "/ready",
      httpStatus: 200,
      bodySha256: createHash("sha256").update(body).digest("hex"),
      meaning: "live-database-readiness-only",
    };
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    return reject("backend_live_readiness_failed");
  } finally {
    try {
      await reader?.cancel();
    } catch {
      // Closing the failed bounded read never changes its primary failure.
    }
    reader?.releaseLock();
  }
}
/**
 * Signatures establish independent report authority. Provider state/artifacts are
 * re-read by the controller; this verifier separately probes live database readiness.
 * Neither the signed host report nor /ready is represented as a fresh Azure API read.
 */
export function createQualificationVerifier(
  options: QualificationOptions,
  dependencies: QualificationDependencies = {},
): QualificationVerifier & { readinessObservations: () => readonly LiveReadinessObservation[] } {
  const now = dependencies.now ?? Date.now;
  const request = dependencies.fetch ?? globalThis.fetch;
  const trust = dependencies.trustStore ?? loadReviewerTrustStore();
  const policy = dependencies.policy ?? loadManagedPolicy();
  const read = dependencies.readBundle ?? readQualificationBundle;
  const observations: LiveReadinessObservation[] = [];
  const wrap = async (callback: () => Promise<void>) => {
    try {
      await callback();
    } catch (error) {
      if (error instanceof ReleaseError) throw error;
      if (error instanceof QualificationEvidenceError) reject(error.code);
      reject("qualification_evidence_invalid");
    }
  };
  const backend = async (
    bundle: QualificationBundle,
    context: Context,
    config: TargetConfig,
    stagingProbe = false,
  ) => {
    validateCaptureReview(bundle.captureReview, githubCapture(context, now()), trust);
    const admitted = validateBackendAdmission(
      bundle,
      backendContext(config, context, now()),
      trust,
      policy,
    );
    observations.push(
      await probeBackendReadiness(
        config.apiOrigin,
        stagingProbe ? options.stagingReadinessToken : options.readinessToken,
        request,
        now,
      ),
    );
    return admitted;
  };
  return {
    readinessObservations: () => observations.map((item) => ({ ...item })),
    beforeUpload: (context) =>
      wrap(async () => {
        await backend(read(options.qualificationPath), context, context.config);
      }),
    beforeActivation: (context) =>
      wrap(async () => {
        const bundle = read(options.qualificationPath);
        if (!context.deploymentId || !context.output) reject("candidate_identity_missing");
        await backend(bundle, context, context.config);
        validateManagedDeployment(
          bundle,
          {
            ...backendContext(context.config, context, now()),
            webOrigin: context.config.webOrigin,
            siteId: context.config.siteId,
            deploymentId: context.deploymentId,
            output: context.output,
            sourceArchiveSha256: context.source.archiveSha256,
          },
          trust,
          policy,
        );
      }),
    verifyStaging: (receipt, context) =>
      wrap(async () => {
        const bundle = read(options.qualificationPath);
        const staging = context.staging;
        if (!bundle.staging || !staging || context.config.target !== "production")
          reject("staging_qualification_missing");
        if (
          staging.config.target !== "staging" ||
          staging.config.siteId !== context.config.otherSiteId ||
          staging.site.deploymentId !== receipt.activeDeploymentId ||
          staging.deployment.$id !== receipt.activeDeploymentId ||
          staging.deployment.status !== "ready" ||
          staging.site.deploymentId !== bundle.staging.deployment?.web.deploymentId
        )
          reject("staging_provider_identity_mismatch");
        const production = validateBackendAdmission(
          bundle,
          backendContext(context.config, context, now()),
          trust,
          policy,
        );
        const staged = await backend(bundle.staging, context, staging.config, true);
        validateStagingIsolation(production, staged);
        validateManagedDeployment(
          bundle.staging,
          {
            ...backendContext(staging.config, context, now()),
            webOrigin: staging.config.webOrigin,
            siteId: staging.config.siteId,
            deploymentId: staging.deployment.$id,
            output: staging.output,
            sourceArchiveSha256: context.source.archiveSha256,
          },
          trust,
          policy,
        );
      }),
  };
}
