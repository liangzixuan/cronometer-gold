#!/usr/bin/env python3
"""Fail-closed semantic auditor for the Azure empty-host saved plan.

The command-line boundary accepts only a private binary ``.tfplan`` and invokes
the reviewed Terraform binary to render JSON internally. The lower-level
``audit_plan`` function accepts parsed JSON only as a unit-test seam. Neither
path prints plan values because they include the SSH public key and live
subscription evidence.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import ipaddress
import json
import os
import re
import stat
import struct
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable


MAX_PLAN_JSON_BYTES = 20 * 1024 * 1024
MAX_BINARY_PLAN_BYTES = 512 * 1024 * 1024
TERRAFORM_TIMEOUT_SECONDS = 60
REVIEWED_TERRAFORM_VERSION = "1.5.7"
DEFAULT_TERRAFORM_BINARY = Path("/opt/homebrew/bin/terraform")
INFRA_ROOT = Path(__file__).resolve().parents[1]
ATTESTATION_SCHEMA = "nutrition-tracker.azure-saved-plan-attestation.v2"
AZURERM_PROVIDER = "registry.terraform.io/hashicorp/azurerm"
EXACT_ACKNOWLEDGEMENT = (
    "I ACKNOWLEDGE THIS IS A SYNTHETIC-ONLY NON-HA ON-DEMAND AZURE BETA "
    "THAT CAN CONSUME CREDIT; THE HOST STARTS EMPTY; NO PAID FALLBACK OR "
    "AUTOMATIC START IS AUTHORIZED"
)
REQUIRED_TAGS = {
    "availability": "single-server-non-ha",
    "data-classification": "synthetic-only",
    "environment": "beta",
    "managed-by": "terraform",
    "purchase-model": "on-demand",
    "terraform-scope": "empty-host-only",
}
REQUIRED_PROVIDERS = {
    "Microsoft.Authorization",
    "Microsoft.Compute",
    "Microsoft.Consumption",
    "Microsoft.DevTestLab",
    "Microsoft.Network",
    "Microsoft.Resources",
}
EXPECTED_SCHEMA_VERSIONS = {
    "azurerm_consumption_budget_resource_group.beta": 0,
    "azurerm_dev_test_global_vm_shutdown_schedule.beta": 0,
    "azurerm_linux_virtual_machine.beta": 0,
    "azurerm_managed_disk.data": 1,
    "azurerm_management_lock.data": 0,
    "azurerm_management_lock.public_ip": 0,
    "azurerm_network_interface.beta": 0,
    "azurerm_network_security_group.beta": 0,
    "azurerm_public_ip.beta": 0,
    "azurerm_resource_group.beta": 0,
    "azurerm_subnet.beta": 0,
    "azurerm_subnet_network_security_group_association.beta": 0,
    "azurerm_virtual_machine_data_disk_attachment.data": 0,
    "azurerm_virtual_network.beta": 0,
}
EXPECTED_CREATES = frozenset(EXPECTED_SCHEMA_VERSIONS)
EXPECTED_VARIABLES = frozenset(
    {
        "admin_ipv4_cidr",
        "alert_contact_emails",
        "beta_allowed_ipv4_cidr",
        "budget_start_date_utc",
        "deployment_acknowledgement",
        "first_session_shutdown_deadline_utc",
        "live_preflight",
        "monthly_budget_amount_usd",
        "name_prefix",
        "ssh_public_key",
        "subscription_id",
        "ubuntu_image_version",
    }
)


class PlanAuditError(ValueError):
    """Raised when a saved plan is not the exact reviewed empty-host graph."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise PlanAuditError(message)


def _exact_keys(value: Any, expected: set[str] | frozenset[str], label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} must be an object")
    _require(set(value) == set(expected), f"{label} has omitted or unreviewed fields")
    return value


def _parse_utc(value: Any, label: str) -> datetime:
    _require(
        isinstance(value, str) and value.endswith("Z"),
        f"{label} must be an RFC3339 UTC timestamp",
    )
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise PlanAuditError(f"{label} must be an RFC3339 UTC timestamp") from error
    _require(parsed.tzinfo == timezone.utc, f"{label} must use UTC")
    return parsed


def _variable_values(document: dict[str, Any]) -> dict[str, Any]:
    variables = _exact_keys(document.get("variables"), EXPECTED_VARIABLES, "plan variables")
    result: dict[str, Any] = {}
    for name, wrapper in variables.items():
        result[name] = _exact_keys(wrapper, {"value"}, f"variable {name}")["value"]
    return result


def _audit_public_ipv4_cidr(value: Any) -> str:
    _require(isinstance(value, str), "admin IPv4 source must be a string")
    try:
        network = ipaddress.ip_network(value, strict=True)
    except ValueError as error:
        raise PlanAuditError("admin IPv4 source must be one canonical /32") from error
    _require(
        isinstance(network, ipaddress.IPv4Network)
        and network.prefixlen == 32
        and network.network_address.is_global,
        "admin IPv4 source must be one globally routable /32",
    )
    return value


def _audit_ssh_public_key(value: Any) -> str:
    _require(
        isinstance(value, str) and "\n" not in value and "\r" not in value,
        "SSH key must be one line",
    )
    parts = value.split(" ", 2)
    _require(len(parts) >= 2 and parts[0] == "ssh-ed25519", "SSH key must be Ed25519")
    try:
        blob = base64.b64decode(parts[1], validate=True)
        algorithm_length = struct.unpack(">I", blob[:4])[0]
        offset = 4 + algorithm_length
        key_length = struct.unpack(">I", blob[offset : offset + 4])[0]
    except (ValueError, binascii.Error, struct.error) as error:
        raise PlanAuditError("SSH key must contain a valid OpenSSH Ed25519 blob") from error
    _require(blob[4:offset] == b"ssh-ed25519", "SSH key algorithm blob is not Ed25519")
    _require(
        key_length == 32 and len(blob) == offset + 4 + key_length,
        "SSH key must contain one 32-byte Ed25519 key",
    )
    _require(len(value) <= 256, "SSH key exceeds the reviewed length")
    return value


