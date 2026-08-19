variable "tenancy_ocid" {
  description = "OCID of the personal OCI tenancy. It is also the root compartment OCID."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.tenancy\\.oc1\\.", var.tenancy_ocid))
    error_message = "tenancy_ocid must be an OCI tenancy OCID."
  }
}

variable "region" {
  description = "Deployment region. This pilot is intentionally pinned to the tenancy home region."
  type        = string
  default     = "us-ashburn-1"

  validation {
    condition     = var.region == "us-ashburn-1"
    error_message = "This Free Tier pilot is intentionally restricted to us-ashburn-1."
  }
}

variable "oci_auth" {
  description = "OCI Terraform provider authentication mode. SecurityToken uses the short-lived CLI session."
  type        = string
  default     = "SecurityToken"

  validation {
    condition     = contains(["SecurityToken", "ApiKey", "InstancePrincipal", "ResourcePrincipal"], var.oci_auth)
    error_message = "oci_auth must be a supported OCI provider authentication mode."
  }
}

variable "oci_config_profile" {
  description = "OCI CLI config profile used by the provider."
  type        = string
  default     = "CRONOMETER_DEPLOY"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]{1,64}$", var.oci_config_profile))
    error_message = "oci_config_profile contains unsupported characters."
  }
}

variable "create_compartment" {
  description = "Create a dedicated compartment beneath parent_compartment_ocid (or the tenancy root)."
  type        = bool
  default     = true
}

variable "parent_compartment_ocid" {
  description = "Optional parent for the new compartment. Null means the tenancy root."
  type        = string
  default     = null

  validation {
    condition = (
      var.parent_compartment_ocid == null ||
      can(regex("^ocid1\\.(compartment|tenancy)\\.oc1\\.", var.parent_compartment_ocid))
    )
    error_message = "parent_compartment_ocid must be a compartment or tenancy OCID."
  }
}

variable "existing_compartment_ocid" {
  description = "Existing deployment compartment when create_compartment is false."
  type        = string
  default     = null

  validation {
    condition = (
      var.existing_compartment_ocid == null ||
      can(regex("^ocid1\\.(compartment|tenancy)\\.oc1\\.", var.existing_compartment_ocid))
    )
    error_message = "existing_compartment_ocid must be a compartment or tenancy OCID."
  }
}

variable "name_prefix" {
  description = "Short DNS-safe prefix for OCI display names and labels."
  type        = string
  default     = "cronometer-gold-beta"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,29}$", var.name_prefix))
    error_message = "name_prefix must be 3-30 lowercase DNS-safe characters and start with a letter."
  }
}

variable "compartment_name" {
  description = "Name of the optional dedicated compartment."
  type        = string
  default     = "cronometer-gold-beta"

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9_-]{2,99}$", var.compartment_name))
    error_message = "compartment_name must be 3-100 letters, digits, underscores, or hyphens."
  }
}

variable "availability_domain_index" {
  description = "Zero-based availability-domain index. Change it if A1 capacity is unavailable."
  type        = number
  default     = 0

  validation {
    condition     = floor(var.availability_domain_index) == var.availability_domain_index && var.availability_domain_index >= 0 && var.availability_domain_index <= 2
    error_message = "availability_domain_index must be 0, 1, or 2 in us-ashburn-1."
  }
}

variable "existing_vcn_ocid" {
  description = "OCID of the existing GRAD695 VCN. Free Tier has no internet-gateway quota for a second VCN."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.vcn\\.oc1\\.", var.existing_vcn_ocid))
    error_message = "existing_vcn_ocid must be an OCI VCN OCID."
  }
}

variable "existing_internet_gateway_ocid" {
  description = "OCID of the existing internet gateway already attached to existing_vcn_ocid. The module reads but never changes the gateway."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.internetgateway\\.oc1\\.", var.existing_internet_gateway_ocid))
    error_message = "existing_internet_gateway_ocid must be an OCI internet-gateway OCID."
  }
}

variable "vcn_cidr" {
  description = "Declared CIDR of the existing VCN. This tenancy-specific pilot accepts only the observed 10.0.0.0/16."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = var.vcn_cidr == "10.0.0.0/16"
    error_message = "This reviewed pilot is restricted to the live GRAD695 CIDR 10.0.0.0/16."
  }
}

variable "public_subnet_cidr" {
  description = "New isolated public edge subnet inside the existing VCN. Confirm that it does not overlap any live subnet."
  type        = string
  default     = "10.0.1.0/24"

  validation {
    condition     = can(regex("^10\\.0\\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])\\.0/24$", var.public_subnet_cidr))
    error_message = "public_subnet_cidr must be an aligned 10.0.1.0/24 through 10.0.254.0/24 range inside GRAD695."
  }
}

variable "known_subnet_cidrs" {
  description = "Complete reviewed list of subnet CIDRs already present in the VCN. Refresh it from OCI immediately before plan/apply; it is used to reject overlap."
  type        = set(string)
  default     = ["10.0.0.0/24"]

  validation {
    condition = contains(var.known_subnet_cidrs, "10.0.0.0/24") && alltrue([
      for cidr in var.known_subnet_cidrs : can(regex("^10\\.0\\.(?:0|[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])\\.0/24$", cidr))
    ])
    error_message = "known_subnet_cidrs must include the observed 10.0.0.0/24 subnet and list only aligned /24 ranges inside the reviewed VCN."
  }
}

variable "admin_cidrs" {
  description = "IPv4 CIDRs allowed to SSH. This pilot accepts only current operator egress addresses as /32."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for cidr in var.admin_cidrs : can(cidrhost(cidr, 0)) && can(regex("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}/32$", cidr))
    ])
    error_message = "Every admin CIDR must be one valid IPv4 /32; broader or IPv6 SSH sources are rejected."
  }
}

