import {
  authenticatedReleaseEvidenceBundleSha256,
  manifestAuthoritySubjectSha256,
  parseAuthenticatedReleaseEvidenceBundle,
  parseFoodSourceManifest,
} from "@nutrition-tracker/ingestion";

import type { SyntheticReleaseEvidenceFixture } from "./synthetic-release-evidence.js";

/**
 * Synthetic authority decision for the disposable PostgreSQL promotion fixture only.
 * The shared fixture places acquisition/review steps within the previous nine
 * minutes, retention validity just under one day ahead, and retention one year
 * ahead. No network evidence or production reviewer identity is claimed here.
 */
export function bindSyntheticLiveReview(
  fixture: SyntheticReleaseEvidenceFixture,
): SyntheticReleaseEvidenceFixture {
  const manifest = parseFoodSourceManifest({ ...fixture.manifest, releaseClass: "live-reviewed" });
  const bundle = parseAuthenticatedReleaseEvidenceBundle({
    ...fixture.bundle,
    authorityDecision: {
      ...fixture.bundle.authorityDecision,
      decision: "approved-for-live-staging",
      releaseClass: "live-reviewed",
      manifestAuthoritySubjectSha256: manifestAuthoritySubjectSha256(manifest),
    },
  });
  const sha256 = authenticatedReleaseEvidenceBundleSha256(bundle);
  return {
    bundle,
    manifest: parseFoodSourceManifest({
      ...manifest,
      evidenceBundle: {
        contractVersion: 1,
        sha256,
        objectUri: `s3://synthetic-release-evidence/sha256/${sha256}/bundle.json`,
      },
    }),
  };
}