def _audit_inputs(document: dict[str, Any]) -> dict[str, Any]:
    values = _variable_values(document)
    _require(
        values["deployment_acknowledgement"] == EXACT_ACKNOWLEDGEMENT,
        "exact cost acknowledgement is required",
    )
    _require(
        isinstance(values["subscription_id"], str)
        and re.fullmatch(
            r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}",
            values["subscription_id"],
        )
        is not None,
        "subscription_id must be one UUID",
    )
    _require(
        isinstance(values["name_prefix"], str)
        and re.fullmatch(r"[a-z][a-z0-9-]{2,22}[a-z0-9]", values["name_prefix"])
        is not None,
        "name_prefix is outside the reviewed contract",
    )
    admin_cidr = _audit_public_ipv4_cidr(values["admin_ipv4_cidr"])
    _require(
        values["beta_allowed_ipv4_cidr"] == admin_cidr,
        "SSH and beta access must use the same /32",
    )
    _audit_ssh_public_key(values["ssh_public_key"])
    _require(
        isinstance(values["ubuntu_image_version"], str)
        and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", values["ubuntu_image_version"])
        is not None,
        "Ubuntu image version must be exact and numeric",
    )
    emails = values["alert_contact_emails"]
    _require(
        isinstance(emails, list)
        and 1 <= len(emails) <= 5
        and all(isinstance(email, str) for email in emails)
        and len(set(emails)) == len(emails),
        "one to five distinct alert emails are required",
    )
    for email in emails:
        _require(
            isinstance(email, str)
            and len(email) <= 254
            and re.fullmatch(
                r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9]"
                r"(?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}",
                email,
            )
            is not None,
            "alert email is outside the reviewed contract",
        )
    amount = values["monthly_budget_amount_usd"]
    _require(
        isinstance(amount, (int, float))
        and not isinstance(amount, bool)
        and 5 <= amount <= 25,
        "budget amount must remain USD 5-25",
    )

    preflight_value = values["live_preflight"]
    plan_time = _parse_utc(document.get("timestamp"), "plan timestamp")
    checked_at = _parse_utc(
        preflight_value.get("checked_at_utc") if isinstance(preflight_value, dict) else None,
        "preflight timestamp",
    )
    expiry = _parse_utc(
        preflight_value.get("credit_expires_at_utc") if isinstance(preflight_value, dict) else None,
        "credit expiry",
    )
    shutdown = _parse_utc(
        values["first_session_shutdown_deadline_utc"], "shutdown deadline"
    )
    budget_start = _parse_utc(values["budget_start_date_utc"], "budget start")
    _require(
        plan_time - timedelta(hours=4) <= checked_at <= plan_time,
        "live preflight is stale or future-dated",
    )
    _require(
        expiry >= plan_time + timedelta(hours=168),
        "student credit has less than seven days remaining",
    )
    _require(
        plan_time + timedelta(hours=1) <= shutdown <= plan_time + timedelta(hours=4),
        "shutdown deadline is outside the one-to-four-hour window",
    )
    _require(
        budget_start.day == 1
        and budget_start.hour
        == budget_start.minute
        == budget_start.second
        == budget_start.microsecond
        == 0
        and (budget_start.year, budget_start.month) == (plan_time.year, plan_time.month),
        "budget start must be the first UTC instant of the plan month",
    )

    preflight_keys = {
        "checked_at_utc",
        "subscription_id",
        "subscription_state",
        "subscription_quota_id",
        "spending_limit",
        "remaining_credit_usd",
        "credit_currency",
        "credit_expires_at_utc",
        "checked_location",
        "vm_sku",
        "vm_sku_available",
        "vm_sku_restrictions",
        "vm_vcpus",
        "vm_memory_gb",
        "vm_cpu_architecture",
        "vm_hyperv_generations",
        "vm_trusted_launch_disabled",
        "regional_vcpu_remaining",
        "epsv5_family_vcpu_remaining",
        "image_publisher",
        "image_offer",
        "image_sku",
        "image_version",
        "image_available",
        "image_architecture",
        "image_hyperv_generation",
        "image_security_types",
        "image_plan_required",
        "image_location",
        "image_state",
        "registered_resource_providers",
    }
    preflight = _exact_keys(preflight_value, preflight_keys, "live_preflight")
    expected_exact = {
        "subscription_id": values["subscription_id"],
        "subscription_state": "Enabled",
        "subscription_quota_id": "AzureForStudents_2018-01-01",
        "spending_limit": "On",
        "credit_currency": "USD",
        "checked_location": "eastus2",
        "vm_sku": "Standard_E2ps_v5",
        "vm_sku_available": True,
        "vm_vcpus": 2,
        "vm_memory_gb": 16,
        "vm_cpu_architecture": "Arm64",
        "vm_trusted_launch_disabled": False,
        "image_publisher": "Canonical",
        "image_offer": "ubuntu-24_04-lts",
        "image_sku": "server-arm64",
        "image_version": values["ubuntu_image_version"],
        "image_available": True,
        "image_architecture": "Arm64",
        "image_hyperv_generation": "V2",
        "image_plan_required": False,
        "image_location": "eastus2",
        "image_state": "Active",
    }
    for key, expected in expected_exact.items():
        actual = preflight[key]
        if key in {"subscription_id", "subscription_quota_id"} and isinstance(actual, str):
            actual, expected = actual.lower(), str(expected).lower()
        _require(actual == expected, f"live_preflight.{key} is outside the reviewed contract")
    remaining_credit = preflight["remaining_credit_usd"]
    regional_quota = preflight["regional_vcpu_remaining"]
    family_quota = preflight["epsv5_family_vcpu_remaining"]
    _require(
        isinstance(remaining_credit, (int, float))
        and not isinstance(remaining_credit, bool)
        and remaining_credit >= amount,
        "remaining student credit is below the budget",
    )
    _require(
        isinstance(regional_quota, (int, float))
        and not isinstance(regional_quota, bool)
        and isinstance(family_quota, (int, float))
        and not isinstance(family_quota, bool)
        and regional_quota >= 2
        and family_quota >= 2,
        "required VM quota is unavailable",
    )
    _require(
        preflight["vm_sku_restrictions"] == [],
        "VM SKU restrictions are not admitted",
    )
    _require(
        isinstance(preflight["vm_hyperv_generations"], list)
        and all(
            isinstance(generation, str)
            for generation in preflight["vm_hyperv_generations"]
        )
        and "V2" in preflight["vm_hyperv_generations"],
        "VM must support Hyper-V V2",
    )
    admitted_security = {
        "TrustedLaunch",
        "TrustedLaunchSupported",
        "TrustedLaunchAndConfidentialVmSupported",
    }
    image_security = preflight["image_security_types"]
    _require(
        isinstance(image_security, list)
        and image_security
        and all(isinstance(item, str) for item in image_security)
        and set(image_security) <= admitted_security,
        "image security type is not admitted",
    )
    providers = preflight["registered_resource_providers"]
    _require(
        isinstance(providers, list)
        and all(isinstance(provider, str) for provider in providers)
        and REQUIRED_PROVIDERS <= set(providers),
        "required Azure providers are not registered",
    )
    return values


def _require_field(after: dict[str, Any], key: str, expected: Any, address: str) -> None:
    _require(key in after, f"{address}.after omits {key}")
    _require(
        after.pop(key) == expected,
        f"{address}.after.{key} is outside the reviewed contract",
    )


def _require_field_where(
    after: dict[str, Any], key: str, predicate: Callable[[Any], bool], address: str
) -> Any:
    _require(key in after, f"{address}.after omits {key}")
    value = after.pop(key)
    _require(predicate(value), f"{address}.after.{key} is outside the reviewed contract")
    return value


def _neutral(value: Any) -> bool:
    return (
        value is None
        or value is False
        or value == ""
        or (isinstance(value, (list, dict)) and not value)
    )


def _finish_after(after: dict[str, Any], address: str) -> None:
    unreviewed = [key for key, value in after.items() if not _neutral(value)]
    _require(
        not unreviewed,
        f"{address}.after contains unreviewed non-empty fields",
    )


