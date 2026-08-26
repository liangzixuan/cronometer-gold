#!/usr/bin/env python3
"""Fail-closed static contracts for the Azure infrastructure-only pivot."""

from __future__ import annotations

import pathlib
import re


ROOT = pathlib.Path(__file__).resolve().parents[1]


def read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


versions = read("versions.tf")
provider_lock = read(".terraform.lock.hcl")
locals_tf = read("locals.tf")
variables = read("variables.tf")
main = read("main.tf")
network = read("network.tf")
compute = read("compute.tf")
budget = read("budget.tf")
outputs = read("outputs.tf")
readme = read("README.md")
tfvars_example = read("terraform.tfvars.example")
gitignore = read(".gitignore")
auditor = read("tests/audit_saved_plan.py")
apply_wrapper = read("tests/apply_audited_plan.py")

terraform = "\n".join(
    path.read_text(encoding="utf-8")
    for path in sorted(ROOT.glob("*.tf"))
)


def resource_body(resource_type: str, resource_name: str) -> str:
    marker = f'resource "{resource_type}" "{resource_name}"'
    start = terraform.find(marker)
    assert start >= 0, f"missing {marker}"
    opening = terraform.find("{", start + len(marker))
    assert opening >= 0
    depth = 0
    quoted = False
    escaped = False
    for index in range(opening, len(terraform)):
        char = terraform[index]
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
            continue
        if char == '"':
            quoted = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return terraform[opening + 1 : index]
    raise AssertionError(f"unterminated {marker}")


# Provider and global admission gates.
assert 'version = "= 4.79.0"' in versions
assert 'provider "registry.terraform.io/hashicorp/azurerm"' in provider_lock
assert 'version     = "4.79.0"' in provider_lock
assert 'constraints = "4.79.0"' in provider_lock
assert provider_lock.count("provider ") == 1
exact_provider_block = '''provider "azurerm" {
  subscription_id                 = var.subscription_id
  resource_provider_registrations = "none"

  features {
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
}'''
assert versions.count('provider "azurerm"') == 1
assert exact_provider_block in versions
assert "skip_provider_registration" not in versions
assert 'location       = "eastus2"' in locals_tf
assert 'vm_size        = "Standard_E2ps_v5"' in locals_tf
assert "plantimestamp()" in main
assert "timestamp()" in main
assert 'timeadd(plantimestamp(), "-4h")' in main
assert 'timeadd(timestamp(), "-4h")' in main
assert 'formatdate("YYYY-MM", var.budget_start_date_utc)' in main
assert 'var.live_preflight.spending_limit == "On"' in main
assert 'lower(var.live_preflight.subscription_quota_id) == "azureforstudents_2018-01-01"' in main
assert "lower(var.live_preflight.subscription_id) == lower(var.subscription_id)" in main
assert "remaining_credit_usd >= var.monthly_budget_amount_usd" in main
assert 'timeadd(plantimestamp(), "168h")' in main
assert 'timeadd(timestamp(), "168h")' in main
assert "var.live_preflight.credit_expires_at_utc" in main
assert 'timeadd(plantimestamp(), "4h")' in main
assert 'timeadd(timestamp(), "4h")' in main
assert "var.first_session_shutdown_deadline_utc" in main
assert "setsubtract(local.required_resource_providers" in main
assert "var.admin_ipv4_cidr == var.beta_allowed_ipv4_cidr" in main
assert "exact_deployment_acknowledgement" in main
assert "var.live_preflight.vm_vcpus == 2" in main
assert "var.live_preflight.vm_memory_gb == 16" in main
assert 'var.live_preflight.vm_cpu_architecture == "Arm64"' in main
assert 'contains(var.live_preflight.vm_hyperv_generations, "V2")' in main
assert "!var.live_preflight.vm_trusted_launch_disabled" in main
assert "var.live_preflight.regional_vcpu_remaining >= 2" in main
assert "var.live_preflight.epsv5_family_vcpu_remaining >= 2" in main
assert 'var.live_preflight.image_architecture == "Arm64"' in main
assert 'var.live_preflight.image_hyperv_generation == "V2"' in main
assert "var.live_preflight.image_security_types" in main
assert "!var.live_preflight.image_plan_required" in main
assert "var.live_preflight.image_location == local.location" in main
assert 'var.live_preflight.image_state == "Active"' in main

