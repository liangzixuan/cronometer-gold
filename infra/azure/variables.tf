variable "subscription_id" {
  description = "Azure for Students subscription UUID selected explicitly for this beta. It is not a secret, but keep the real value in ignored terraform.tfvars."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be one explicit Azure subscription UUID."
  }
}

variable "name_prefix" {
  description = "Short lowercase prefix for the dedicated Azure resource names."
  type        = string
  default     = "nutrition-beta"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,22}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must be 4-24 lowercase letters, digits, or hyphens, start with a letter, and end with a letter or digit."
  }
}

variable "deployment_acknowledgement" {
  description = "Exact, false-by-default acknowledgement from README.md. This module creates chargeable on-demand resources, not free-tier resources."
  type        = string
  default     = ""

  validation {
    condition     = var.deployment_acknowledgement == "" || var.deployment_acknowledgement == "I ACKNOWLEDGE THIS IS A SYNTHETIC-ONLY NON-HA ON-DEMAND AZURE BETA THAT CAN CONSUME CREDIT; THE HOST STARTS EMPTY; NO PAID FALLBACK OR AUTOMATIC START IS AUTHORIZED"
    error_message = "deployment_acknowledgement must be empty or exactly the reviewed acknowledgement printed in README.md."
  }
}

variable "admin_ipv4_cidr" {
  description = "The operator's current directly observed, globally routable IPv4 address as exactly one /32. This is the only SSH source."
  type        = string

  validation {
    condition = (
      can(cidrnetmask(var.admin_ipv4_cidr)) &&
      can(regex("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}/32$", var.admin_ipv4_cidr)) &&
      !can(regex("^(?:0\\.|10\\.|100\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.|127\\.|169\\.254\\.|172\\.(?:1[6-9]|2[0-9]|3[01])\\.|192\\.(?:0\\.0\\.|0\\.2\\.|168\\.)|198\\.(?:1[89]\\.|51\\.100\\.)|203\\.0\\.113\\.|(?:22[4-9]|23[0-9]|24[0-9]|25[0-5])\\.)", var.admin_ipv4_cidr))
    )
    error_message = "admin_ipv4_cidr must be exactly one globally routable IPv4 /32; private, shared, loopback, link-local, documentation, multicast, and reserved sources are rejected."
  }
}

variable "beta_allowed_ipv4_cidr" {
  description = "The one synthetic-beta reviewer IPv4 /32 that the future Caddy runtime must allow. It must equal admin_ipv4_cidr for this controlled beta."
  type        = string

  validation {
    condition = (
      can(cidrnetmask(var.beta_allowed_ipv4_cidr)) &&
      can(regex("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}/32$", var.beta_allowed_ipv4_cidr)) &&
      !can(regex("^(?:0\\.|10\\.|100\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.|127\\.|169\\.254\\.|172\\.(?:1[6-9]|2[0-9]|3[01])\\.|192\\.(?:0\\.0\\.|0\\.2\\.|168\\.)|198\\.(?:1[89]\\.|51\\.100\\.)|203\\.0\\.113\\.|(?:22[4-9]|23[0-9]|24[0-9]|25[0-5])\\.)", var.beta_allowed_ipv4_cidr))
    )
    error_message = "beta_allowed_ipv4_cidr must be exactly one globally routable IPv4 /32."
  }
}

variable "ssh_public_key" {
  description = "One Ed25519 OpenSSH public key for azureuser. Never provide a private key or a certificate."
  type        = string
  sensitive   = true

  validation {
    condition = (
      length(var.ssh_public_key) <= 256 &&
      can(regex("^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( [ -~]+)?$", var.ssh_public_key)) &&
      !strcontains(var.ssh_public_key, "\n") &&
      !strcontains(var.ssh_public_key, "\r")
    )
    error_message = "ssh_public_key must be one single-line Ed25519 OpenSSH public key of at most 256 characters."
  }
}