def _audit_nested(value: Any, required: dict[str, Any], label: str) -> None:
    _require(isinstance(value, dict), f"{label} must be an object")
    remaining = dict(value)
    for key, expected in required.items():
        _require_field(remaining, key, expected, label)
    _finish_after(remaining, label)


def _audit_nsg_rules(value: Any, admin_cidr: str) -> None:
    _require(isinstance(value, list) and len(value) == 3, "NSG must contain exactly three rules")
    expected = {
        "allow-ssh-from-current-admin-ipv4": (100, "22", admin_cidr),
        "allow-http-for-caddy-acme-only": (110, "80", "Internet"),
        "allow-https-for-caddy": (120, "443", "Internet"),
    }
    observed: set[str] = set()
    for rule in value:
        _require(isinstance(rule, dict), "NSG rule must be an object")
        current = dict(rule)
        name = current.pop("name", None)
        _require(
            isinstance(name, str) and name in expected and name not in observed,
            "NSG rule name is unreviewed or duplicated",
        )
        observed.add(name)
        priority, port, source = expected[name]
        required = {
            "access": "Allow",
            "destination_address_prefix": "*",
            "destination_port_range": port,
            "direction": "Inbound",
            "priority": priority,
            "protocol": "Tcp",
            "source_address_prefix": source,
            "source_port_range": "*",
        }
        for key, expected_value in required.items():
            _require_field(current, key, expected_value, f"NSG rule {name}")
        _require_field_where(
            current,
            "description",
            lambda item: isinstance(item, str) and 20 <= len(item) <= 300,
            f"NSG rule {name}",
        )
        _finish_after(current, f"NSG rule {name}")
    _require(observed == set(expected), "NSG rule set is incomplete")


def _audit_budget_notifications(value: Any, emails: list[str]) -> None:
    _require(
        isinstance(value, list) and len(value) == 4,
        "budget must contain exactly four notifications",
    )
    expected = {
        (50, "Actual"),
        (80, "Actual"),
        (100, "Actual"),
        (100, "Forecasted"),
    }
    observed: set[tuple[Any, Any]] = set()
    for item in value:
        _require(isinstance(item, dict), "budget notification must be an object")
        current = dict(item)
        threshold = current.get("threshold")
        threshold_type = current.get("threshold_type")
        _require(
            isinstance(threshold, (int, float))
            and not isinstance(threshold, bool)
            and isinstance(threshold_type, str),
            "budget notification threshold is malformed",
        )
        pair = (threshold, threshold_type)
        _require(
            pair in expected and pair not in observed,
            "budget notification threshold is unreviewed or duplicated",
        )
        observed.add(pair)
        contacts = current.pop("contact_emails", None)
        _require(
            isinstance(contacts, list)
            and all(isinstance(contact, str) for contact in contacts)
            and sorted(contacts) == sorted(emails),
            "budget notification contacts do not match the reviewed set",
        )
        required = {
            "enabled": True,
            "operator": "GreaterThanOrEqualTo",
            "threshold": pair[0],
            "threshold_type": pair[1],
        }
        for key, expected_value in required.items():
            _require_field(current, key, expected_value, "budget notification")
        _finish_after(current, "budget notification")
    _require(observed == expected, "budget notifications are incomplete")


