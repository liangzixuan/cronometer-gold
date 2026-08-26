from __future__ import annotations

import copy
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock


MODULE_PATH = Path(__file__).with_name("audit_saved_plan.py")
SPEC = importlib.util.spec_from_file_location("azure_plan_auditor", MODULE_PATH)
assert SPEC and SPEC.loader
AUDITOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDITOR)

PREFIX = "nutrition-beta"
SSH_KEY = (
    "ssh-ed25519 "
    "AAAAC3NzaC1lZDI1NTE5AAAAIAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g "
    "test@nourishing.app"
)
TAGS = {
    "availability": "single-server-non-ha",
    "data-classification": "synthetic-only",
    "environment": "beta",
    "managed-by": "terraform",
    "purchase-model": "on-demand",
    "terraform-scope": "empty-host-only",
}


def _mask(paths: set[tuple[Any, ...]]) -> dict[str, Any]:
    root: dict[str, Any] = {}
    for path in paths:
        current: Any = root
        for index, step in enumerate(path):
            final = index == len(path) - 1
            if isinstance(step, int):
                while len(current) <= step:
                    current.append({})
                if final:
                    current[step] = True
                else:
                    next_step = path[index + 1]
                    if not isinstance(current[step], (dict, list)):
                        current[step] = [] if isinstance(next_step, int) else {}
                    current = current[step]
            else:
                if final:
                    current[step] = True
                else:
                    next_step = path[index + 1]
                    current = current.setdefault(
                        step, [] if isinstance(next_step, int) else {}
                    )
    return root


def _variables() -> dict[str, dict[str, Any]]:
    values = {
        "subscription_id": "11111111-2222-3333-4444-555555555555",
        "name_prefix": PREFIX,
        "deployment_acknowledgement": AUDITOR.EXACT_ACKNOWLEDGEMENT,
        "admin_ipv4_cidr": "8.8.8.8/32",
        "beta_allowed_ipv4_cidr": "8.8.8.8/32",
        "ssh_public_key": SSH_KEY,
        "ubuntu_image_version": "24.04.202608010",
        "alert_contact_emails": ["ops@nourishing.app"],
        "first_session_shutdown_deadline_utc": "2026-08-25T18:00:00Z",
        "monthly_budget_amount_usd": 20,
        "budget_start_date_utc": "2026-08-01T00:00:00Z",
        "live_preflight": {
            "checked_at_utc": "2026-08-25T15:15:00Z",
            "subscription_id": "11111111-2222-3333-4444-555555555555",
            "subscription_state": "Enabled",
            "subscription_quota_id": "AzureForStudents_2018-01-01",
            "spending_limit": "On",
            "remaining_credit_usd": 75,
            "credit_currency": "USD",
            "credit_expires_at_utc": "2027-08-25T00:00:00Z",
            "checked_location": "eastus2",
            "vm_sku": "Standard_E2ps_v5",
            "vm_sku_available": True,
            "vm_sku_restrictions": [],
            "vm_vcpus": 2,
            "vm_memory_gb": 16,
            "vm_cpu_architecture": "Arm64",
            "vm_hyperv_generations": ["V2"],
            "vm_trusted_launch_disabled": False,
            "regional_vcpu_remaining": 10,
            "epsv5_family_vcpu_remaining": 2,
            "image_publisher": "Canonical",
            "image_offer": "ubuntu-24_04-lts",
            "image_sku": "server-arm64",
            "image_version": "24.04.202608010",
            "image_available": True,
            "image_architecture": "Arm64",
            "image_hyperv_generation": "V2",
            "image_security_types": ["TrustedLaunchSupported"],
            "image_plan_required": False,
            "image_location": "eastus2",
            "image_state": "Active",
            "registered_resource_providers": sorted(AUDITOR.REQUIRED_PROVIDERS),
        },
    }
    return {name: {"value": value} for name, value in values.items()}


