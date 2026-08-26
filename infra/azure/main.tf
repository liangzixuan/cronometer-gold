resource "azurerm_resource_group" "beta" {
  name     = "${var.name_prefix}-rg"
  location = local.location
  tags     = local.required_tags

  lifecycle {
    precondition {
      condition     = var.deployment_acknowledgement == local.exact_deployment_acknowledgement
      error_message = "Stop: the exact synthetic-only, non-HA, on-demand cost acknowledgement is required before planning or applying."
    }

    precondition {
      condition = try(
        timecmp(var.live_preflight.checked_at_utc, plantimestamp()) <= 0 &&
        timecmp(var.live_preflight.checked_at_utc, timeadd(plantimestamp(), "-4h")) >= 0,
        false,
      )
      error_message = "Stop: live_preflight must have been collected no more than four hours before this plan."
    }

    precondition {
      condition = try(
        timecmp(var.live_preflight.checked_at_utc, timestamp()) <= 0 &&
        timecmp(var.live_preflight.checked_at_utc, timeadd(timestamp(), "-4h")) >= 0,
        false,
      )
      error_message = "Stop: live_preflight is stale at apply time. Collect fresh checks and create a new saved plan."
    }

    precondition {
      condition = try(
        formatdate("YYYY-MM", var.budget_start_date_utc) == formatdate("YYYY-MM", plantimestamp()) &&
        formatdate("YYYY-MM", var.budget_start_date_utc) == formatdate("YYYY-MM", timestamp()),
        false,
      )
      error_message = "Stop: budget_start_date_utc must be the first UTC instant of the current plan and apply month. Create a new saved plan after a month boundary."
    }

    precondition {
      condition = (
        lower(var.live_preflight.subscription_id) == lower(var.subscription_id) &&
        var.live_preflight.subscription_state == "Enabled" &&
        lower(var.live_preflight.subscription_quota_id) == "azureforstudents_2018-01-01" &&
        var.live_preflight.spending_limit == "On" &&
        var.live_preflight.credit_currency == "USD" &&
        var.live_preflight.remaining_credit_usd >= var.monthly_budget_amount_usd
      )
      error_message = "Stop: the selected subscription must be Enabled with the live Azure for Students quotaId AzureForStudents_2018-01-01, retain spendingLimit=On, use USD credit, and have at least the configured monthly budget remaining. Do not upgrade or disable the spending limit."
    }

    precondition {
      condition = try(
        timecmp(var.live_preflight.credit_expires_at_utc, timeadd(plantimestamp(), "168h")) >= 0 &&
        timecmp(var.live_preflight.credit_expires_at_utc, timeadd(timestamp(), "168h")) >= 0,
        false,
      )
      error_message = "Stop: the reviewed Azure for Students credit must remain valid for at least seven days after both plan and apply. Revoke OCI credentials and release trust bindings before credit expiry."
    }

    precondition {
      condition = try(
        timecmp(var.first_session_shutdown_deadline_utc, timeadd(plantimestamp(), "1h")) >= 0 &&
        timecmp(var.first_session_shutdown_deadline_utc, timeadd(plantimestamp(), "4h")) <= 0 &&
        timecmp(var.first_session_shutdown_deadline_utc, timeadd(timestamp(), "1h")) >= 0 &&
        timecmp(var.first_session_shutdown_deadline_utc, timeadd(timestamp(), "4h")) <= 0,
        false,
      )
      error_message = "Stop: first_session_shutdown_deadline_utc must remain between one and four hours after both plan and apply. Create a fresh saved plan for the attended empty-host session."
    }

    precondition {
      condition = (
        var.live_preflight.checked_location == local.location &&
        var.live_preflight.vm_sku == local.vm_size &&
        var.live_preflight.vm_sku_available &&
        length(var.live_preflight.vm_sku_restrictions) == 0 &&
        var.live_preflight.vm_vcpus == 2 &&
        var.live_preflight.vm_memory_gb == 16 &&
        var.live_preflight.vm_cpu_architecture == "Arm64" &&
        contains(var.live_preflight.vm_hyperv_generations, "V2") &&
        !var.live_preflight.vm_trusted_launch_disabled &&
        var.live_preflight.regional_vcpu_remaining >= 2 &&
        var.live_preflight.epsv5_family_vcpu_remaining >= 2
      )
      error_message = "Stop: Standard_E2ps_v5 must be live and unrestricted in eastus2 with exactly 2 vCPU/16 GiB, Arm64, Generation 2, Trusted Launch support, and at least two remaining regional and Epsv5-family vCPUs. No alternate region, size, Spot, or paid fallback is permitted."
    }

    precondition {
      condition = (
        var.live_preflight.image_publisher == local.image_publisher &&
        var.live_preflight.image_offer == local.image_offer &&
        var.live_preflight.image_sku == local.image_sku &&
        var.live_preflight.image_version == var.ubuntu_image_version &&
        var.live_preflight.image_available &&
        var.live_preflight.image_architecture == "Arm64" &&
        var.live_preflight.image_hyperv_generation == "V2" &&
        length(var.live_preflight.image_security_types) > 0 &&
        length(setsubtract(
          var.live_preflight.image_security_types,
          toset(["TrustedLaunch", "TrustedLaunchSupported", "TrustedLaunchAndConfidentialVmSupported"]),
        )) == 0 &&
        !var.live_preflight.image_plan_required &&
        var.live_preflight.image_location == local.location &&
        var.live_preflight.image_state == "Active"
      )
      error_message = "Stop: the exact Canonical Ubuntu 24.04 LTS image must be active and available in eastus2 and report Arm64, Hyper-V V2, an admitted Trusted Launch SecurityType, and no Marketplace plan."
    }

    precondition {
      condition     = length(setsubtract(local.required_resource_providers, var.live_preflight.registered_resource_providers)) == 0
      error_message = "Stop: every required Azure resource provider must already be registered. This provider is configured never to register providers automatically."
    }

    precondition {
      condition     = var.admin_ipv4_cidr == var.beta_allowed_ipv4_cidr
      error_message = "Stop: this controlled beta requires the same single current public /32 for SSH and the future Caddy application allowlist."
    }
  }
}
