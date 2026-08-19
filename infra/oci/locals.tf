locals {
  parent_compartment_id = coalesce(var.parent_compartment_ocid, var.tenancy_ocid)
  target_compartment_id = var.create_compartment ? oci_identity_compartment.pilot[0].id : var.existing_compartment_ocid

  availability_domain               = data.oci_identity_availability_domains.available.availability_domains[var.availability_domain_index].name
  api_fqdn                          = "${var.api_subdomain}.${lower(var.base_domain)}"
  web_fqdn                          = "${var.web_subdomain}.${lower(var.base_domain)}"
  export_bucket_name                = "${var.name_prefix}-private-exports"
  ledger_bucket_name                = "${var.name_prefix}-erasure-ledger"
  object_s3_endpoint                = "https://${data.oci_objectstorage_namespace.current.namespace}.compat.objectstorage.${var.region}.oci.customer-oci.com"
  object_compat_host                = "${data.oci_objectstorage_namespace.current.namespace}.compat.objectstorage.${var.region}.oci.customer-oci.com"
  object_native_host                = "objectstorage.${var.region}.oraclecloud.com"
  object_bridge_cidr                = "172.31.255.0/28"
  object_storage_public_ranges_lock = jsondecode(file("${path.module}/object-storage-public-ranges.lock.json"))
  object_storage_public_cidrs       = sort(local.object_storage_public_ranges_lock.objectStoragePublicCidrs)
  operator_helper_digests = {
    "bootstrap-meili-keys.sh"               = filesha256("${path.module}/files/bootstrap-meili-keys.sh")
    "deployment-preflight.sh"               = filesha256("${path.module}/files/deployment-preflight.sh")
    "image-admission.py"                    = filesha256("${path.module}/files/image-admission.py")
    "install-object-storage-credentials.py" = filesha256("${path.module}/files/install-object-storage-credentials.py")
  }

  tags = merge(
    {
      "deployment" = "controlled-beta"
      "managed-by" = "terraform"
      "project"    = "cronometer-gold"
      "topology"   = "single-node-non-ha"
    },
    var.freeform_tags,
  )

  # CI owns the verbose evidence lock. The host needs only the enforcement
  # projection below; embedding prose and evidence URLs would exceed OCI's
  # cumulative metadata limit. The full-lock digest binds the projection back
  # to the reviewed source file.
  external_image_lock = jsondecode(file("${path.module}/external-images.lock.json"))
  external_runtime_image_lock = {
    schemaVersion    = local.external_image_lock.schemaVersion
    sourceLockSha256 = filesha256("${path.module}/external-images.lock.json")
    reviewedAt       = local.external_image_lock.reviewedAt
    policy = {
      platform          = local.external_image_lock.policy.platform
      scanner           = local.external_image_lock.policy.scanner
      scannerVersion    = local.external_image_lock.policy.scannerVersion
      databaseUpdatedAt = local.external_image_lock.policy.databaseUpdatedAt
      severities        = local.external_image_lock.policy.severities
      includeUnfixed    = local.external_image_lock.policy.includeUnfixed
      ignorePolicy      = local.external_image_lock.policy.ignorePolicy
    }
    images = {
      for image_variable, image in local.external_image_lock.images : image_variable => {
        repository  = image.repository
        version     = image.version
        platform    = image.platform
        digest      = image.digest
        arm64Digest = image.arm64Digest
        ref         = image.ref
        approved    = image.approved
        scan        = image.scan
      }
    }
  }

  # Cloud-init metadata has a hard cumulative 32 KiB ceiling in OCI. Packing
  # the reviewed, non-secret host files into one compressed JSON object avoids
  # the per-file YAML and transport overhead while retaining explicit modes.
  bootstrap_files = {
    "/etc/docker/daemon.json" = {
      content = file("${path.module}/files/daemon.json")
      mode    = "0644"
    }
    "/etc/nutrition-tracker/api.env.example" = {
      content = file("${path.module}/files/api.env.example")
      mode    = "0600"
    }
    "/etc/nutrition-tracker/backup-restore-evidence.json.example" = {
      content = file("${path.module}/files/backup-restore-evidence.json.example")
      mode    = "0600"
    }
    "/etc/nutrition-tracker/database.env.example" = {
      content = file("${path.module}/files/database.env.example")
      mode    = "0600"
    }
    "/etc/nutrition-tracker/deploy.env.example" = {
      content = templatefile("${path.module}/templates/deploy.env.example.tftpl", { api_fqdn = local.api_fqdn, web_fqdn = local.web_fqdn })
      mode    = "0600"
    }
    "/etc/nutrition-tracker/expected-backup-policy-id" = {
      content = "${oci_core_volume_backup_policy.pilot.id}\n"
      mode    = "0644"
    }
    "/etc/nutrition-tracker/meili.env.example" = {
      content = file("${path.module}/files/meili.env.example")
      mode    = "0600"
    }
    "/etc/nutrition-tracker/restore.env.example" = {
      content = templatefile("${path.module}/templates/restore.env.example.tftpl", {
        namespace         = data.oci_objectstorage_namespace.current.namespace
        restore_user_ocid = oci_identity_user.object_storage_role["ledger_restore"].id
        tenancy_ocid      = var.tenancy_ocid
      })
      mode = "0600"
    }
    "/etc/nutrition-tracker/runtime.env.example" = {
      content = templatefile("${path.module}/templates/runtime.env.example.tftpl", {
        export_bucket_name = local.export_bucket_name
        ledger_bucket_name = local.ledger_bucket_name
        object_s3_endpoint = local.object_s3_endpoint
        region             = var.region
      })
      mode = "0600"
    }
    "/etc/nutrition-tracker/object-storage-coordinates.json" = {
      content = jsonencode({
        schemaVersion            = 3
        endpoint                 = local.object_s3_endpoint
        compatHost               = local.object_compat_host
        nativeHost               = local.object_native_host
        region                   = var.region
        namespace                = data.oci_objectstorage_namespace.current.namespace
        exportBucket             = local.export_bucket_name
        ledgerBucket             = local.ledger_bucket_name
        restoreUserOcid          = oci_identity_user.object_storage_role["ledger_restore"].id
        tenancyOcid              = var.tenancy_ocid
        bridgeCidr               = local.object_bridge_cidr
        objectStoragePublicCidrs = local.object_storage_public_cidrs
      })
      mode = "0644"
    }
    "/etc/nutrition-tracker/operator-helper-digests.json" = {
      content = jsonencode(local.operator_helper_digests)
      mode    = "0644"
    }
    "/etc/nutrition-tracker/worker.env.example" = {
      content = file("${path.module}/files/worker.env.example")
      mode    = "0600"
    }
    "/etc/ssh/sshd_config.d/60-nutrition-tracker.conf" = {
      content = "PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n"
      mode    = "0644"
    }
    "/etc/systemd/system/nutrition-container-runtime-bootstrap.service" = {
      content = file("${path.module}/files/container-runtime-bootstrap.service")
      mode    = "0644"
    }
    "/etc/systemd/system/nutrition-internal-pki-rotation.service" = {
      content = file("${path.module}/files/internal-pki-rotation.service")
      mode    = "0644"
    }
    "/etc/systemd/system/nutrition-internal-pki-rotation.timer" = {
      content = file("${path.module}/files/internal-pki-rotation.timer")
      mode    = "0644"
    }
    "/etc/systemd/system/nutrition-object-egress-firewall.service" = {
      content = file("${path.module}/files/object-egress-firewall.service")
      mode    = "0644"
    }
    "/etc/systemd/system/nutrition-object-egress-firewall-watchdog.service" = {
      content = file("${path.module}/files/object-egress-firewall-watchdog.service")
      mode    = "0644"
    }
    "/etc/systemd/system/nutrition-object-egress-firewall-watchdog.timer" = {
      content = file("${path.module}/files/object-egress-firewall-watchdog.timer")
      mode    = "0644"
    }
    "/etc/systemd/system/nutrition-release-failure-containment.service" = {
      content = file("${path.module}/files/release-failure-containment.service")
      mode    = "0644"
    }
    "/etc/systemd/system/nutrition-tracker.service" = {
      content = file("${path.module}/files/nutrition-tracker.service")
      mode    = "0644"
    }
    "/opt/nutrition-tracker/Caddyfile" = {
      content = file("${path.module}/files/Caddyfile")
      mode    = "0644"
    }
    "/opt/nutrition-tracker/compose.yaml" = {
      content = file("${path.module}/files/compose.yaml")
      mode    = "0644"
    }
    "/opt/nutrition-tracker/external-images.lock.json" = {
      content = jsonencode(local.external_runtime_image_lock)
      mode    = "0644"
    }
    "/usr/local/sbin/install-nutrition-docker-ce" = {
      content = file("${path.module}/files/install-docker-ce.sh")
      mode    = "0750"
    }
    "/usr/local/sbin/nutrition-configure-host-firewall" = {
      content = file("${path.module}/files/configure-host-firewall.sh")
      mode    = "0750"
    }
    "/usr/local/sbin/nutrition-configure-object-egress-firewall" = {
      content = file("${path.module}/files/configure-object-egress-firewall.sh")
      mode    = "0750"
    }
    "/usr/local/sbin/nutrition-assert-object-egress-firewall" = {
      content = file("${path.module}/files/assert-object-egress-firewall.py")
      mode    = "0750"
    }
    "/usr/local/sbin/nutrition-credential-rotation-lock" = {
      content = file("${path.module}/files/credential-rotation-lock.sh")
      mode    = "0750"
    }
    "/usr/local/sbin/nutrition-install-initial-secrets" = {
      content = file("${path.module}/files/install-initial-secrets.py")
      mode    = "0750"
    }
    "/usr/local/sbin/nutrition-instance-identity" = {
      content = file("${path.module}/files/instance-identity-gate.sh")
      mode    = "0750"
    }
    "/usr/local/sbin/nutrition-object-egress-firewall-watchdog" = {
      content = file("${path.module}/files/object-egress-firewall-watchdog.sh")
      mode    = "0750"
    }
    "/usr/local/sbin/nutrition-prepare-internal-pki" = {
      content = file("${path.module}/files/prepare-internal-pki.sh")
      mode    = "0750"
    }
    "/usr/local/sbin/nutrition-prepare-object-storage-egress" = {
      content = file("${path.module}/files/prepare-object-storage-egress.py")
      mode    = "0750"
    }
    "/usr/local/sbin/nutrition-prepare-storage" = {
      content = file("${path.module}/files/prepare-storage.sh")
      mode    = "0750"
    }
    "/usr/local/sbin/nutrition-contain-failed-release" = {
      content = file("${path.module}/files/release-failure-containment.sh")
      mode    = "0750"
    }
    "/usr/local/sbin/nutrition-release-orchestrator" = {
      content = file("${path.module}/files/release-orchestrator.sh")
      mode    = "0750"
    }
  }

  cloud_init = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    bootstrap_bundle_base85  = data.external.bootstrap_bundle.result.bundle_base85
    bootstrap_payload_sha256 = data.external.bootstrap_bundle.result.payload_sha256
    unpacker                 = file("${path.module}/files/unpack-bootstrap.py")
  })

  encoded_cloud_init          = base64gzip(local.cloud_init)
  ssh_authorized_keys         = join("\n", [for key in var.ssh_authorized_keys : trimspace(key)])
  metadata_payload_size_bytes = length(local.encoded_cloud_init) + length(local.ssh_authorized_keys) + 512
}