def _rules() -> list[dict[str, Any]]:
    shared = {
        "access": "Allow",
        "destination_address_prefix": "*",
        "direction": "Inbound",
        "protocol": "Tcp",
        "source_port_range": "*",
    }
    return [
        {
            **shared,
            "name": "allow-ssh-from-current-admin-ipv4",
            "description": "SSH from exactly one freshly verified operator IPv4 /32.",
            "priority": 100,
            "destination_port_range": "22",
            "source_address_prefix": "8.8.8.8/32",
        },
        {
            **shared,
            "name": "allow-http-for-caddy-acme-only",
            "description": "Public HTTP is solely for Caddy ACME handling.",
            "priority": 110,
            "destination_port_range": "80",
            "source_address_prefix": "Internet",
        },
        {
            **shared,
            "name": "allow-https-for-caddy",
            "description": "Public HTTPS reaches the reviewed Caddy edge only.",
            "priority": 120,
            "destination_port_range": "443",
            "source_address_prefix": "Internet",
        },
    ]


def _notifications() -> list[dict[str, Any]]:
    return [
        {
            "contact_emails": ["ops@nourishing.app"],
            "enabled": True,
            "operator": "GreaterThanOrEqualTo",
            "threshold": threshold,
            "threshold_type": threshold_type,
        }
        for threshold, threshold_type in (
            (50, "Actual"),
            (80, "Actual"),
            (100, "Actual"),
            (100, "Forecasted"),
        )
    ]


