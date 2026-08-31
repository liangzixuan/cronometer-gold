-- Forward-only covering path for immutable active-release barcode evidence.
-- The transactional migrator is appropriate before full catalogue-scale data;
-- existing large deployments require a separately reviewed maintenance window.
create index food_barcode_active_release_version_idx
  on food_barcode (source_release_id, food_version_id)
  include (gtin, market_code)
  where valid_to is null and source_release_id is not null;
