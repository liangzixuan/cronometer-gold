data "oci_identity_availability_domains" "available" {
  compartment_id = var.tenancy_ocid
}

resource "oci_core_instance" "pilot" {
  availability_domain  = local.availability_domain
  compartment_id       = local.target_compartment_id
  display_name         = "${var.name_prefix}-node-1"
  freeform_tags        = local.tags
  shape                = var.compute_shape
  preserve_boot_volume = true

  shape_config {
    memory_in_gbs = var.compute_memory_gb
    ocpus         = var.compute_ocpus
  }

  source_details {
    boot_volume_size_in_gbs = var.boot_volume_size_gb
    boot_volume_vpus_per_gb = 10
    kms_key_id              = var.kms_key_id
    source_id               = var.image_ocid
    source_type             = "image"
  }

  create_vnic_details {
    assign_public_ip = false
    display_name     = "${var.name_prefix}-primary-vnic"
    hostname_label   = "node1"
    nsg_ids          = [oci_core_network_security_group.edge.id]
    subnet_id        = oci_core_subnet.edge.id
  }

  launch_options {
    is_pv_encryption_in_transit_enabled = true
    network_type                        = "PARAVIRTUALIZED"
  }

  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }

  metadata = {
    ssh_authorized_keys = local.ssh_authorized_keys
    # OCI decodes metadata user_data before cloud-init; cloud-init recognizes
    # gzip payloads. Compressing keeps the cumulative metadata safely below the
    # 32 KiB service limit alongside the single capped SSH public key.
    user_data = local.encoded_cloud_init
  }

  depends_on = [terraform_data.apply_guardrails]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = local.metadata_payload_size_bytes <= 30000
      error_message = "Compressed cloud-init, the SSH key, and a 512-byte metadata allowance must total no more than 30,000 bytes, preserving headroom below OCI's cumulative 32,000-byte metadata limit. Current total: ${local.metadata_payload_size_bytes}."
    }
  }
}

resource "oci_core_volume_backup_policy" "pilot" {
  compartment_id = local.target_compartment_id
  display_name   = "${var.name_prefix}-daily-2day"
  freeform_tags  = local.tags

  # Two-day retention can transiently overlap three daily generations, leaving
  # two of the documented five Always Free volume-backup slots for a manual
  # pre-release/restore-drill backup. No cross-region copy is requested.
  schedules {
    backup_type       = "INCREMENTAL"
    hour_of_day       = 5
    offset_type       = "STRUCTURED"
    period            = "ONE_DAY"
    retention_seconds = 172800
    time_zone         = "UTC"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_core_volume_backup_policy_assignment" "boot" {
  asset_id  = oci_core_instance.pilot.boot_volume_id
  policy_id = oci_core_volume_backup_policy.pilot.id

  lifecycle {
    prevent_destroy = true
  }
}

data "oci_core_vnic_attachments" "pilot" {
  compartment_id = local.target_compartment_id
  instance_id    = oci_core_instance.pilot.id
}

data "oci_core_vnic" "pilot" {
  vnic_id = data.oci_core_vnic_attachments.pilot.vnic_attachments[0].vnic_id
}

data "oci_core_private_ips" "pilot" {
  vnic_id = data.oci_core_vnic.pilot.id
}

resource "oci_core_public_ip" "pilot" {
  compartment_id = local.target_compartment_id
  display_name   = "${var.name_prefix}-reserved-ip"
  freeform_tags  = local.tags
  lifetime       = "RESERVED"
  private_ip_id  = data.oci_core_private_ips.pilot.private_ips[0].id

  lifecycle {
    prevent_destroy = true
  }
}