resource "terraform_data" "apply_guardrails" {
  input = {
    region   = var.region
    topology = "single-node-non-ha"
  }

  lifecycle {
    precondition {
      condition     = var.acknowledge_non_ha_and_possible_charges
      error_message = "Apply is locked. Recheck OCI limits/pricing and set acknowledge_non_ha_and_possible_charges=true only if the non-HA pilot and possible charges are accepted."
    }

    precondition {
      condition = alltrue([
        for image in values(local.external_image_lock.images) :
        image.approved && image.scan.critical == 0 && image.scan.high == 0 && image.scan.total == 0 && image.scan.result == "passed"
      ])
      error_message = "Apply is blocked because one or more checked-in external runtime images are unapproved or have HIGH/CRITICAL findings. Update reviewed evidence and pass supply-chain CI; do not override this gate."
    }

    precondition {
      condition = try(
        local.object_storage_public_ranges_lock.schemaVersion == 1 &&
        local.object_storage_public_ranges_lock.source.url == "https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json" &&
        can(regex("^[0-9a-f]{64}$", local.object_storage_public_ranges_lock.source.sha256)) &&
        can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+$", local.object_storage_public_ranges_lock.source.lastUpdatedTimestamp)) &&
        can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+Z$", local.object_storage_public_ranges_lock.source.retrievedAt)) &&
        local.object_storage_public_ranges_lock.review.region == var.region &&
        local.object_storage_public_ranges_lock.review.requiredTag == "OBJECT_STORAGE" &&
        local.object_storage_public_ranges_lock.review.reviewedAt == local.object_storage_public_ranges_lock.source.retrievedAt &&
        local.object_storage_public_ranges_lock.review.expectedCidrCount == 2 &&
        length(local.object_storage_public_cidrs) == 2 &&
        length(toset(local.object_storage_public_cidrs)) == 2 &&
        tolist(local.object_storage_public_ranges_lock.objectStoragePublicCidrs) == local.object_storage_public_cidrs &&
        local.object_storage_public_cidrs == tolist(["134.70.24.0/21", "134.70.32.0/22"]) &&
        alltrue([
          for cidr in local.object_storage_public_cidrs :
          can(regex("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}/(?:[0-9]|[12][0-9]|3[0-2])$", cidr)) &&
          cidr == "${cidrhost(cidr, 0)}/${split("/", cidr)[1]}"
        ]),
        false,
      )
      error_message = "Apply is blocked because the checked-in OCI Object Storage public-range lock is malformed, unsorted, noncanonical, or not the exact reviewed Ashburn pair."
    }

    precondition {
      condition = try(
        timecmp(local.object_storage_public_ranges_lock.review.reviewedAt, plantimestamp()) <= 0 &&
        timecmp(timeadd(local.object_storage_public_ranges_lock.review.reviewedAt, "168h"), plantimestamp()) >= 0,
        false,
      )
      error_message = "Apply is blocked because the OCI public Object Storage ranges were not reviewed against Oracle's current publication within the last 168 hours."
    }

    precondition {
      condition     = var.create_compartment != (var.existing_compartment_ocid != null)
      error_message = "Choose exactly one compartment mode: create_compartment=true with no existing_compartment_ocid, or create_compartment=false with an existing_compartment_ocid."
    }

    precondition {
      condition     = length(var.admin_cidrs) > 0
      error_message = "At least one restricted admin_cidrs entry is required before apply."
    }

    precondition {
      condition     = length(var.ssh_authorized_keys) > 0
      error_message = "At least one public SSH key is required before apply."
    }

    precondition {
      condition     = var.compute_memory_gb / var.compute_ocpus >= 1 && var.compute_memory_gb / var.compute_ocpus <= 64
      error_message = "A1 memory must be between 1 and 64 GB per OCPU."
    }

    precondition {
      condition     = !contains(var.known_subnet_cidrs, var.public_subnet_cidr)
      error_message = "public_subnet_cidr overlaps a CIDR in known_subnet_cidrs. Refresh the live subnet inventory and choose an unused range."
    }

    precondition {
      condition     = !var.create_oci_dns_records || var.dns_zone_name_or_id != null
      error_message = "dns_zone_name_or_id is required when create_oci_dns_records is true."
    }
  }
}