def _audit_after(address: str, raw_after: Any, values: dict[str, Any]) -> None:
    _require(isinstance(raw_after, dict), f"create must have a planned object: {address}")
    after = dict(raw_after)
    prefix = values["name_prefix"]
    tags = REQUIRED_TAGS
    common_named = {
        "azurerm_resource_group.beta": (f"{prefix}-rg", None),
        "azurerm_virtual_network.beta": (f"{prefix}-vnet", tags),
        "azurerm_subnet.beta": (f"{prefix}-subnet", None),
        "azurerm_network_security_group.beta": (f"{prefix}-nsg", tags),
        "azurerm_public_ip.beta": (f"{prefix}-pip", tags),
        "azurerm_network_interface.beta": (f"{prefix}-nic", tags),
        "azurerm_linux_virtual_machine.beta": (f"{prefix}-vm", tags),
        "azurerm_managed_disk.data": (
            f"{prefix}-data",
            {**tags, "preservation": "manual-delete-only"},
        ),
    }
    if address in common_named:
        name, expected_tags = common_named[address]
        _require_field(after, "name", name, address)
        if expected_tags is not None:
            _require_field(after, "tags", expected_tags, address)

    if address == "azurerm_resource_group.beta":
        _require_field(after, "location", "eastus2", address)
        _require_field(after, "tags", tags, address)
    elif address == "azurerm_virtual_network.beta":
        _require_field(after, "location", "eastus2", address)
        _require_field(after, "resource_group_name", f"{prefix}-rg", address)
        _require_field(after, "address_space", ["10.42.0.0/16"], address)
        if "private_endpoint_vnet_policies" in after:
            _require_field(after, "private_endpoint_vnet_policies", "Disabled", address)
    elif address == "azurerm_subnet.beta":
        _require_field(after, "resource_group_name", f"{prefix}-rg", address)
        _require_field(after, "virtual_network_name", f"{prefix}-vnet", address)
        _require_field(after, "address_prefixes", ["10.42.1.0/24"], address)
        _require_field(after, "default_outbound_access_enabled", False, address)
        if "private_endpoint_network_policies" in after:
            _require_field(after, "private_endpoint_network_policies", "Disabled", address)
        if "private_link_service_network_policies_enabled" in after:
            _require_field(
                after,
                "private_link_service_network_policies_enabled",
                True,
                address,
            )
    elif address == "azurerm_network_security_group.beta":
        _require_field(after, "location", "eastus2", address)
        _require_field(after, "resource_group_name", f"{prefix}-rg", address)
        _audit_nsg_rules(after.pop("security_rule", None), values["admin_ipv4_cidr"])
    elif address == "azurerm_subnet_network_security_group_association.beta":
        _require_field(after, "subnet_id", None, address)
        _require_field(after, "network_security_group_id", None, address)
    elif address == "azurerm_public_ip.beta":
        _require_field(after, "location", "eastus2", address)
        _require_field(after, "resource_group_name", f"{prefix}-rg", address)
        for key, expected in {
            "allocation_method": "Static",
            "ip_version": "IPv4",
            "sku": "Standard",
            "sku_tier": "Regional",
        }.items():
            _require_field(after, key, expected, address)
        if "ddos_protection_mode" in after:
            _require_field(
                after, "ddos_protection_mode", "VirtualNetworkInherited", address
            )
    elif address == "azurerm_network_interface.beta":
        _require_field(after, "location", "eastus2", address)
        _require_field(after, "resource_group_name", f"{prefix}-rg", address)
        _require_field(after, "accelerated_networking_enabled", False, address)
        _require_field(after, "ip_forwarding_enabled", False, address)
        configs = after.pop("ip_configuration", None)
        _require(
            isinstance(configs, list) and len(configs) == 1,
            "NIC must contain exactly one IP configuration",
        )
        _audit_nested(
            configs[0],
            {
                "name": "primary",
                "subnet_id": None,
                "private_ip_address_allocation": "Dynamic",
                "private_ip_address_version": "IPv4",
                "public_ip_address_id": None,
                "primary": True,
            },
            "NIC primary IP configuration",
        )
    elif address == "azurerm_linux_virtual_machine.beta":
        for key, expected in {
            "computer_name": "nutrition-beta",
            "location": "eastus2",
            "resource_group_name": f"{prefix}-rg",
            "size": "Standard_E2ps_v5",
            "admin_username": "azureuser",
            "admin_password": None,
            "custom_data": None,
            "user_data": None,
            "disable_password_authentication": True,
            "provision_vm_agent": True,
            "allow_extension_operations": False,
            "secure_boot_enabled": True,
            "vtpm_enabled": True,
            "priority": "Regular",
            "max_bid_price": -1,
        }.items():
            _require_field(after, key, expected, address)
        _require_field(after, "network_interface_ids", [None], address)
        keys = after.pop("admin_ssh_key", None)
        _require(
            isinstance(keys, list) and len(keys) == 1,
            "VM must contain exactly one SSH key",
        )
        _audit_nested(
            keys[0],
            {"username": "azureuser", "public_key": values["ssh_public_key"]},
            "VM SSH key",
        )
        disks = after.pop("os_disk", None)
        _require(
            isinstance(disks, list) and len(disks) == 1,
            "VM must contain exactly one OS disk",
        )
        _audit_nested(
            disks[0],
            {
                "name": f"{prefix}-os",
                "caching": "ReadWrite",
                "storage_account_type": "StandardSSD_LRS",
                "disk_size_gb": 64,
                "write_accelerator_enabled": False,
            },
            "VM OS disk",
        )
        images = after.pop("source_image_reference", None)
        _require(
            isinstance(images, list) and len(images) == 1,
            "VM must contain exactly one source image",
        )
        _audit_nested(
            images[0],
            {
                "publisher": "Canonical",
                "offer": "ubuntu-24_04-lts",
                "sku": "server-arm64",
                "version": values["ubuntu_image_version"],
            },
            "VM source image",
        )
        for forbidden in (
            "additional_capabilities",
            "boot_diagnostics",
            "gallery_application",
            "identity",
            "plan",
            "secret",
        ):
            if forbidden in after:
                _require_field(after, forbidden, [], address)
    elif address == "azurerm_managed_disk.data":
        for key, expected in {
            "location": "eastus2",
            "resource_group_name": f"{prefix}-rg",
            "storage_account_type": "StandardSSD_LRS",
            "create_option": "Empty",
            "disk_size_gb": 64,
            "network_access_policy": "AllowAll",
            "public_network_access_enabled": True,
            "optimized_frequent_attach_enabled": False,
            "performance_plus_enabled": False,
        }.items():
            _require_field(after, key, expected, address)
    elif address == "azurerm_virtual_machine_data_disk_attachment.data":
        for key, expected in {
            "managed_disk_id": None,
            "virtual_machine_id": None,
            "lun": 0,
            "caching": "None",
            "create_option": "Attach",
            "write_accelerator_enabled": False,
        }.items():
            _require_field(after, key, expected, address)
    elif address in {
        "azurerm_management_lock.data",
        "azurerm_management_lock.public_ip",
    }:
        is_data = address.endswith(".data")
        suffix = "data" if is_data else "pip"
        notes = (
            "Preserve synthetic beta state across VM replacement; removal requires a "
            "separately reviewed manual operation."
            if is_data
            else "Do not release this OCI network-source trust anchor before revoking "
            "every retained-OCI credential and verifying denial."
        )
        _require_field(after, "name", f"{prefix}-{suffix}-delete-lock", address)
        _require_field(after, "scope", None, address)
        _require_field(after, "lock_level", "CanNotDelete", address)
        _require_field(after, "notes", notes, address)
    elif address == "azurerm_dev_test_global_vm_shutdown_schedule.beta":
        deadline = _parse_utc(
            values["first_session_shutdown_deadline_utc"], "shutdown deadline"
        )
        for key, expected in {
            "virtual_machine_id": None,
            "location": "eastus2",
            "enabled": True,
            "daily_recurrence_time": deadline.strftime("%H%M"),
            "timezone": "UTC",
            "tags": tags,
        }.items():
            _require_field(after, key, expected, address)
        settings = after.pop("notification_settings", None)
        _require(
            isinstance(settings, list) and len(settings) == 1,
            "shutdown schedule must contain one notification",
        )
        _audit_nested(
            settings[0],
            {
                "enabled": True,
                "email": sorted(values["alert_contact_emails"])[0],
                "time_in_minutes": 30,
            },
            "shutdown notification",
        )
    elif address == "azurerm_consumption_budget_resource_group.beta":
        for key, expected in {
            "name": f"{prefix}-monthly-budget",
            "resource_group_id": None,
            "amount": values["monthly_budget_amount_usd"],
            "time_grain": "Monthly",
        }.items():
            _require_field(after, key, expected, address)
        periods = after.pop("time_period", None)
        _require(
            isinstance(periods, list) and len(periods) == 1,
            "budget must contain one time period",
        )
        _audit_nested(
            periods[0],
            {"start_date": values["budget_start_date_utc"]},
            "budget time period",
        )
        _audit_budget_notifications(
            after.pop("notification", None), values["alert_contact_emails"]
        )
    else:  # pragma: no cover
        raise PlanAuditError(f"no value contract exists for {address}")
    _finish_after(after, address)


def _flatten_mask(
    value: Any, label: str, prefix: tuple[Any, ...] = ()
) -> set[tuple[Any, ...]]:
    if value in (None, False):
        return set()
    if value is True:
        _require(bool(prefix), f"{label} cannot mark the entire object")
        return {prefix}
    if isinstance(value, dict):
        result: set[tuple[Any, ...]] = set()
        for key, child in value.items():
            _require(isinstance(key, str), f"{label} has a malformed path")
            result |= _flatten_mask(child, label, prefix + (key,))
        return result
    if isinstance(value, list):
        result = set()
        for index, child in enumerate(value):
            result |= _flatten_mask(child, label, prefix + (index,))
        return result
    raise PlanAuditError(f"{label} contains non-boolean leaf metadata")


def _path_matches(path: tuple[Any, ...], pattern: tuple[Any, ...]) -> bool:
    return len(path) == len(pattern) and all(
        expected == "*" or expected == actual
        for actual, expected in zip(path, pattern)
    )


