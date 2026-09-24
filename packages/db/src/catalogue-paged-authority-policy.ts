// Fixed ADR0104/ADR0105 authority policy, shared with the restore verifier.
import type {
  CatalogueAuthorityFunctionPolicy,
  CatalogueAuthorityTriggerPolicy,
} from "./catalogue-authority-deployment.js";
import manifest from "./catalogue-paged-authority-policy.json" with { type: "json" };

export const CATALOGUE_PAGED_FUNCTION_POLICY =
  manifest.functions as readonly CatalogueAuthorityFunctionPolicy[];
export const CATALOGUE_PAGED_TRIGGER_POLICY =
  manifest.triggers as readonly CatalogueAuthorityTriggerPolicy[];
export const CATALOGUE_PAGED_TABLES: readonly string[] = manifest.tables;

export const CATALOGUE_PAGED_CONSTRAINT_POLICY = manifest.constraints;
export const CATALOGUE_PAGED_COLUMN_POLICY = manifest.columns;
export const CATALOGUE_PAGED_INDEX_POLICY = manifest.indexes;

export const CATALOGUE_PAGED_VIEW_POLICY = manifest.views;
