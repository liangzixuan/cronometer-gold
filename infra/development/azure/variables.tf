variable "subscription_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.subscription_id))
    error_message = "Select one explicit lowercase subscription UUID."
  }
}
variable "name_prefix" {
  type = string
  validation {
    condition     = can(regex("^nourishing-dev-[0-9a-f]{12}$", var.name_prefix))
    error_message = "Use a new nourishing-dev- prefix with twelve random hexadecimal characters."
  }
}
variable "admin_ipv4_cidr" {
  type = string
  validation {
    condition     = can(cidrnetmask(var.admin_ipv4_cidr)) && can(regex("/32$", var.admin_ipv4_cidr))
    error_message = "Use one current public IPv4 /32; the saved-plan auditor checks public routability."
  }
}
variable "ssh_public_key" {
  type      = string
  sensitive = true
}
variable "shutdown_deadline_utc" {
  type = string
  validation {
    condition     = can(regex("Z$", var.shutdown_deadline_utc)) && can(timecmp(var.shutdown_deadline_utc, var.shutdown_deadline_utc))
    error_message = "Use an explicit UTC shutdown deadline ending in Z."
  }
}
variable "live_preflight" {
  description = "Facts derived from the original Azure response receipts; not a signed deployment approval. The auditor binds their exact bytes."
  type = object({
    checked_at_utc     = string
    subscription_id    = string
    spending_limit     = string
    billing_limit      = string
    credit_currency    = string
    remaining_credit   = number
    credit_expires_utc = string
    regional_remaining = number
    family_remaining   = number
    source_sha256      = map(string)
  })
  sensitive = true
}