for required_tag, value in {
    "data-classification": "synthetic-only",
    "availability": "single-server-non-ha",
    "purchase-model": "on-demand",
    "terraform-scope": "empty-host-only",
}.items():
    assert f'"{required_tag}"' in locals_tf
    assert f'= "{value}"' in locals_tf

for provider_namespace in (
    "Microsoft.Authorization",
    "Microsoft.Compute",
    "Microsoft.Consumption",
    "Microsoft.DevTestLab",
    "Microsoft.Network",
    "Microsoft.Resources",
):
    assert f'"{provider_namespace}"' in locals_tf

# The graph is intentionally small and contains no paid/service fallback.
expected_resources = {
    "azurerm_resource_group": 1,
    "azurerm_virtual_network": 1,
    "azurerm_subnet": 1,
    "azurerm_network_security_group": 1,
    "azurerm_subnet_network_security_group_association": 1,
    "azurerm_public_ip": 1,
    "azurerm_network_interface": 1,
    "azurerm_linux_virtual_machine": 1,
    "azurerm_managed_disk": 1,
    "azurerm_virtual_machine_data_disk_attachment": 1,
    "azurerm_management_lock": 2,
    "azurerm_dev_test_global_vm_shutdown_schedule": 1,
    "azurerm_consumption_budget_resource_group": 1,
}
actual_resources: dict[str, int] = {}
for resource_type in re.findall(r'(?m)^resource "([^"]+)" "[^"]+" \{', terraform):
    actual_resources[resource_type] = actual_resources.get(resource_type, 0) + 1
assert actual_resources == expected_resources, actual_resources

for forbidden in (
    "azurerm_bastion_host",
    "azurerm_capacity_reservation",
    "azurerm_container_registry",
    "azurerm_dns_",
    "azurerm_key_vault",
    "azurerm_lb",
    "azurerm_linux_virtual_machine_scale_set",
    "azurerm_mssql",
    "azurerm_mysql",
    "azurerm_nat_gateway",
    "azurerm_postgresql",
    "azurerm_private_dns",
    "azurerm_recovery_services_vault",
    "azurerm_redis",
    "azurerm_storage_",
    "azurerm_virtual_machine_scale_set",
):
    assert forbidden not in terraform

# Exact network surface: one /32 SSH rule and public Caddy ports 80/443.
nsg = resource_body("azurerm_network_security_group", "beta")
assert nsg.count("security_rule {") == 3
assert nsg.count('direction                  = "Inbound"') == 3
assert nsg.count('access                     = "Allow"') == 3
assert 'destination_port_range     = "22"' in nsg
assert 'source_address_prefix      = var.admin_ipv4_cidr' in nsg
for port in ("80", "443"):
    port_pattern = re.compile(
        rf'security_rule \{{(?:(?!security_rule \{{).)*'
        rf'destination_port_range\s+=\s+"{port}"'
        rf'(?:(?!security_rule \{{).)*source_address_prefix\s+=\s+"Internet"',
        re.DOTALL,
    )
    assert port_pattern.search(nsg), f"port {port} must be public only for Caddy"
assert "0.0.0.0/0" not in network
assert 'default_outbound_access_enabled = false' in network

public_ip = resource_body("azurerm_public_ip", "beta")
for exact in (
    'allocation_method   = "Static"',
    'ip_version          = "IPv4"',
    'sku                 = "Standard"',
    'sku_tier            = "Regional"',
):
    assert exact in public_ip
assert "domain_name_label" not in public_ip
assert "prevent_destroy = true" in public_ip

public_ip_lock = resource_body("azurerm_management_lock", "public_ip")
assert "scope      = azurerm_public_ip.beta.id" in public_ip_lock
assert 'lock_level = "CanNotDelete"' in public_ip_lock
assert "prevent_destroy = true" in public_ip_lock
assert "revoking every retained-OCI credential" in public_ip_lock