def _after_values() -> dict[str, dict[str, Any]]:
    return {
        "azurerm_resource_group.beta": {
            "name": f"{PREFIX}-rg",
            "location": "eastus2",
            "tags": TAGS,
        },
        "azurerm_virtual_network.beta": {
            "name": f"{PREFIX}-vnet",
            "location": "eastus2",
            "resource_group_name": f"{PREFIX}-rg",
            "address_space": ["10.42.0.0/16"],
            "tags": TAGS,
            "private_endpoint_vnet_policies": "Disabled",
        },
        "azurerm_subnet.beta": {
            "name": f"{PREFIX}-subnet",
            "resource_group_name": f"{PREFIX}-rg",
            "virtual_network_name": f"{PREFIX}-vnet",
            "address_prefixes": ["10.42.1.0/24"],
            "default_outbound_access_enabled": False,
            "private_endpoint_network_policies": "Disabled",
            "private_link_service_network_policies_enabled": True,
        },
        "azurerm_network_security_group.beta": {
            "name": f"{PREFIX}-nsg",
            "location": "eastus2",
            "resource_group_name": f"{PREFIX}-rg",
            "security_rule": _rules(),
            "tags": TAGS,
        },
        "azurerm_subnet_network_security_group_association.beta": {
            "subnet_id": None,
            "network_security_group_id": None,
        },
        "azurerm_public_ip.beta": {
            "name": f"{PREFIX}-pip",
            "location": "eastus2",
            "resource_group_name": f"{PREFIX}-rg",
            "allocation_method": "Static",
            "ip_version": "IPv4",
            "sku": "Standard",
            "sku_tier": "Regional",
            "ddos_protection_mode": "VirtualNetworkInherited",
            "tags": TAGS,
        },
        "azurerm_network_interface.beta": {
            "name": f"{PREFIX}-nic",
            "location": "eastus2",
            "resource_group_name": f"{PREFIX}-rg",
            "accelerated_networking_enabled": False,
            "ip_forwarding_enabled": False,
            "tags": TAGS,
            "ip_configuration": [
                {
                    "name": "primary",
                    "subnet_id": None,
                    "private_ip_address_allocation": "Dynamic",
                    "private_ip_address_version": "IPv4",
                    "public_ip_address_id": None,
                    "primary": True,
                }
            ],
        },
        "azurerm_linux_virtual_machine.beta": {
            "name": f"{PREFIX}-vm",
            "computer_name": "nutrition-beta",
            "location": "eastus2",
            "resource_group_name": f"{PREFIX}-rg",
            "size": "Standard_E2ps_v5",
            "admin_username": "azureuser",
            "admin_password": None,
            "custom_data": None,
            "user_data": None,
            "disable_password_authentication": True,
            "network_interface_ids": [None],
            "provision_vm_agent": True,
            "allow_extension_operations": False,
            "secure_boot_enabled": True,
            "vtpm_enabled": True,
            "priority": "Regular",
            "max_bid_price": -1,
            "tags": TAGS,
            "admin_ssh_key": [{"username": "azureuser", "public_key": SSH_KEY}],
            "os_disk": [
                {
                    "name": f"{PREFIX}-os",
                    "caching": "ReadWrite",
                    "storage_account_type": "StandardSSD_LRS",
                    "disk_size_gb": 64,
                    "write_accelerator_enabled": False,
                }
            ],
            "source_image_reference": [
                {
                    "publisher": "Canonical",
                    "offer": "ubuntu-24_04-lts",
                    "sku": "server-arm64",
                    "version": "24.04.202608010",
                }
            ],
            "additional_capabilities": [],
            "boot_diagnostics": [],
            "gallery_application": [],
            "identity": [],
            "plan": [],
            "secret": [],
        },
        "azurerm_managed_disk.data": {
            "name": f"{PREFIX}-data",
            "location": "eastus2",
            "resource_group_name": f"{PREFIX}-rg",
            "storage_account_type": "StandardSSD_LRS",
            "create_option": "Empty",
            "disk_size_gb": 64,
            "network_access_policy": "AllowAll",
            "public_network_access_enabled": True,
            "optimized_frequent_attach_enabled": False,
            "performance_plus_enabled": False,
            "tags": {**TAGS, "preservation": "manual-delete-only"},
        },
        "azurerm_virtual_machine_data_disk_attachment.data": {
            "managed_disk_id": None,
            "virtual_machine_id": None,
            "lun": 0,
            "caching": "None",
            "create_option": "Attach",
            "write_accelerator_enabled": False,
        },
        "azurerm_management_lock.data": {
            "name": f"{PREFIX}-data-delete-lock",
            "scope": None,
            "lock_level": "CanNotDelete",
            "notes": "Preserve synthetic beta state across VM replacement; removal requires a separately reviewed manual operation.",
        },
        "azurerm_management_lock.public_ip": {
            "name": f"{PREFIX}-pip-delete-lock",
            "scope": None,
            "lock_level": "CanNotDelete",
            "notes": "Do not release this OCI network-source trust anchor before revoking every retained-OCI credential and verifying denial.",
        },
        "azurerm_dev_test_global_vm_shutdown_schedule.beta": {
            "virtual_machine_id": None,
            "location": "eastus2",
            "enabled": True,
            "daily_recurrence_time": "1800",
            "timezone": "UTC",
            "tags": TAGS,
            "notification_settings": [
                {
                    "enabled": True,
                    "email": "ops@nourishing.app",
                    "time_in_minutes": 30,
                }
            ],
        },
        "azurerm_consumption_budget_resource_group.beta": {
            "name": f"{PREFIX}-monthly-budget",
            "resource_group_id": None,
            "amount": 20,
            "time_grain": "Monthly",
            "time_period": [{"start_date": "2026-08-01T00:00:00Z"}],
            "notification": _notifications(),
        },
    }


def _set_expression(root: dict[str, Any], path: tuple[Any, ...], leaf: str) -> None:
    current: Any = root
    for index, step in enumerate(path):
        final = index == len(path) - 1
        expression = {"references": [leaf, leaf.rsplit(".", 1)[0]]}
        if isinstance(step, int):
            while len(current) <= step:
                current.append({})
            if final:
                current[step] = expression
            else:
                current = current[step]
        else:
            if final:
                current[step] = expression
            else:
                next_step = path[index + 1]
                current = current.setdefault(
                    step, [] if isinstance(next_step, int) else {}
                )


