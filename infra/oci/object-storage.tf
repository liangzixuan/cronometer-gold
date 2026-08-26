data "oci_objectstorage_namespace" "current" {
  compartment_id = var.tenancy_ocid
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
  azure_object_storage_network_source_name = "${var.name_prefix}-azure-os-egress"

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
  email          = var.object_storage_role_emails[each.key]
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

# Provider 7.32.0 can read all seven effective IAM user capabilities, but its
# capability-management resource cannot write the DB-password or OAuth2-client
# flags. Read the effective user only after the supported five flags settle and
# fail closed unless the full least-privilege tuple matches.
data "oci_identity_user" "object_storage_role_effective_capabilities" {
  for_each = local.object_storage_roles

  user_id = oci_identity_user.object_storage_role[each.key].id

  depends_on = [oci_identity_user_capabilities_management.object_storage_role]

  lifecycle {
    postcondition {
      condition = try(
        length(self.capabilities) == 1 &&
        self.capabilities[0].can_use_api_keys == each.value.can_use_api_keys &&
        self.capabilities[0].can_use_auth_tokens == false &&
        self.capabilities[0].can_use_console_password == false &&
        self.capabilities[0].can_use_customer_secret_keys == true &&
        self.capabilities[0].can_use_db_credentials == false &&
        self.capabilities[0].can_use_oauth2client_credentials == false &&
        self.capabilities[0].can_use_smtp_credentials == false,
        false,
      )
      error_message = "Effective IAM capabilities for ${each.key} exceed the reviewed Object Storage role: only Customer Secret Keys, plus API keys for ledger_restore, may be enabled; Auth Token, Console Password, DB Credentials, OAuth2 Client Credentials, and SMTP Credentials must be disabled."
    }
  }
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

# This resource is absent by default. It may be added only after Azure has
# allocated the beta VM's static public IPv4 and a fresh, independently audited
# OCI plan proves that no retired A1 compute resource or unrelated change is in
# the graph. "none" prevents service on-behalf-of requests from bypassing the
# single public /32. The immutable name and prevent_destroy guard make removal
# an explicit source-code and state-migration event rather than a toggle.
resource "oci_identity_network_source" "azure_object_storage_egress" {
  for_each = var.restrict_object_storage_to_azure_egress && var.azure_object_storage_egress_cidr != null ? {
    azure = var.azure_object_storage_egress_cidr
  } : {}

  compartment_id     = var.tenancy_ocid
  description        = "Azure controlled-beta static egress allowed to use the four Object Storage roles"
  freeform_tags      = local.tags
  name               = local.azure_object_storage_network_source_name
  public_source_list = [each.value]
  services           = ["none"]

  depends_on = [terraform_data.apply_guardrails]

  lifecycle {
    prevent_destroy = true

    postcondition {
      condition     = self.state == "ACTIVE"
      error_message = "The Azure Object Storage network source must be ACTIVE before any role policy can reference it."
    }
  }
}

locals {
  object_storage_network_source_conditions = (
    var.restrict_object_storage_to_azure_egress && var.azure_object_storage_egress_cidr != null
    ? ["request.networkSource.name='${local.azure_object_storage_network_source_name}'"]
    : []
  )

  object_storage_role_policy_conditions = {
    for role_name, role in local.object_storage_roles : role_name => concat(
      [
        "target.bucket.name='${role.bucket_name}'",
        "target.object.name='${role.object_prefix}'",
      ],
      local.object_storage_network_source_conditions,
      ["any {${join(", ", [for permission in role.object_permissions : "request.permission='${permission}'"])}}"],
    )
  }
}

# request.permission conditions express the exact adapter contract. Known-key
# S3 operations need no bucket permission. In particular, ledger_writer has
# neither OBJECT_OVERWRITE nor OBJECT_DELETE, and only ledger_restore has
# OBJECT_INSPECT so the native API can ListObjectVersions. When the optional
# Azure binding is enabled, the same all{} condition also requires the request
# to originate in the one ACTIVE network source above.
resource "oci_identity_policy" "object_storage_role" {
  for_each = local.object_storage_roles

  compartment_id = var.tenancy_ocid
  description    = each.value.description
  freeform_tags  = local.tags
  name           = "${var.name_prefix}-os-${replace(each.key, "_", "-")}-policy"
  statements = [
    "Allow group id ${oci_identity_group.object_storage_role[each.key].id} to manage objects in compartment id ${local.target_compartment_id} where all {${join(", ", local.object_storage_role_policy_conditions[each.key])}}",
  ]

  depends_on = [
    oci_identity_user_group_membership.object_storage_role,
    oci_identity_network_source.azure_object_storage_egress,
    oci_objectstorage_bucket.exports,
    oci_objectstorage_bucket.ledger,
  ]

  lifecycle {
    prevent_destroy = true
  }
}