# Exact Arm64 VM/image/storage and no app bootstrap or paid-priority knobs.
vm = resource_body("azurerm_linux_virtual_machine", "beta")
assert "size                            = local.vm_size" in vm
assert "disable_password_authentication = true" in vm
assert "admin_ssh_key {" in vm
assert "admin_password" not in vm
assert 'storage_account_type = "StandardSSD_LRS"' in vm
assert "disk_size_gb         = 64" in vm
assert "publisher = local.image_publisher" in vm
assert "offer     = local.image_offer" in vm
assert "sku       = local.image_sku" in vm
assert "version   = var.ubuntu_image_version" in vm
for forbidden in (
    "custom_data",
    "user_data",
    "priority",
    "eviction_policy",
    "max_bid_price",
    "plan {",
    "boot_diagnostics",
):
    assert forbidden not in vm

assert 'image_publisher = "Canonical"' in locals_tf
assert 'image_offer     = "ubuntu-24_04-lts"' in locals_tf
assert 'image_sku       = "server-arm64"' in locals_tf
assert 'var.ubuntu_image_version != "latest"' in variables

data_disk = resource_body("azurerm_managed_disk", "data")
assert 'storage_account_type = "StandardSSD_LRS"' in data_disk
assert 'create_option        = "Empty"' in data_disk
assert "disk_size_gb         = 64" in data_disk
assert "prevent_destroy = true" in data_disk

data_attachment = resource_body("azurerm_virtual_machine_data_disk_attachment", "data")
assert 'caching            = "None"' in data_attachment
assert 'caching            = "ReadWrite"' not in data_attachment

data_lock = resource_body("azurerm_management_lock", "data")
assert 'lock_level = "CanNotDelete"' in data_lock
assert "prevent_destroy = true" in data_lock

# Mandatory shutdown/no-start and multi-threshold budget email notifications.
shutdown = resource_body("azurerm_dev_test_global_vm_shutdown_schedule", "beta")
assert re.search(r"(?m)^\s*enabled\s+=\s+true$", shutdown)
assert 'daily_recurrence_time = formatdate("hhmm", var.first_session_shutdown_deadline_utc)' in shutdown
assert 'timezone              = "UTC"' in shutdown
assert "notification_settings {" in shutdown
assert "enabled         = true" in shutdown
assert "email           = local.shutdown_email" in shutdown
assert "azurerm_dev_test_global_vm_start_schedule" not in terraform
assert "auto_start" not in terraform.lower()

rg_budget = resource_body("azurerm_consumption_budget_resource_group", "beta")
assert "resource_group_id = azurerm_resource_group.beta.id" in rg_budget
assert 'time_grain        = "Monthly"' in rg_budget
assert "start_date = var.budget_start_date_utc" in rg_budget
assert rg_budget.count("notification {") == 4
assert rg_budget.count("contact_emails = var.alert_contact_emails") == 4
for threshold in (50, 80, 100):
    assert f"threshold      = {threshold}" in rg_budget
assert 'threshold_type = "Forecasted"' in rg_budget

# Examples are generic/non-runnable; secrets and live account data stay ignored.
assert tfvars_example.count("REPLACE_WITH_") >= 10
assert 'deployment_acknowledgement = ""' in tfvars_example
assert not re.search(r"\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b", tfvars_example, re.I)
assert "ssh-ed25519 AAAA" not in tfvars_example
assert not re.search(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}/32\b", tfvars_example)
for ignored in (
    ".terraform/",
    "*.tfstate",
    "*.tfplan",
    "*.plan-attestation.json",
    "terraform.tfvars",
    "*.auto.tfvars",
    "*.apply.log",
):
    assert ignored in gitignore