variable "ubuntu_image_version" {
  description = "Exact live Canonical Ubuntu 24.04 LTS Arm64 Marketplace image version verified in eastus2. The floating value latest is rejected."
  type        = string

  validation {
    condition     = var.ubuntu_image_version != "latest" && can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.ubuntu_image_version))
    error_message = "ubuntu_image_version must be an exact numeric Azure image version (publisher:offer:sku is pinned); latest and placeholders are rejected."
  }
}

variable "alert_contact_emails" {
  description = "One to five monitored email addresses for mandatory RG budget and VM shutdown notifications."
  type        = set(string)

  validation {
    condition = (
      length(var.alert_contact_emails) >= 1 &&
      length(var.alert_contact_emails) <= 5 &&
      alltrue([
        for email in var.alert_contact_emails :
        email == trimspace(email) &&
        length(email) <= 254 &&
        can(regex("^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$", email))
      ])
    )
    error_message = "alert_contact_emails must contain one to five distinct, trimmed, valid monitored email addresses."
  }
}

variable "first_session_shutdown_deadline_utc" {
  description = "Fresh RFC 3339 UTC deadline for the first empty-host session. It must remain between one and four hours after both plan and apply; its UTC time becomes the recurring daily shutdown time. Azure never auto-starts this VM."
  type        = string

  validation {
    condition     = can(timecmp(var.first_session_shutdown_deadline_utc, var.first_session_shutdown_deadline_utc))
    error_message = "first_session_shutdown_deadline_utc must be an RFC 3339 UTC timestamp."
  }
}

variable "monthly_budget_amount_usd" {
  description = "Mandatory resource-group budget alert amount in USD. A budget alerts but does not cap spending."
  type        = number
  default     = 20

  validation {
    condition     = var.monthly_budget_amount_usd >= 5 && var.monthly_budget_amount_usd <= 25
    error_message = "monthly_budget_amount_usd must remain between USD 5 and USD 25 for this credit-funded beta."
  }
}

variable "budget_start_date_utc" {
  description = "First UTC instant of the current calendar month, verified when live_preflight is collected (for example 2026-08-01T00:00:00Z)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{4}-(?:0[1-9]|1[0-2])-01T00:00:00Z$", var.budget_start_date_utc)) && can(timecmp(var.budget_start_date_utc, var.budget_start_date_utc))
    error_message = "budget_start_date_utc must be the first UTC instant of a calendar month in RFC 3339 form."
  }
}

variable "live_preflight" {
  description = "Fresh read-only Azure evidence collected immediately before plan and rechecked before apply. No value is inferred by Terraform."
  type = object({
    checked_at_utc                = string
    subscription_id               = string
    subscription_state            = string
    subscription_quota_id         = string
    spending_limit                = string
    remaining_credit_usd          = number
    credit_currency               = string
    credit_expires_at_utc         = string
    checked_location              = string
    vm_sku                        = string
    vm_sku_available              = bool
    vm_sku_restrictions           = set(string)
    vm_vcpus                      = number
    vm_memory_gb                  = number
    vm_cpu_architecture           = string
    vm_hyperv_generations         = set(string)
    vm_trusted_launch_disabled    = bool
    regional_vcpu_remaining       = number
    epsv5_family_vcpu_remaining   = number
    image_publisher               = string
    image_offer                   = string
    image_sku                     = string
    image_version                 = string
    image_available               = bool
    image_architecture            = string
    image_hyperv_generation       = string
    image_security_types          = set(string)
    image_plan_required           = bool
    image_location                = string
    image_state                   = string
    registered_resource_providers = set(string)
  })
  sensitive = true

  validation {
    condition = (
      can(timecmp(var.live_preflight.checked_at_utc, var.live_preflight.checked_at_utc)) &&
      can(timecmp(var.live_preflight.credit_expires_at_utc, var.live_preflight.credit_expires_at_utc))
    )
    error_message = "live_preflight checked_at_utc and credit_expires_at_utc must be RFC 3339 timestamps."
  }
}