def _configuration() -> dict[str, Any]:
    expressions = {address: {} for address in AUDITOR.EXPECTED_CREATES}
    refs = (
        ("azurerm_consumption_budget_resource_group.beta", ("resource_group_id",), "azurerm_resource_group.beta.id"),
        ("azurerm_dev_test_global_vm_shutdown_schedule.beta", ("virtual_machine_id",), "azurerm_linux_virtual_machine.beta.id"),
        ("azurerm_linux_virtual_machine.beta", ("network_interface_ids",), "azurerm_network_interface.beta.id"),
        ("azurerm_management_lock.data", ("scope",), "azurerm_managed_disk.data.id"),
        ("azurerm_management_lock.public_ip", ("scope",), "azurerm_public_ip.beta.id"),
        ("azurerm_network_interface.beta", ("ip_configuration", 0, "subnet_id"), "azurerm_subnet.beta.id"),
        ("azurerm_network_interface.beta", ("ip_configuration", 0, "public_ip_address_id"), "azurerm_public_ip.beta.id"),
        ("azurerm_subnet_network_security_group_association.beta", ("subnet_id",), "azurerm_subnet.beta.id"),
        ("azurerm_subnet_network_security_group_association.beta", ("network_security_group_id",), "azurerm_network_security_group.beta.id"),
        ("azurerm_virtual_machine_data_disk_attachment.data", ("managed_disk_id",), "azurerm_managed_disk.data.id"),
        ("azurerm_virtual_machine_data_disk_attachment.data", ("virtual_machine_id",), "azurerm_linux_virtual_machine.beta.id"),
    )
    for address, path, leaf in refs:
        _set_expression(expressions[address], path, leaf)
    return {
        "provider_config": {
            "azurerm": {
                "name": "azurerm",
                "full_name": AUDITOR.AZURERM_PROVIDER,
                "version_constraint": "4.79.0",
                "expressions": {
                    "subscription_id": {"references": ["var.subscription_id"]},
                    "resource_provider_registrations": {"constant_value": "none"},
                    "features": [
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
                },
            }
        },
        "root_module": {
            "resources": [
                {
                    "address": address,
                    "mode": "managed",
                    "type": address.split(".", 1)[0],
                    "name": address.split(".", 1)[1],
                    "provider_config_key": "azurerm",
                    "schema_version": AUDITOR.EXPECTED_SCHEMA_VERSIONS[address],
                    "expressions": expressions[address],
                }
                for address in sorted(AUDITOR.EXPECTED_CREATES)
            ]
        }
    }


def _check(address: str, status: str) -> dict[str, Any]:
    resource_type, name = address.split(".", 1)
    return {
        "address": {
            "kind": "resource",
            "mode": "managed",
            "name": name,
            "to_display": address,
            "type": resource_type,
        },
        "status": status,
        "instances": [
            {"address": {"to_display": address}, "status": status}
        ],
    }


def valid_plan() -> dict[str, Any]:
    after_values = _after_values()
    changes = []
    for address in sorted(AUDITOR.EXPECTED_CREATES):
        required_unknowns = AUDITOR.UNKNOWN_RULES[address][0]
        changes.append(
            {
                "address": address,
                "mode": "managed",
                "type": address.split(".", 1)[0],
                "name": address.split(".", 1)[1],
                "provider_name": AUDITOR.AZURERM_PROVIDER,
                "change": {
                    "actions": ["create"],
                    "before": None,
                    "after": after_values[address],
                    "after_unknown": _mask(required_unknowns),
                    "before_sensitive": {},
                    "after_sensitive": (
                        {
                            "admin_password": True,
                            "custom_data": True,
                            "admin_ssh_key": [{"public_key": True}],
                        }
                        if address == "azurerm_linux_virtual_machine.beta"
                        else {}
                    ),
                },
            }
        )
    return {
        "format_version": "1.2",
        "terraform_version": "1.5.7",
        "timestamp": "2026-08-25T16:00:00Z",
        "resource_drift": [],
        "variables": _variables(),
        "configuration": _configuration(),
        "resource_changes": changes,
        "checks": [
            _check("azurerm_resource_group.beta", "unknown"),
            _check("azurerm_linux_virtual_machine.beta", "pass"),
        ],
    }


def _change(plan: dict[str, Any], address: str) -> dict[str, Any]:
    return next(
        item["change"] for item in plan["resource_changes"] if item["address"] == address
    )


def _configured(plan: dict[str, Any], address: str) -> dict[str, Any]:
    return next(
        item
        for item in plan["configuration"]["root_module"]["resources"]
        if item["address"] == address
    )


class SavedPlanAuditTests(unittest.TestCase):
    def assert_rejected(self, plan: dict[str, Any]) -> None:
        with self.assertRaises(AUDITOR.PlanAuditError):
            AUDITOR.audit_plan(plan)

    def test_accepts_semantically_exact_create_only_graph(self) -> None:
        AUDITOR.audit_plan(valid_plan())

    def test_rejects_malicious_security_and_cost_values(self) -> None:
        mutations = (
            ("azurerm_network_security_group.beta", ("security_rule", 0, "source_address_prefix"), "0.0.0.0/0"),
            ("azurerm_linux_virtual_machine.beta", ("disable_password_authentication",), False),
            ("azurerm_linux_virtual_machine.beta", ("admin_password",), "exposed"),
            ("azurerm_linux_virtual_machine.beta", ("size",), "Standard_M416ms_v2"),
            ("azurerm_linux_virtual_machine.beta", ("os_disk", 0, "disk_size_gb"), 32767),
            ("azurerm_managed_disk.data", ("disk_size_gb",), 32767),
            ("azurerm_public_ip.beta", ("allocation_method",), "Dynamic"),
            ("azurerm_public_ip.beta", ("sku",), "Basic"),
        )
        for address, path, value in mutations:
            with self.subTest(address=address, path=path):
                plan = valid_plan()
                current: Any = _change(plan, address)["after"]
                for step in path[:-1]:
                    current = current[step]
                current[path[-1]] = value
                self.assert_rejected(plan)

    def test_rejects_missing_and_extra_meaningful_after_fields(self) -> None:
        plan = valid_plan()
        del _change(plan, "azurerm_linux_virtual_machine.beta")["after"]["size"]
        self.assert_rejected(plan)

        plan = valid_plan()
        _change(plan, "azurerm_linux_virtual_machine.beta")["after"]["capacity_reservation_group_id"] = "paid-reservation"
        self.assert_rejected(plan)

    def test_rejects_placeholder_inputs(self) -> None:
        plan = valid_plan()
        plan["variables"]["ssh_public_key"]["value"] = "ssh-ed25519 REPLACE_WITH_KEY"
        self.assert_rejected(plan)

        plan = valid_plan()
        plan["variables"]["ubuntu_image_version"]["value"] = "latest"
        self.assert_rejected(plan)

    def test_rejects_unreviewed_or_missing_unknown_paths(self) -> None:
        plan = valid_plan()
        _change(plan, "azurerm_linux_virtual_machine.beta")["after_unknown"]["admin_password"] = True
        self.assert_rejected(plan)

        plan = valid_plan()
        del _change(plan, "azurerm_public_ip.beta")["after_unknown"]["ip_address"]
        self.assert_rejected(plan)

        for field in ("patch_mode", "patch_assessment_mode"):
            with self.subTest(field=field):
                plan = valid_plan()
                del _change(plan, "azurerm_linux_virtual_machine.beta")[
                    "after_unknown"
                ][field]
                self.assert_rejected(plan)

    def test_rejects_unreviewed_sensitive_metadata(self) -> None:
        plan = valid_plan()
        _change(plan, "azurerm_linux_virtual_machine.beta")["after_sensitive"]["user_data"] = True
        self.assert_rejected(plan)

        plan = valid_plan()
        del _change(plan, "azurerm_linux_virtual_machine.beta")["after_sensitive"]["custom_data"]
        self.assert_rejected(plan)

        plan = valid_plan()
        _change(plan, "azurerm_public_ip.beta")["after_sensitive"] = {"ip_address": True}
        self.assert_rejected(plan)

    def test_rejects_provider_configuration_near_misses(self) -> None:
        mutations = (
            ("version_constraint", "4.80.0"),
            ("full_name", "registry.terraform.io/example/azurerm"),
        )
        for key, value in mutations:
            with self.subTest(key=key):
                plan = valid_plan()
                plan["configuration"]["provider_config"]["azurerm"][key] = value
                self.assert_rejected(plan)

        plan = valid_plan()
        expressions = plan["configuration"]["provider_config"]["azurerm"]["expressions"]
        expressions["subscription_id"] = {"constant_value": "attacker-subscription"}
        self.assert_rejected(plan)

        plan = valid_plan()
        expressions = plan["configuration"]["provider_config"]["azurerm"]["expressions"]
        expressions["resource_provider_registrations"] = {"constant_value": "extended"}
        self.assert_rejected(plan)

        plan = valid_plan()
        features = plan["configuration"]["provider_config"]["azurerm"]["expressions"]["features"]
        features[0]["resource_group"][0]["prevent_deletion_if_contains_resources"] = {
            "constant_value": False
        }
        self.assert_rejected(plan)

        plan = valid_plan()
        plan["configuration"]["provider_config"]["azurerm.evil"] = copy.deepcopy(
            plan["configuration"]["provider_config"]["azurerm"]
        )
        self.assert_rejected(plan)

    def test_rejects_replacement_and_create_before_destroy_metadata(self) -> None:
        plan = valid_plan()
        target = _change(plan, "azurerm_resource_group.beta")
        target["actions"] = ["create", "delete"]
        target["replace_paths"] = [["name"]]
        self.assert_rejected(plan)

        plan = valid_plan()
        _change(plan, "azurerm_resource_group.beta")["create_before_destroy"] = True
        self.assert_rejected(plan)

    def test_rejects_wrong_nic_subnet_and_vm_wiring(self) -> None:
        plan = valid_plan()
        _configured(plan, "azurerm_network_interface.beta")["expressions"]["ip_configuration"][0]["subnet_id"]["references"] = [
            "azurerm_subnet.unreviewed.id",
            "azurerm_subnet.unreviewed",
        ]
        self.assert_rejected(plan)

        plan = valid_plan()
        _configured(plan, "azurerm_linux_virtual_machine.beta")["expressions"]["network_interface_ids"]["references"].append(
            "azurerm_network_interface.unreviewed.id"
        )
        self.assert_rejected(plan)

    def test_allows_only_apply_time_resource_group_check_unknown(self) -> None:
        AUDITOR.audit_plan(valid_plan())

        plan = valid_plan()
        plan["checks"][0]["status"] = "pass"
        plan["checks"][0]["instances"][0]["status"] = "pass"
        self.assert_rejected(plan)

        plan = valid_plan()
        plan["checks"][1]["status"] = "unknown"
        plan["checks"][1]["instances"][0]["status"] = "unknown"
        self.assert_rejected(plan)

    def test_rejects_failed_error_or_problem_check(self) -> None:
        for status in ("fail", "error"):
            with self.subTest(status=status):
                plan = valid_plan()
                plan["checks"][1]["status"] = status
                plan["checks"][1]["instances"][0]["status"] = status
                self.assert_rejected(plan)
        plan = valid_plan()
        plan["checks"][0]["instances"][0]["problems"] = [{"message": "bad"}]
        self.assert_rejected(plan)

    def test_rejects_budget_and_shutdown_near_misses(self) -> None:
        plan = valid_plan()
        _change(plan, "azurerm_consumption_budget_resource_group.beta")["after"]["notification"][3]["threshold_type"] = "Actual"
        self.assert_rejected(plan)

        plan = valid_plan()
        _change(plan, "azurerm_dev_test_global_vm_shutdown_schedule.beta")["after"]["timezone"] = "Central Standard Time"
        self.assert_rejected(plan)

    def test_rejects_tags_names_and_image_near_misses(self) -> None:
        plan = valid_plan()
        _change(plan, "azurerm_resource_group.beta")["after"]["tags"]["terraform-scope"] = "runtime"
        self.assert_rejected(plan)

        plan = valid_plan()
        _change(plan, "azurerm_public_ip.beta")["after"]["name"] = "shared-pip"
        self.assert_rejected(plan)

        plan = valid_plan()
        _change(plan, "azurerm_linux_virtual_machine.beta")["after"]["source_image_reference"][0]["sku"] = "server"
        self.assert_rejected(plan)

    def test_rejects_stale_preflight_wrong_quota_and_paid_priority(self) -> None:
        plan = valid_plan()
        plan["variables"]["live_preflight"]["value"]["checked_at_utc"] = "2026-08-25T11:59:59Z"
        self.assert_rejected(plan)

        plan = valid_plan()
        plan["variables"]["live_preflight"]["value"]["epsv5_family_vcpu_remaining"] = 1
        self.assert_rejected(plan)

        plan = valid_plan()
        _change(plan, "azurerm_linux_virtual_machine.beta")["after"]["priority"] = "Spot"
        self.assert_rejected(plan)

    def test_rejects_missing_extra_update_delete_and_noop_resources(self) -> None:
        plan = valid_plan()
        plan["resource_changes"].pop()
        self.assert_rejected(plan)

        for actions in (["update"], ["delete"], ["delete", "create"], ["no-op"]):
            with self.subTest(actions=actions):
                plan = valid_plan()
                plan["resource_changes"][0]["change"]["actions"] = actions
                self.assert_rejected(plan)

    def test_rejects_import_move_deposed_drift_and_wrong_provider(self) -> None:
        mutations = (
            ("change", "importing", {"id": "existing"}),
            ("entry", "previous_address", "azurerm_resource_group.old"),
            ("entry", "deposed", "deadbeef"),
            ("entry", "provider_name", "registry.terraform.io/hashicorp/random"),
        )
        for scope, field, value in mutations:
            with self.subTest(field=field):
                plan = valid_plan()
                entry = plan["resource_changes"][0]
                target = entry["change"] if scope == "change" else entry
                target[field] = value
                self.assert_rejected(plan)
        plan = valid_plan()
        plan["resource_drift"] = [{"address": "azurerm_public_ip.beta"}]
        self.assert_rejected(plan)

    def test_rejects_non_1_5_7_metadata_or_wrong_terraform_plan(self) -> None:
        for field, value in (("errored", False), ("applyable", True), ("complete", True)):
            with self.subTest(field=field):
                plan = valid_plan()
                plan[field] = value
                self.assert_rejected(plan)

        plan = valid_plan()
        plan["terraform_version"] = "1.6.0"
        self.assert_rejected(plan)


class BinaryPlanBoundaryTests(unittest.TestCase):
    def _private_fixture(self, directory: Path) -> tuple[Path, Path]:
        plan = directory / "reviewed.tfplan"
        plan.write_bytes(b"opaque binary plan fixture")
        plan.chmod(0o600)
        terraform = directory / "terraform"
        terraform.write_bytes(b"reviewed terraform fixture")
        terraform.chmod(0o700)
        return plan, terraform

    def test_binary_boundary_hashes_renders_audits_and_scrubs_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            plan, terraform = self._private_fixture(directory)
            version = subprocess.CompletedProcess(
                [],
                0,
                stdout=json.dumps({"terraform_version": "1.5.7"}).encode(),
                stderr=b"",
            )
            rendered = subprocess.CompletedProcess(
                [], 0, stdout=json.dumps(valid_plan()).encode(), stderr=b""
            )
            with mock.patch.object(AUDITOR.subprocess, "run", side_effect=[version, rendered]) as run:
                result = AUDITOR.audit_binary_plan(plan, terraform)
            self.assertRegex(result["plan_sha256"], r"^[0-9a-f]{64}$")
            self.assertEqual(result["plan_size_bytes"], plan.stat().st_size)
            self.assertEqual(
                result["failure_containment_vm_resource_id"],
                "/subscriptions/11111111-2222-3333-4444-555555555555/"
                "resourceGroups/nutrition-beta-rg/providers/Microsoft.Compute/"
                "virtualMachines/nutrition-beta-vm",
            )
            self.assertEqual(result["shutdown_schedule_utc_time"], "1800")
            show_call = run.call_args_list[1]
            self.assertEqual(show_call.args[0][1:3], ["show", "-json"])
            environment = show_call.kwargs["env"]
            for forbidden in ("HTTP_PROXY", "TF_CLI_ARGS", "TF_LOG", "ARM_CLIENT_SECRET"):
                self.assertNotIn(forbidden, environment)
            self.assertEqual(environment["TF_CLI_CONFIG_FILE"], "/dev/null")

    def test_binary_boundary_rejects_mode_suffix_symlink_and_hardlink(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            plan, _ = self._private_fixture(directory)
            plan.chmod(0o644)
            with self.assertRaises(AUDITOR.PlanAuditError):
                AUDITOR.secure_plan_digest(plan)
            plan.chmod(0o600)
            wrong_suffix = directory / "plan.json"
            wrong_suffix.write_bytes(b"not admitted")
            wrong_suffix.chmod(0o600)
            with self.assertRaises(AUDITOR.PlanAuditError):
                AUDITOR.secure_plan_digest(wrong_suffix)
            symlink = directory / "symlink.tfplan"
            symlink.symlink_to(plan)
            with self.assertRaises(AUDITOR.PlanAuditError):
                AUDITOR.secure_plan_digest(symlink)
            hardlink = directory / "hardlink.tfplan"
            os.link(plan, hardlink)
            with self.assertRaises(AUDITOR.PlanAuditError):
                AUDITOR.secure_plan_digest(plan)

    def test_binary_boundary_rejects_non_private_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            plan, _ = self._private_fixture(directory)
            directory.chmod(0o755)
            try:
                with self.assertRaises(AUDITOR.PlanAuditError):
                    AUDITOR.secure_plan_digest(plan)
            finally:
                directory.chmod(0o700)

    def test_attestation_is_new_mode_0600_and_round_trips(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            result = {
                "schema": AUDITOR.ATTESTATION_SCHEMA,
                "failure_containment_vm_resource_id": (
                    "/subscriptions/11111111-2222-3333-4444-555555555555/"
                    "resourceGroups/nutrition-beta-rg/providers/Microsoft.Compute/"
                    "virtualMachines/nutrition-beta-vm"
                ),
                "shutdown_schedule_utc_time": "1800",
                "plan_sha256": "a" * 64,
                "plan_size_bytes": 123,
                "terraform_binary": "/reviewed/terraform",
                "terraform_sha256": "b" * 64,
                "terraform_version": "1.5.7",
            }
            attestation = directory / "audit.plan-attestation.json"
            AUDITOR.write_attestation(attestation, result)
            self.assertEqual(attestation.stat().st_mode & 0o777, 0o600)
            self.assertEqual(AUDITOR.load_attestation(attestation), result)
            with self.assertRaises(AUDITOR.PlanAuditError):
                AUDITOR.write_attestation(attestation, result)

            old_schema = directory / "old.plan-attestation.json"
            old_result = {**result, "schema": "nutrition-tracker.azure-saved-plan-attestation.v1"}
            old_schema.write_text(json.dumps(old_result), encoding="utf-8")
            old_schema.chmod(0o600)
            with self.assertRaises(AUDITOR.PlanAuditError):
                AUDITOR.load_attestation(old_schema)

            bad_time = directory / "bad-time.plan-attestation.json"
            bad_time.write_text(
                json.dumps({**result, "shutdown_schedule_utc_time": "2460"}),
                encoding="utf-8",
            )
            bad_time.chmod(0o600)
            with self.assertRaises(AUDITOR.PlanAuditError):
                AUDITOR.load_attestation(bad_time)


if __name__ == "__main__":
    unittest.main()