UNKNOWN_RULES: dict[
    str, tuple[set[tuple[Any, ...]], set[tuple[Any, ...]]]
] = {
    "azurerm_resource_group.beta": ({("id",)}, {("id",)}),
    "azurerm_virtual_network.beta": (
        {("id",), ("guid",)},
        {("id",), ("guid",), ("dns_servers",), ("subnet",)},
    ),
    "azurerm_subnet.beta": ({("id",)}, {("id",)}),
    "azurerm_network_security_group.beta": ({("id",)}, {("id",)}),
    "azurerm_subnet_network_security_group_association.beta": (
        {("id",), ("subnet_id",), ("network_security_group_id",)},
        {("id",), ("subnet_id",), ("network_security_group_id",)},
    ),
    "azurerm_public_ip.beta": (
        {("id",), ("ip_address",)},
        {("id",), ("ip_address",), ("fqdn",)},
    ),
    "azurerm_network_interface.beta": (
        {
            ("id",),
            ("ip_configuration", 0, "subnet_id"),
            ("ip_configuration", 0, "public_ip_address_id"),
        },
        {
            ("id",),
            ("applied_dns_servers",),
            ("internal_domain_name_suffix",),
            ("mac_address",),
            ("private_ip_address",),
            ("private_ip_addresses",),
            ("virtual_machine_id",),
            ("ip_configuration", 0, "subnet_id"),
            ("ip_configuration", 0, "public_ip_address_id"),
            ("ip_configuration", 0, "private_ip_address"),
            ("ip_configuration", 0, "private_ip_address_version"),
        },
    ),
    "azurerm_linux_virtual_machine.beta": (
        {
            ("id",),
            ("network_interface_ids", 0),
            ("os_disk", 0, "id"),
            ("patch_assessment_mode",),
            ("patch_mode",),
        },
        {
            ("id",),
            ("network_interface_ids", 0),
            ("os_disk", 0, "id"),
            ("os_managed_disk_id",),
            ("disk_controller_type",),
            ("private_ip_address",),
            ("private_ip_addresses",),
            ("public_ip_address",),
            ("public_ip_addresses",),
            ("patch_assessment_mode",),
            ("patch_mode",),
            ("virtual_machine_id",),
            ("vm_agent_platform_updates_enabled",),
        },
    ),
    "azurerm_managed_disk.data": (
        {("id",)},
        {
            ("id",),
            ("disk_iops_read_only",),
            ("disk_iops_read_write",),
            ("disk_mbps_read_only",),
            ("disk_mbps_read_write",),
            ("logical_sector_size",),
            ("max_shares",),
            ("source_uri",),
            ("tier",),
        },
    ),
    "azurerm_virtual_machine_data_disk_attachment.data": (
        {("id",), ("managed_disk_id",), ("virtual_machine_id",)},
        {("id",), ("managed_disk_id",), ("virtual_machine_id",)},
    ),
    "azurerm_management_lock.data": (
        {("id",), ("scope",)},
        {("id",), ("scope",)},
    ),
    "azurerm_management_lock.public_ip": (
        {("id",), ("scope",)},
        {("id",), ("scope",)},
    ),
    "azurerm_dev_test_global_vm_shutdown_schedule.beta": (
        {("id",), ("virtual_machine_id",)},
        {("id",), ("virtual_machine_id",)},
    ),
    "azurerm_consumption_budget_resource_group.beta": (
        {("id",), ("resource_group_id",)},
        {
            ("id",),
            ("etag",),
            ("resource_group_id",),
            ("time_period", 0, "end_date"),
        },
    ),
}


def _audit_unknowns(address: str, value: Any) -> None:
    paths = _flatten_mask(value, f"{address}.after_unknown")
    required, allowed = UNKNOWN_RULES[address]
    _require(
        required <= paths,
        f"{address}.after_unknown omits expected provider-computed or wiring paths",
    )
    for path in paths:
        _require(
            any(_path_matches(path, pattern) for pattern in allowed),
            f"{address}.after_unknown contains an unreviewed path",
        )


def _audit_sensitivity(address: str, before: Any, after: Any) -> None:
    _require(
        not _flatten_mask(before, f"{address}.before_sensitive"),
        f"{address} has sensitive prior metadata",
    )
    paths = _flatten_mask(after, f"{address}.after_sensitive")
    if address != "azurerm_linux_virtual_machine.beta":
        _require(not paths, f"{address} has unreviewed sensitive metadata")
        return
    admitted = {
        ("admin_password",),
        ("custom_data",),
        ("admin_ssh_key", 0, "public_key"),
    }
    _require(
        paths == admitted,
        "VM sensitivity must be the exact AzureRM password/custom-data/public-key mask",
    )


def _audit_provider_configuration(configuration: dict[str, Any]) -> None:
    providers = _exact_keys(
        configuration.get("provider_config"),
        {"azurerm"},
        "configuration.provider_config",
    )
    provider = _exact_keys(
        providers["azurerm"],
        {"name", "full_name", "version_constraint", "expressions"},
        "configuration.provider_config.azurerm",
    )
    _require(provider["name"] == "azurerm", "provider local name must be azurerm")
    _require(
        provider["full_name"] == AZURERM_PROVIDER,
        "provider source must be the reviewed HashiCorp AzureRM provider",
    )
    _require(
        provider["version_constraint"] == "4.79.0",
        "provider version constraint must be exactly 4.79.0",
    )
    expressions = _exact_keys(
        provider["expressions"],
        {"subscription_id", "resource_provider_registrations", "features"},
        "AzureRM provider expressions",
    )
    _require(
        expressions["subscription_id"] == {"references": ["var.subscription_id"]},
        "AzureRM subscription_id must reference only var.subscription_id",
    )
    _require(
        expressions["resource_provider_registrations"] == {"constant_value": "none"},
        "AzureRM resource provider registrations must remain disabled",
    )
    _require(
        expressions["features"]
        == [
            {
                "resource_group": [
                    {
                        "prevent_deletion_if_contains_resources": {
                            "constant_value": True
                        }
                    }
                ]
            }
        ],
        "AzureRM features must contain only the reviewed resource-group deletion guard",
    )