variable "ssh_authorized_keys" {
  description = "One public SSH key for the Oracle Linux opc user; Ed25519 is recommended. Never pass private keys."
  type        = set(string)
  default     = []

  validation {
    condition = length(var.ssh_authorized_keys) <= 1 && alltrue([
      for key in var.ssh_authorized_keys : length(trimspace(key)) <= 512 && can(regex("^[ -~]+$", trimspace(key))) && can(regex("^(ssh-ed25519|sk-ssh-ed25519@openssh.com|ssh-rsa) [A-Za-z0-9+/]+={0,3}( [ -~]*)?$", trimspace(key)))
    ])
    error_message = "ssh_authorized_keys must contain at most one printable-ASCII OpenSSH public key of at most 512 bytes. Prefer Ed25519 and add further keys on-host after bootstrap review."
  }
}

variable "object_storage_role_emails" {
  description = "Four distinct monitored primary email addresses required by OCI IAM identity domains for the non-console Object Storage service users."
  type = object({
    export_reader  = string
    export_writer  = string
    ledger_writer  = string
    ledger_restore = string
  })
  sensitive = true
  nullable  = false

  validation {
    condition = (
      length(toset([
        for email in values(var.object_storage_role_emails) : lower(trimspace(email))
        ])) == 4 && alltrue([
        for email in values(var.object_storage_role_emails) :
        email == trimspace(email) &&
        length(email) <= 254 &&
        can(regex("^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$", email))
      ])
    )
    error_message = "object_storage_role_emails must contain four distinct, trimmed, valid email addresses for export_reader, export_writer, ledger_writer, and ledger_restore."
  }
}

variable "compute_shape" {
  description = "Always Free-eligible Arm flexible shape. Other shapes are rejected by design."
  type        = string
  default     = "VM.Standard.A1.Flex"

  validation {
    condition     = var.compute_shape == "VM.Standard.A1.Flex"
    error_message = "This module only allows VM.Standard.A1.Flex."
  }
}

variable "compute_ocpus" {
  description = "A1 OCPUs. Hard-capped at the observed tenancy limit of 2."
  type        = number
  default     = 2

  validation {
    condition     = var.compute_ocpus >= 1 && var.compute_ocpus <= 2
    error_message = "compute_ocpus must be between 1 and 2."
  }
}

variable "compute_memory_gb" {
  description = "A1 memory. Hard-capped at the observed tenancy limit of 12 GB."
  type        = number
  default     = 12

  validation {
    condition     = var.compute_memory_gb >= 6 && var.compute_memory_gb <= 12
    error_message = "compute_memory_gb must be between 6 and 12 GB."
  }
}

variable "image_ocid" {
  description = "Explicit reviewed Oracle Linux 9 Arm image OCID. Required to prevent a later apply from silently selecting a newer platform image."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.image\\.oc1\\.", var.image_ocid))
    error_message = "image_ocid must be an OCI image OCID."
  }
}

variable "boot_volume_size_gb" {
  description = "Encrypted boot volume size. Fixed at the reviewed 100 GB so the 48 GiB free-space startup gate is achievable."
  type        = number
  default     = 100

  validation {
    condition     = var.boot_volume_size_gb == 100
    error_message = "boot_volume_size_gb must remain exactly 100 GB for this controlled beta."
  }
}

variable "kms_key_id" {
  description = "Optional existing OCI Vault master-encryption-key OCID. Null uses OCI-managed encryption at rest and avoids creating a billable Vault key."
  type        = string
  default     = null

  validation {
    condition     = var.kms_key_id == null || can(regex("^ocid1\\.key\\.oc1\\.", var.kms_key_id))
    error_message = "kms_key_id must be an OCI key OCID."
  }
}

variable "base_domain" {
  description = "Owned public DNS domain, without a scheme or trailing dot (for example, example.com)."
  type        = string

  validation {
    condition = (
      length(var.base_domain) <= 253 &&
      can(regex("^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$", var.base_domain)) &&
      !endswith(var.base_domain, ".")
    )
    error_message = "base_domain must be an owned public DNS name without a scheme, path, or trailing dot."
  }
}

variable "api_subdomain" {
  description = "DNS label for the public API origin used by release builds."
  type        = string
  default     = "api"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", var.api_subdomain))
    error_message = "api_subdomain must be a lowercase DNS label."
  }
}

variable "web_subdomain" {
  description = "DNS label for the browser application."
  type        = string
  default     = "app"

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", var.web_subdomain))
    error_message = "web_subdomain must be a lowercase DNS label."
  }
}

variable "create_oci_dns_records" {
  description = "Create API and web A records in an existing OCI DNS zone. Disabled because OCI DNS can incur charges."
  type        = bool
  default     = false
}

variable "dns_zone_name_or_id" {
  description = "Existing OCI DNS public-zone name or OCID when create_oci_dns_records is true."
  type        = string
  default     = null
}

variable "dns_ttl_seconds" {
  description = "TTL for optional public A records."
  type        = number
  default     = 300

  validation {
    condition     = floor(var.dns_ttl_seconds) == var.dns_ttl_seconds && var.dns_ttl_seconds >= 30 && var.dns_ttl_seconds <= 86400
    error_message = "dns_ttl_seconds must be an integer between 30 and 86400."
  }
}

variable "acknowledge_non_ha_and_possible_charges" {
  description = "Deliberate apply gate. Set true only after checking service limits, Free Tier eligibility, DNS pricing, and accepting this single-node non-HA pilot."
  type        = bool
  default     = false
}

variable "freeform_tags" {
  description = "Additional free-form OCI tags."
  type        = map(string)
  default     = {}
}