assert "NOT DEPLOYABLE YET" in readme
assert "`terraform plan` or `terraform apply`" in readme
assert "terraform init -backend=false -lockfile=readonly" in readme
assert "Name.com DNS must" in readme
assert "Phase 1: Azure host proof with Name.com unchanged" in readme
assert "Public Caddy certificate issuance is **not** a Phase 1 success criterion" in readme
assert "Phase 2: separately reviewed DNS cutover and external proof" in readme
assert "restore the recorded prior A-record state" in readme
assert "hybrid runtime implementation" in readme.lower()
assert "compute-only" in readme
assert re.search(r"existing OCI storage\s+resources\s+stay", readme, re.IGNORECASE)
assert "outbound TCP/443" in readme
assert re.search(r"must\s+not substitute node-local MinIO", readme)
assert "The protected data disk is **not a backup**" in readme
assert "approximately 24-hour RPO" in readme
assert "manual restore into a clean database" in readme
assert "revoke all four Customer Secret Keys and the offline restore API key" in readme
assert "verify that the revoked credentials are denied" in readme
assert re.search(r"remove or change the OCI network\s+source", readme)
assert "public-IP delete lock" in readme
assert "at least seven days" in readme
assert "four-hour first-session deadline" in readme
assert 'timeadd(plantimestamp(), "1h")' in main
assert 'timeadd(timestamp(), "1h")' in main
assert 'timeadd(plantimestamp(), "4h")' in main
assert 'timeadd(timestamp(), "4h")' in main
assert "shutdown schedule is enabled" in readme
assert "do not silently add billable" in readme.lower()
assert "budget is only a delayed alert" in readme
assert "No Spot priority, scale set, alternate size, reservation, or capacity fallback" in readme
assert re.search(r"does not accept an\s+operator-supplied JSON export", readme)
assert "empty-host.plan-attestation.json" in readme
assert "tests/apply_audited_plan.py" in readme
assert re.search(
    r"does not emit `applyable`, `complete`, or\s+`errored` metadata", readme
)
assert "never run a separate raw `terraform apply`" in readme
assert "absence continuously across the full ten-minute" in readme
assert "exact `PowerState/deallocated`" in readme
assert "distinct `EMERGENCY` error" in readme
assert "compute-charge containment, not rollback" in readme
assert "exact attested four-digit recurrence" in readme
assert re.search(r"mismatch stops before any\s+Azure mutation", readme)
assert 'REVIEWED_TERRAFORM_VERSION = "1.5.7"' in auditor
assert 'ATTESTATION_SCHEMA = "nutrition-tracker.azure-saved-plan-attestation.v2"' in auditor
assert 'DEFAULT_TERRAFORM_BINARY = Path("/opt/homebrew/bin/terraform")' in auditor
assert '[str(terraform), "show", "-json", str(path)]' in auditor
assert 'stat.S_IMODE(metadata.st_mode) == 0o600' in auditor
assert 'stat.S_IMODE(metadata.st_mode) == 0o700' in auditor
assert '"TF_CLI_CONFIG_FILE": "/dev/null"' in auditor
assert 'path.name.endswith(".plan-attestation.json")' in auditor
assert '"shutdown_schedule_utc_time": shutdown_utc_time' in auditor
assert "capture_output=True" in auditor
assert "shell=True" not in auditor
assert '[str(terraform), "apply", "-input=false", "-no-color", descriptor_path]' in apply_wrapper
assert 'descriptor_path = f"/dev/fd/{descriptor}"' in apply_wrapper
assert 'key in basic_keys or key in _TERRAFORM_ARM_AUTH_KEYS' in apply_wrapper
assert 'REVIEWED_AZURE_CLI_VERSION = "2.71.0"' in apply_wrapper
assert 'REVIEWED_AZURE_CLI_CORE_VERSION = "2.71.0"' in apply_wrapper
assert 'CONTAINMENT_SETTLE_SECONDS = 10 * 60' in apply_wrapper
assert 'APPLY_TIMEOUT_SECONDS = 30 * 60' in apply_wrapper
assert '"AZURE_EXTENSION_USE_DYNAMIC_INSTALL": "no"' in apply_wrapper
assert '"vm",\n            "deallocate"' in apply_wrapper
assert '"resource",\n                "show"' in apply_wrapper
assert 'document["properties"].get("provisioningState") == "Succeeded"' in apply_wrapper
assert 'document["properties"].get("timeZoneId") == "UTC"' in apply_wrapper
assert 'document["properties"]["dailyRecurrence"].get("time")' in apply_wrapper
assert apply_wrapper.count("_azure_cli_hash_matches(") >= 4
assert 'start_new_session=True' in apply_wrapper
assert 'pass_fds=(descriptor,)' in apply_wrapper
assert 'close_fds=True' in apply_wrapper
assert 'except BaseException as error:' in apply_wrapper
assert 'os.execve' not in apply_wrapper
assert 'os.umask(0o077)' in apply_wrapper
assert '"-auto-approve"' not in apply_wrapper
assert "shell=True" not in apply_wrapper
assert "LocalStack" not in terraform
assert 'output "runtime_deployment_status"' in outputs
assert "EMPTY_HOST_ONLY: runtime admission is external to this module" in outputs

print("Azure infrastructure static contracts passed")