def _configuration_resources(
    document: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    configuration = document.get("configuration")
    _require(
        isinstance(configuration, dict),
        "plan must include its configuration representation",
    )
    _audit_provider_configuration(configuration)
    root = configuration.get("root_module")
    _require(isinstance(root, dict), "plan configuration must contain a root module")
    _require(root.get("module_calls") in (None, {}), "child modules are not admitted")
    resources = root.get("resources")
    _require(
        isinstance(resources, list) and len(resources) == len(EXPECTED_CREATES),
        "configuration must contain exactly 14 resources",
    )
    result: dict[str, dict[str, Any]] = {}
    for resource in resources:
        _require(isinstance(resource, dict), "malformed configured resource")
        address = resource.get("address")
        _require(
            address in EXPECTED_CREATES and address not in result,
            "configuration contains an unreviewed or duplicate resource",
        )
        resource_type, resource_name = address.split(".", 1)
        _require(
            resource.get("mode") == "managed"
            and resource.get("type") == resource_type
            and resource.get("name") == resource_name,
            f"configuration address metadata mismatch: {address}",
        )
        _require(
            resource.get("provider_config_key") == "azurerm",
            f"configuration provider mismatch: {address}",
        )
        _require(
            resource.get("schema_version") == EXPECTED_SCHEMA_VERSIONS[address],
            f"configuration schema version mismatch: {address}",
        )
        for forbidden in ("count_expression", "for_each_expression", "provisioners"):
            _require(
                resource.get(forbidden) in (None, []),
                f"{forbidden} is not admitted: {address}",
            )
        _require(
            isinstance(resource.get("expressions"), dict),
            f"configuration expressions missing: {address}",
        )
        result[address] = resource
    return result


def _expression_at(
    resources: dict[str, dict[str, Any]], address: str, path: tuple[Any, ...]
) -> dict[str, Any]:
    current: Any = resources[address]["expressions"]
    for step in path:
        _require(
            isinstance(current, (dict, list)),
            f"configuration expression path is missing: {address}",
        )
        try:
            current = current[step]
        except (KeyError, IndexError, TypeError) as error:
            raise PlanAuditError(
                f"configuration expression path is missing: {address}"
            ) from error
    _require(
        isinstance(current, dict),
        f"configuration expression is malformed: {address}",
    )
    return current


def _require_reference(
    resources: dict[str, dict[str, Any]],
    address: str,
    path: tuple[Any, ...],
    leaf: str,
) -> None:
    expression = _expression_at(resources, address, path)
    references = expression.get("references")
    _require(
        isinstance(references, list) and leaf in references,
        f"configuration wiring mismatch: {address}",
    )
    base = leaf.rsplit(".", 1)[0]
    _require(
        set(references) <= {leaf, base},
        f"configuration wiring includes an unreviewed reference: {address}",
    )


def _audit_wiring(document: dict[str, Any]) -> None:
    resources = _configuration_resources(document)
    refs = (
        (
            "azurerm_consumption_budget_resource_group.beta",
            ("resource_group_id",),
            "azurerm_resource_group.beta.id",
        ),
        (
            "azurerm_dev_test_global_vm_shutdown_schedule.beta",
            ("virtual_machine_id",),
            "azurerm_linux_virtual_machine.beta.id",
        ),
        (
            "azurerm_linux_virtual_machine.beta",
            ("network_interface_ids",),
            "azurerm_network_interface.beta.id",
        ),
        (
            "azurerm_management_lock.data",
            ("scope",),
            "azurerm_managed_disk.data.id",
        ),
        (
            "azurerm_management_lock.public_ip",
            ("scope",),
            "azurerm_public_ip.beta.id",
        ),
        (
            "azurerm_network_interface.beta",
            ("ip_configuration", 0, "subnet_id"),
            "azurerm_subnet.beta.id",
        ),
        (
            "azurerm_network_interface.beta",
            ("ip_configuration", 0, "public_ip_address_id"),
            "azurerm_public_ip.beta.id",
        ),
        (
            "azurerm_subnet_network_security_group_association.beta",
            ("subnet_id",),
            "azurerm_subnet.beta.id",
        ),
        (
            "azurerm_subnet_network_security_group_association.beta",
            ("network_security_group_id",),
            "azurerm_network_security_group.beta.id",
        ),
        (
            "azurerm_virtual_machine_data_disk_attachment.data",
            ("managed_disk_id",),
            "azurerm_managed_disk.data.id",
        ),
        (
            "azurerm_virtual_machine_data_disk_attachment.data",
            ("virtual_machine_id",),
            "azurerm_linux_virtual_machine.beta.id",
        ),
    )
    for address, path, leaf in refs:
        _require_reference(resources, address, path, leaf)


def _check_address(address: str) -> dict[str, str]:
    resource_type, name = address.split(".", 1)
    return {
        "kind": "resource",
        "mode": "managed",
        "name": name,
        "to_display": address,
        "type": resource_type,
    }


def _audit_checks(checks: Any) -> None:
    expected = {
        "azurerm_resource_group.beta": "unknown",
        "azurerm_linux_virtual_machine.beta": "pass",
    }
    _require(
        isinstance(checks, list) and len(checks) == 2,
        "plan must contain exactly the two reviewed Terraform checks",
    )
    observed: set[str] = set()
    for check in checks:
        _require(isinstance(check, dict), "malformed Terraform check result")
        address_object = check.get("address")
        _require(isinstance(address_object, dict), "Terraform check address is malformed")
        address = address_object.get("to_display")
        _require(
            isinstance(address, str)
            and address in expected
            and address not in observed,
            "unreviewed or duplicate Terraform check",
        )
        observed.add(address)
        _require(
            address_object == _check_address(address),
            f"Terraform check address metadata mismatch: {address}",
        )
        _require(
            check.get("status") == expected[address],
            f"Terraform check has an unreviewed status: {address}",
        )
        _require(
            set(check) <= {"address", "status", "instances"},
            f"Terraform check has unreviewed metadata: {address}",
        )
        instances = check.get("instances")
        _require(
            isinstance(instances, list) and len(instances) == 1,
            f"Terraform check must have one instance: {address}",
        )
        instance = instances[0]
        _require(
            isinstance(instance, dict)
            and set(instance) == {"address", "status"},
            f"Terraform check instance is malformed: {address}",
        )
        _require(
            instance["address"] == {"to_display": address},
            f"Terraform check instance address mismatch: {address}",
        )
        _require(
            instance["status"] == expected[address],
            f"Terraform check instance has an unreviewed status: {address}",
        )
    _require(observed == set(expected), "plan is missing a reviewed Terraform check")


def audit_plan(document: Any) -> None:
    """Validate an already parsed ``terraform show -json`` document."""

    _require(isinstance(document, dict), "plan JSON root must be an object")
    for unsupported in ("applyable", "complete", "errored"):
        _require(
            unsupported not in document,
            f"{unsupported} is not Terraform 1.5.7 saved-plan JSON metadata",
        )
    _require(
        document.get("format_version") == "1.2",
        "unsupported Terraform JSON format_version",
    )
    _require(
        document.get("terraform_version") == "1.5.7",
        "saved plan must use the reviewed Terraform 1.5.7 CLI",
    )
    _require(document.get("resource_drift") in (None, []), "resource drift is not admitted")
    values = _audit_inputs(document)
    _audit_wiring(document)

    changes = document.get("resource_changes")
    _require(isinstance(changes, list), "missing resource_changes array")
    _require(
        len(changes) == len(EXPECTED_CREATES),
        "plan must contain exactly 14 resource changes",
    )
    observed: set[str] = set()
    allowed_entry_keys = {
        "address",
        "mode",
        "type",
        "name",
        "provider_name",
        "change",
        "module_address",
        "index",
        "previous_address",
        "deposed",
        "generated_config",
        "action_reason",
    }
    allowed_change_keys = {
        "actions",
        "before",
        "after",
        "after_unknown",
        "before_sensitive",
        "after_sensitive",
        "replace_paths",
        "importing",
    }
    for entry in changes:
        _require(isinstance(entry, dict), "malformed resource change")
        _require(
            set(entry) <= allowed_entry_keys,
            "resource change contains unreviewed lifecycle metadata",
        )
        address = entry.get("address")
        _require(
            isinstance(address, str) and address,
            "resource change is missing its address",
        )
        _require(address not in observed, f"duplicate resource change: {address}")
        observed.add(address)
        _require(address in EXPECTED_CREATES, f"unreviewed resource change: {address}")
        resource_type, resource_name = address.split(".", 1)
        _require(
            entry.get("mode") == "managed",
            f"only managed resources are admitted: {address}",
        )
        _require(
            entry.get("type") == resource_type and entry.get("name") == resource_name,
            f"resource address metadata mismatch: {address}",
        )
        _require(
            entry.get("provider_name") == AZURERM_PROVIDER,
            f"only the pinned AzureRM provider is admitted: {address}",
        )
        for field in (
            "module_address",
            "index",
            "previous_address",
            "deposed",
            "generated_config",
            "action_reason",
        ):
            _require(entry.get(field) in (None, ""), f"{field} is not admitted: {address}")

        change = entry.get("change")
        _require(isinstance(change, dict), f"missing change object: {address}")
        _require(
            set(change) <= allowed_change_keys,
            f"unreviewed change metadata: {address}",
        )
        _require(
            change.get("actions") == ["create"],
            f"only a single create action is admitted: {address}",
        )
        _require(change.get("before") is None, f"create must have no prior object: {address}")
        _require(
            change.get("replace_paths") in (None, []),
            f"replacement paths are not admitted: {address}",
        )
        _require(change.get("importing") is None, f"imports are not admitted: {address}")
        _audit_after(address, change.get("after"), values)
        _audit_unknowns(address, change.get("after_unknown"))
        _audit_sensitivity(
            address,
            change.get("before_sensitive"),
            change.get("after_sensitive"),
        )

    _require(observed == EXPECTED_CREATES, "plan is missing one or more reviewed resources")
    _audit_checks(document.get("checks"))


def load_plan(path: Path) -> Any:
    """Load JSON only for lower-level tests; the command-line boundary uses a binary plan."""

    _require(path.is_file(), "plan JSON path must be a regular file")
    size = path.stat().st_size
    _require(
        0 < size <= MAX_PLAN_JSON_BYTES,
        "plan JSON must be non-empty and at most 20 MiB",
    )
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PlanAuditError("plan JSON is unreadable or invalid") from error


def _require_private_directory(path: Path, label: str) -> Path:
    try:
        resolved = path.resolve(strict=True)
        metadata = resolved.stat()
    except OSError as error:
        raise PlanAuditError(f"{label} directory is unavailable") from error
    _require(stat.S_ISDIR(metadata.st_mode), f"{label} parent must be a directory")
    _require(metadata.st_uid == os.getuid(), f"{label} parent must be owned by this user")
    _require(
        stat.S_IMODE(metadata.st_mode) == 0o700,
        f"{label} parent directory must have exact mode 0700",
    )
    return resolved


def _secure_regular_file(path: Path, label: str, expected_suffix: str, maximum: int) -> os.stat_result:
    _require(path.suffix == expected_suffix, f"{label} must use the {expected_suffix} suffix")
    _require_private_directory(path.parent, label)
    try:
        metadata = path.lstat()
    except OSError as error:
        raise PlanAuditError(f"{label} is unavailable") from error
    _require(stat.S_ISREG(metadata.st_mode), f"{label} must be a regular file, not a symlink")
    _require(metadata.st_uid == os.getuid(), f"{label} must be owned by this user")
    _require(stat.S_IMODE(metadata.st_mode) == 0o600, f"{label} must have exact mode 0600")
    _require(metadata.st_nlink == 1, f"{label} must have exactly one hard link")
    _require(0 < metadata.st_size <= maximum, f"{label} has an invalid size")
    return metadata


def secure_plan_digest(path: Path) -> tuple[str, int]:
    """Hash one private binary plan without following a symlink."""

    expected = _secure_regular_file(
        path,
        "binary plan",
        ".tfplan",
        MAX_BINARY_PLAN_BYTES,
    )
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise PlanAuditError("binary plan cannot be opened safely") from error
    digest = hashlib.sha256()
    try:
        opened = os.fstat(descriptor)
        _require(
            (opened.st_dev, opened.st_ino, opened.st_size)
            == (expected.st_dev, expected.st_ino, expected.st_size),
            "binary plan changed while it was opened",
        )
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        final = os.fstat(descriptor)
        _require(
            (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns)
            == (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns),
            "binary plan changed while it was hashed",
        )
    finally:
        os.close(descriptor)
    return digest.hexdigest(), expected.st_size


def open_verified_plan_descriptor(path: Path, expected_sha256: str) -> int:
    """Open and hash the exact inode that an apply process will inherit."""

    expected = _secure_regular_file(
        path,
        "binary plan",
        ".tfplan",
        MAX_BINARY_PLAN_BYTES,
    )
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        _require(
            (opened.st_dev, opened.st_ino, opened.st_size)
            == (expected.st_dev, expected.st_ino, expected.st_size),
            "binary plan changed before apply",
        )
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        _require(digest.hexdigest() == expected_sha256, "binary plan hash changed before apply")
        final = os.fstat(descriptor)
        _require(
            (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns)
            == (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns),
            "binary plan changed while it was verified for apply",
        )
        os.lseek(descriptor, 0, os.SEEK_SET)
        os.set_inheritable(descriptor, True)
        return descriptor
    except Exception:
        try:
            os.close(descriptor)
        except (OSError, UnboundLocalError):
            pass
        raise


def _terraform_show_environment(private_directory: Path) -> dict[str, str]:
    """Return a credential-, proxy-, logging-, and CLI-override-free show environment."""

    return {
        "CHECKPOINT_DISABLE": "1",
        "HOME": str(private_directory),
        "LANG": "C",
        "LC_ALL": "C",
        "PATH": "/usr/bin:/bin:/opt/homebrew/bin",
        "TF_CLI_CONFIG_FILE": "/dev/null",
        "TF_IN_AUTOMATION": "1",
        "TF_INPUT": "0",
        "TMPDIR": str(private_directory),
    }


def _reviewed_terraform_binary(path: Path, environment: dict[str, str]) -> Path:
    try:
        resolved = path.resolve(strict=True)
        metadata = resolved.stat()
    except OSError as error:
        raise PlanAuditError("reviewed Terraform binary is unavailable") from error
    _require(
        stat.S_ISREG(metadata.st_mode) and os.access(resolved, os.X_OK),
        "reviewed Terraform path must resolve to an executable regular file",
    )
    try:
        completed = subprocess.run(
            [str(resolved), "version", "-json"],
            cwd=INFRA_ROOT,
            env=environment,
            check=False,
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PlanAuditError("reviewed Terraform version check failed") from error
    _require(completed.returncode == 0, "reviewed Terraform version check failed")
    try:
        version = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise PlanAuditError("reviewed Terraform version output is malformed") from error
    _require(
        isinstance(version, dict)
        and version.get("terraform_version") == REVIEWED_TERRAFORM_VERSION,
        "Terraform binary must be exactly version 1.5.7",
    )
    return resolved


def audit_binary_plan(
    path: Path,
    terraform_binary: Path = DEFAULT_TERRAFORM_BINARY,
) -> dict[str, Any]:
    """Hash, render, and semantically audit one private binary saved plan."""

    path = path.absolute()
    before_hash, size = secure_plan_digest(path)
    private_directory = _require_private_directory(path.parent, "binary plan")
    environment = _terraform_show_environment(private_directory)
    terraform = _reviewed_terraform_binary(terraform_binary, environment)
    terraform_hash, _ = secure_executable_digest(terraform)
    try:
        completed = subprocess.run(
            [str(terraform), "show", "-json", str(path)],
            cwd=INFRA_ROOT,
            env=environment,
            check=False,
            capture_output=True,
            timeout=TERRAFORM_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PlanAuditError("terraform show failed without exposing plan values") from error
    _require(
        completed.returncode == 0,
        "terraform show failed without exposing plan values",
    )
    _require(
        0 < len(completed.stdout) <= MAX_PLAN_JSON_BYTES,
        "terraform show JSON is empty or exceeds 20 MiB",
    )
    try:
        document = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise PlanAuditError("terraform show produced malformed JSON") from error
    audit_plan(document)
    audited_values = _variable_values(document)
    subscription_id = str(audited_values["subscription_id"]).lower()
    name_prefix = str(audited_values["name_prefix"])
    shutdown_utc_time = _parse_utc(
        audited_values["first_session_shutdown_deadline_utc"], "shutdown deadline"
    ).strftime("%H%M")
    failure_containment_vm_resource_id = (
        f"/subscriptions/{subscription_id}/resourceGroups/{name_prefix}-rg/"
        f"providers/Microsoft.Compute/virtualMachines/{name_prefix}-vm"
    )
    after_hash, after_size = secure_plan_digest(path)
    _require(
        (before_hash, size) == (after_hash, after_size),
        "binary plan changed during its audit",
    )
    return {
        "schema": ATTESTATION_SCHEMA,
        "failure_containment_vm_resource_id": failure_containment_vm_resource_id,
        "shutdown_schedule_utc_time": shutdown_utc_time,
        "plan_sha256": before_hash,
        "plan_size_bytes": size,
        "terraform_binary": str(terraform),
        "terraform_sha256": terraform_hash,
        "terraform_version": REVIEWED_TERRAFORM_VERSION,
    }


def secure_executable_digest(path: Path) -> tuple[str, int]:
    """Hash the resolved Terraform executable; it is not required to be mode 0600."""

    try:
        metadata = path.stat()
        descriptor = os.open(path, os.O_RDONLY)
    except OSError as error:
        raise PlanAuditError("reviewed Terraform executable cannot be hashed") from error
    digest = hashlib.sha256()
    try:
        opened = os.fstat(descriptor)
        _require(
            stat.S_ISREG(opened.st_mode)
            and (opened.st_dev, opened.st_ino, opened.st_size)
            == (metadata.st_dev, metadata.st_ino, metadata.st_size),
            "reviewed Terraform executable changed while opening",
        )
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        final = os.fstat(descriptor)
        _require(
            (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns)
            == (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns),
            "reviewed Terraform executable changed while it was hashed",
        )
    finally:
        os.close(descriptor)
    return digest.hexdigest(), metadata.st_size


def write_attestation(path: Path, result: dict[str, Any]) -> None:
    """Create, without overwrite, one private audit attestation."""

    _exact_keys(
        result,
        {
            "schema",
            "failure_containment_vm_resource_id",
            "shutdown_schedule_utc_time",
            "plan_sha256",
            "plan_size_bytes",
            "terraform_binary",
            "terraform_sha256",
            "terraform_version",
        },
        "attestation result",
    )
    _require(
        path.name.endswith(".plan-attestation.json"),
        "attestation must use the .plan-attestation.json suffix",
    )
    _require_private_directory(path.parent, "attestation")
    payload = (json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )
    _require(len(payload) <= 16 * 1024, "attestation is unexpectedly large")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        raise PlanAuditError("attestation must be a new private file") from error
    _secure_regular_file(path, "attestation", ".json", 16 * 1024)


def load_attestation(path: Path) -> dict[str, Any]:
    _require(
        path.name.endswith(".plan-attestation.json"),
        "attestation must use the .plan-attestation.json suffix",
    )
    _secure_regular_file(path, "attestation", ".json", 16 * 1024)
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PlanAuditError("attestation is unreadable or malformed") from error
    expected = {
        "schema",
        "failure_containment_vm_resource_id",
        "shutdown_schedule_utc_time",
        "plan_sha256",
        "plan_size_bytes",
        "terraform_binary",
        "terraform_sha256",
        "terraform_version",
    }
    document = _exact_keys(document, expected, "attestation")
    _require(document["schema"] == ATTESTATION_SCHEMA, "attestation schema is unreviewed")
    _require(
        isinstance(document["failure_containment_vm_resource_id"], str)
        and re.fullmatch(
            r"/subscriptions/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/"
            r"resourceGroups/(?P<prefix>[a-z][a-z0-9-]{2,22}[a-z0-9])-rg/"
            r"providers/Microsoft\.Compute/virtualMachines/"
            r"(?P=prefix)-vm",
            document["failure_containment_vm_resource_id"],
        )
        is not None,
        "attestation failure-containment VM resource ID is malformed",
    )
    _require(
        isinstance(document["shutdown_schedule_utc_time"], str)
        and re.fullmatch(
            r"(?:[01][0-9]|2[0-3])[0-5][0-9]",
            document["shutdown_schedule_utc_time"],
        )
        is not None,
        "attestation shutdown schedule UTC time is malformed",
    )
    for field in ("plan_sha256", "terraform_sha256"):
        _require(
            isinstance(document[field], str)
            and re.fullmatch(r"[0-9a-f]{64}", document[field]) is not None,
            f"attestation {field} is malformed",
        )
    _require(
        isinstance(document["plan_size_bytes"], int)
        and not isinstance(document["plan_size_bytes"], bool)
        and 0 < document["plan_size_bytes"] <= MAX_BINARY_PLAN_BYTES,
        "attestation plan size is malformed",
    )
    _require(
        document["terraform_version"] == REVIEWED_TERRAFORM_VERSION,
        "attestation Terraform version is unreviewed",
    )
    _require(
        isinstance(document["terraform_binary"], str)
        and Path(document["terraform_binary"]).is_absolute(),
        "attestation Terraform binary path is malformed",
    )
    return document


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "binary_plan",
        type=Path,
        help="regular mode-0600 .tfplan in an owned mode-0700 directory",
    )
    parser.add_argument(
        "--write-attestation",
        type=Path,
        help="create a new mode-0600 JSON attestation in an owned mode-0700 directory",
    )
    args = parser.parse_args()
    try:
        result = audit_binary_plan(args.binary_plan)
        if args.write_attestation is not None:
            write_attestation(args.write_attestation.absolute(), result)
    except PlanAuditError as error:
        parser.exit(1, f"Azure saved-plan audit failed: {error}\n")
    print(
        "Azure saved-plan audit passed: exact reviewed 14-resource graph; "
        f"sha256={result['plan_sha256']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
