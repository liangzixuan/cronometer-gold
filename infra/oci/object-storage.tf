data "oci_objectstorage_namespace" "current" {
  compartment_id = var.tenancy_ocid
}

# The regional Object Storage service CIDR keeps bucket traffic on OCI's
# network fabric. It is deliberately more specific than the existing IGW
# default route, which remains necessary for ACME and reviewed image pulls.
data "oci_core_services" "object_storage" {
  filter {
    name   = "name"
    values = ["OCI IAD Object Storage"]
  }
}

resource "oci_core_service_gateway" "object_storage" {
  compartment_id = local.target_compartment_id
  display_name   = "${var.name_prefix}-object-storage-service-gateway"
  freeform_tags  = local.tags
  vcn_id         = data.oci_core_vcn.existing.id

  services {
    service_id = data.oci_core_services.object_storage.services[0].id
  }

  depends_on = [terraform_data.apply_guardrails]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = length(data.oci_core_services.object_storage.services) == 1
      error_message = "OCI IAD Object Storage must resolve to exactly one regional service CIDR before the service gateway can be created."
    }
  }
}

resource "oci_objectstorage_bucket" "exports" {
  access_type           = "NoPublicAccess"
  auto_tiering          = "Disabled"
  compartment_id        = local.target_compartment_id
  freeform_tags         = merge(local.tags, { "data-class" = "encrypted-export-artifacts" })
  name                  = local.export_bucket_name
  namespace             = data.oci_objectstorage_namespace.current.namespace
  object_events_enabled = false
  storage_tier          = "Standard"
  versioning            = "Disabled"

  depends_on = [terraform_data.apply_guardrails]

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_objectstorage_bucket" "ledger" {
  access_type           = "NoPublicAccess"
  auto_tiering          = "Disabled"
  compartment_id        = local.target_compartment_id
  freeform_tags         = merge(local.tags, { "data-class" = "append-only-erasure-ledger" })
  name                  = local.ledger_bucket_name
  namespace             = data.oci_objectstorage_namespace.current.namespace
  object_events_enabled = false
  storage_tier          = "Standard"
  versioning            = "Enabled"

  depends_on = [terraform_data.apply_guardrails]

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  object_storage_roles = {
    export_reader = {
      bucket_name        = local.export_bucket_name
      object_prefix      = "exports/v1/*"
      description        = "Read-only S3-compatible access to controlled-beta export artifacts"
      can_use_api_keys   = false
      object_permissions = ["OBJECT_READ"]
    }
    export_writer = {
      bucket_name        = local.export_bucket_name
      object_prefix      = "exports/v1/*"
      description        = "Create, read, and delete controlled-beta export artifacts without list or overwrite permission"
      can_use_api_keys   = false
      object_permissions = ["OBJECT_CREATE", "OBJECT_READ", "OBJECT_DELETE"]
    }
    ledger_writer = {
      bucket_name        = local.ledger_bucket_name
      object_prefix      = "erasure-ledger/v1/*"
      description        = "Append and read erasure-ledger objects without list, overwrite, or delete permission"
      can_use_api_keys   = false
      object_permissions = ["OBJECT_CREATE", "OBJECT_READ"]
    }
    ledger_restore = {
      bucket_name        = local.ledger_bucket_name
      object_prefix      = "erasure-ledger/v1/*"
      description        = "Offline erasure-ledger read, inspect, and version-list access"
      can_use_api_keys   = true
      object_permissions = ["OBJECT_INSPECT", "OBJECT_READ"]
    }
  }
}

resource "oci_identity_user" "object_storage_role" {
  for_each = local.object_storage_roles

  compartment_id = var.tenancy_ocid
  description    = each.value.description
  freeform_tags  = local.tags
  name           = "${var.name_prefix}-os-${replace(each.key, "_", "-")}"

  depends_on = [terraform_data.apply_guardrails]

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_identity_user_capabilities_management" "object_storage_role" {
  for_each = local.object_storage_roles

  can_use_api_keys             = each.value.can_use_api_keys
  can_use_auth_tokens          = false
  can_use_console_password     = false
  can_use_customer_secret_keys = true
  can_use_smtp_credentials     = false
  user_id                      = oci_identity_user.object_storage_role[each.key].id
}

resource "oci_identity_group" "object_storage_role" {
  for_each = local.object_storage_roles

  compartment_id = var.tenancy_ocid
  description    = each.value.description
  freeform_tags  = local.tags
  name           = "${var.name_prefix}-os-${replace(each.key, "_", "-")}-group"

  depends_on = [terraform_data.apply_guardrails]

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_identity_user_group_membership" "object_storage_role" {
  for_each = local.object_storage_roles

  compartment_id = var.tenancy_ocid
  group_id       = oci_identity_group.object_storage_role[each.key].id
  user_id        = oci_identity_user.object_storage_role[each.key].id
}

# request.permission conditions express the exact adapter contract. Known-key
# S3 operations need no bucket permission. In particular, ledger_writer has
# neither OBJECT_OVERWRITE nor OBJECT_DELETE, and only ledger_restore has
# OBJECT_INSPECT so the native API can ListObjectVersions.
resource "oci_identity_policy" "object_storage_role" {
  for_each = local.object_storage_roles

  compartment_id = var.tenancy_ocid
  description    = each.value.description
  freeform_tags  = local.tags
  name           = "${var.name_prefix}-os-${replace(each.key, "_", "-")}-policy"
  statements = [
    "Allow group id ${oci_identity_group.object_storage_role[each.key].id} to manage objects in compartment id ${local.target_compartment_id} where all {target.bucket.name='${each.value.bucket_name}', target.object.name='${each.value.object_prefix}', any {${join(", ", [for permission in each.value.object_permissions : "request.permission='${permission}'"])}}}",
  ]

  depends_on = [
    oci_identity_user_group_membership.object_storage_role,
    oci_objectstorage_bucket.exports,
    oci_objectstorage_bucket.ledger,
  ]

  lifecycle {
    prevent_destroy = true
  }
}
