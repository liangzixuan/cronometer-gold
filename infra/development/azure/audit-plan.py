#!/usr/bin/env python3
"""Audit a protected development saved plan; success is local policy acceptance only."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
import resource
import signal
import shutil
import stat
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
HELPER = REPO / "infra/azure/tests/audit_saved_plan.py"
_spec = importlib.util.spec_from_file_location("azure_protected_plan_helpers", HELPER)
assert _spec and _spec.loader
H = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(H)
Error = H.PlanAuditError
require = H._require
utc = H._parse_utc
TF_SHA256 = "d49d3a48321c0a7ff258d8d229fb11a64832eff06980b6a348627279759e5747"
PROVIDER_FILES = {
    "terraform-provider-azurerm_v4.79.0_x5": ("d46e8fda3b8b50e362fc13e59477684771baa5a1cab846f2073dc06e6808779b", 0o755),
    "LICENSE.txt": ("4e2bb185ebd706f76329206869ccb348b92b6236100cfb07775fe31530dab0d5", 0o644),
}
LOCK_SHA256 = "bff61c4c32ccce099d94c3bf38de033a7ef4a00f47e9384833fa8a221b6fa9f5"
LOCATION = "centralus"
SKU = "Standard_B4ps_v2"
IMAGE = "Canonical:ubuntu-24_04-lts:server-arm64:24.04.202609040"
PROVIDER = "registry.terraform.io/hashicorp/azurerm"
MAX_JSON = 20 * 1024 * 1024
TAGS = {"availability": "single-server-non-ha", "data-classification": "synthetic-only",
        "environment": "development", "managed-by": "terraform", "purchase-model": "on-demand",
        "terraform-scope": "empty-host-only"}
EVIDENCE_KINDS = {"credit", "providers", "compute", "quota", "sku", "image"}
VARIABLES = {"subscription_id", "name_prefix", "admin_ipv4_cidr", "ssh_public_key",
             "shutdown_deadline_utc", "live_preflight"}

def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate JSON field")
            result[key] = value
        return result
    def invalid_constant(value):
        raise Error("non-finite JSON number")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def unique(items, key, label):
    require(isinstance(items, list), label + " must be an array")
    result = {}
    for item in items:
        require(isinstance(item, dict) and isinstance(item.get(key), str), label + " malformed entry")
        require(item[key] not in result, label + " duplicate entry")
        result[item[key]] = item
    return result

def number(value, label):
    require(type(value) in (int, float) and math.isfinite(value) and value >= 0, label + " invalid number")
    return value

def receipt_utc(value, label):
    # The saved Windows image collector emits the equivalent explicit UTC offset.
    if isinstance(value, str) and value.endswith("+00:00"):
        value = value[:-6] + "Z"
    return utc(value, label)

def record(doc, label, now):
    entries = doc.get("records", doc.get("commands"))
    item = unique(entries, "label", "receipt records").get(label)
    require(item is not None, "required original read receipt missing: " + label)
    require(type(item.get("exitCode")) is int and item["exitCode"] == 0 and item.get("timedOut", False) is False
            and (item.get("completed") is True or (label == "selected-exact-CentralUS-Canonical-Arm64-image" and item.get("timedOut") is False and "error" in item)) and not item.get("knownErrors")
            and not item.get("knownErrorCodes") and not item.get("error")
            and not item.get("mutations"), "read receipt did not complete cleanly: " + label)
    start, end = receipt_utc(item.get("startedAt"), "read start"), receipt_utc(item.get("endedAt"), "read end")
    require(now - timedelta(hours=4) <= start <= end <= now, "read receipt stale or future: " + label)
    require(end - start <= timedelta(minutes=2), "read receipt duration exceeded")
    for key in ("stdoutSha256", "stderrSha256"):
        require(isinstance(item.get(key), str) and re.fullmatch(r"[0-9a-f]{64}", item[key]), "missing original output digest")
    require(isinstance(item.get("selected"), (dict, list)), "missing selected ARM response")
    return item

def rest(item, subscription, path):
    args = item.get("arguments")
    require(isinstance(args, list) and args[:5] == ["-IBm", "azure.cli", "rest", "--method", "get"], "receipt is not an Azure CLI GET")
    require(all(isinstance(x, str) for x in args) and len(args) == len(set(args)), "ambiguous receipt arguments")
    def arg(flag):
        require(flag in args and args.index(flag) + 1 < len(args), "missing read argument")
        return args[args.index(flag) + 1]
    require(arg("--subscription") == subscription and arg("--output") == "json" and "--only-show-errors" in args,
            "read subscription or output mismatch")
    url = urlsplit(arg("--url"))
    require(url.scheme == "https" and url.netloc == "management.azure.com" and not url.fragment
            and url.path.lower() == path.lower() and "api-version" in parse_qs(url.query), "read ARM endpoint mismatch")
    return item["selected"]

def evidence_values(documents, hashes, subscription, deadline, now):
    require(set(documents) == EVIDENCE_KINDS and set(hashes) == EVIDENCE_KINDS, "six original evidence families are required")
    require(all(isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) for v in hashes.values()), "invalid evidence digest")
    used = []
    def read(kind, label, path):
        item = record(documents[kind], label, now); used.append(receipt_utc(item["startedAt"], "read start"))
        return rest(item, subscription, path)
    base = "/subscriptions/" + subscription
    sub = read("providers", "after-subscription-policy", base)
    require(sub.get("subscriptionId") == subscription and sub.get("state") == "Enabled", "subscription unavailable or mismatched")
    policy = sub.get("subscriptionPolicies", {})
    require(policy.get("quotaId") == "AzureForStudents_2018-01-01" and policy.get("spendingLimit") == "On", "Students spending protection required")
    billing = read("providers", "after-billing-property", base + "/providers/Microsoft.Billing/billingProperty/default")
    require(billing.get("billingProfileSpendingLimit") == "On" and billing.get("billingProfileStatus") == "Active"
            and billing.get("subscriptionBillingStatus") == "Active" and billing.get("subscriptionBillingType") == "Free", "billing protection or eligibility changed")
    profile = billing.get("billingProfileId")
    require(isinstance(profile, str) and re.fullmatch(r"/providers/Microsoft.Billing/billingAccounts/[^/]+/billingProfiles/[^/]+", profile), "missing billing profile")
    balance = read("credit", "credit-balance-summary", profile + "/providers/Microsoft.Consumption/credits/balanceSummary")
    require(balance.get("isEstimatedBalance") is False and balance.get("creditCurrency") == "USD"
            and balance.get("billingCurrency") == "USD", "exact USD balance required")
    current = balance.get("balanceSummary", {}).get("currentBalance", {})
    require(current.get("currency") == "USD", "credit currency mismatch")
    remaining = number(current.get("value"), "credit balance")
    for key in ("pendingEligibleCharges", "pendingCreditAdjustments"):
        amount = balance.get(key, {})
        require(amount.get("currency") == "USD" and number(amount.get("value"), key) == 0, "unsettled credit obligations")
    lots = read("credit", "credit-lots", profile + "/providers/Microsoft.Consumption/lots")
    require(lots.get("hasNext") is False and isinstance(lots.get("credits"), list) and len(lots["credits"]) == 1, "one complete Students credit lot required")
    lot = lots["credits"][0]
    require(lot.get("source") == "Azure for students credit" and lot.get("isEstimatedBalance") is False,
            "unreviewed credit source")
    require(utc(lot.get("startDate"), "credit start") <= now, "credit not started")
    expiry = utc(lot.get("expirationDate"), "credit expiry")
    closed = lot.get("closedBalance", {})
    require(closed.get("currency") == "USD" and number(closed.get("value"), "lot balance") >= remaining >= 20
            and expiry >= deadline + timedelta(days=31), "credit reserve or retention coverage insufficient")
    for kind, label, namespace in [("compute", "after-compute-registration-once", "Microsoft.Compute"),
                                   ("providers", "after-Microsoft.Network-once", "Microsoft.Network"),
                                   ("providers", "after-Microsoft.DevTestLab-once", "Microsoft.DevTestLab")]:
        selected = read(kind, label, base + "/providers/" + namespace)
        require(selected == {"namespace": namespace, "registrationState": "Registered"}, "required provider not registered")
    quota = read("quota", "centralus-positive-and-arm-family-quotas", base + "/providers/Microsoft.Compute/locations/centralus/usages")
    require(quota.get("hasNext") is False and quota.get("nextLink") is None, "quota read incomplete")
    quotas = unique(quota.get("matches"), "name", "quota")
    capacity = []
    for name in ("cores", "standardBpsv2Family"):
        q = quotas.get(name, {})
        require(q.get("unit") == "Count", "missing exact regional or family quota")
        available = number(q.get("limit"), "quota limit") - number(q.get("currentValue"), "quota use")
        require(available >= 4, "four available cores required"); capacity.append(available)
    sku = read("sku", "centralus-Standard_B4ps_v2-exact", base + "/providers/Microsoft.Compute/skus")
    require(sku.get("hasNext") is False and sku.get("nextLink") is None and len(sku.get("matches", [])) == 1, "exact SKU read incomplete")
    item = sku["matches"][0]
    require(item.get("name") == SKU and item.get("family") == "standardBpsv2Family"
            and item.get("locations") == [LOCATION] and item.get("restrictions") == [], "SKU unavailable or restricted")
    caps = {k: v.get("value") for k, v in unique(item.get("capabilities"), "name", "SKU capabilities").items()}
    for key, value in {"vCPUs": "4", "vCPUsAvailable": "4", "MemoryGB": "16", "CpuArchitectureType": "Arm64", "TrustedLaunchDisabled": "True"}.items():
        require(caps.get(key) == value, "SKU capability mismatch")
    require("V2" in caps.get("HyperVGenerations", "").split(","), "Gen2 hardware required")
    image = record(documents["image"], "selected-exact-CentralUS-Canonical-Arm64-image", now)
    used.append(receipt_utc(image["startedAt"], "image read start"))
    args = image.get("arguments", [])
    require(args[:3] == ["vm", "image", "show"] and args[3:7] == ["--location", LOCATION, "--urn", IMAGE]
            and len(args) == 9 and args[7] == "--query", "image read command mismatch")
    image = image["selected"]
    require(image.get("name") == IMAGE.split(":")[-1] and image.get("location") == LOCATION
            and image.get("architecture") == "Arm64" and image.get("hyperVGeneration") == "V2"
            and image.get("plan") is None and image.get("imageDeprecationStatus", {}).get("imageState") == "Active"
            and image.get("osDiskImage", {}).get("operatingSystem") == "Linux", "exact active Linux image required")
    return {"checked_at_utc": min(used).isoformat().replace("+00:00", "Z"), "subscription_id": subscription,
            "spending_limit": "On", "billing_limit": "On", "credit_currency": "USD", "remaining_credit": remaining,
            "credit_expires_utc": lot["expirationDate"], "regional_remaining": capacity[0], "family_remaining": capacity[1],
            "source_sha256": hashes}

def inputs(document, documents, hashes, now):
    wrappers = H._exact_keys(document.get("variables"), VARIABLES, "development variables")
    values = {k: H._exact_keys(v, {"value"}, "variable")["value"] for k, v in wrappers.items()}
    require(isinstance(values["subscription_id"], str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", values["subscription_id"]), "subscription must be canonical UUID")
    require(isinstance(values["name_prefix"], str) and re.fullmatch(r"nourishing-dev-[0-9a-f]{12}", values["name_prefix"]), "owned development name required")
    H._audit_public_ipv4_cidr(values["admin_ipv4_cidr"]); H._audit_ssh_public_key(values["ssh_public_key"])
    planned = utc(document.get("timestamp"), "plan timestamp")
    require(now - timedelta(minutes=15) <= planned <= now, "saved plan stale or future")
    deadline = utc(values["shutdown_deadline_utc"], "shutdown deadline")
    require(deadline.second == 0 and deadline.microsecond == 0, "shutdown must align to UTC minute")
    for instant in (planned, now):
        require(timedelta(hours=1) <= deadline - instant <= timedelta(hours=4) and instant.date() == deadline.date(), "shutdown outside same-day session bound")
    facts = evidence_values(documents, hashes, values["subscription_id"], deadline, now)
    require(values["live_preflight"] == facts, "plan preflight does not match original receipt facts/digests")
    return values

def expected_values(v):
    prefix = v["name_prefix"]; common = {"location": LOCATION, "resource_group_name": prefix + "-rg", "tags": TAGS}
    def named(suffix, **fields): return {**common, "name": prefix + "-" + suffix, **fields}
    rules = []
    for name, priority, access, protocol, port, source, description in [
        ("allow-ssh-from-current-admin-ipv4", 100, "Allow", "Tcp", "22", v["admin_ipv4_cidr"], "SSH from exactly one freshly verified operator IPv4 /32."),
        ("allow-https-for-caddy", 120, "Allow", "Tcp", "443", "Internet", "Public HTTPS reaches Caddy; Caddy must enforce the one-/32 synthetic development application allowlist."),
        ("deny-all-other-inbound", 4096, "Deny", "*", "*", "*", "No public dependencies, HTTP or implicit VNet ingress.")]:
        rules.append(dict(name=name, priority=priority, access=access, protocol=protocol, destination_port_range=port,
                          source_address_prefix=source, description=description, direction="Inbound", source_port_range="*", destination_address_prefix="*"))
    return {
        "azurerm_resource_group.development": {"name": prefix + "-rg", "location": LOCATION, "tags": TAGS},
        "azurerm_virtual_network.development": named("vnet", address_space=["10.43.0.0/16"], private_endpoint_vnet_policies="Disabled"),
        "azurerm_subnet.development": {"name": prefix + "-subnet", "resource_group_name": prefix + "-rg", "virtual_network_name": prefix + "-vnet", "address_prefixes": ["10.43.1.0/24"], "default_outbound_access_enabled": False, "private_endpoint_network_policies": "Disabled", "private_link_service_network_policies_enabled": True},
        "azurerm_network_security_group.development": named("nsg", security_rule=rules),
        "azurerm_subnet_network_security_group_association.development": {"subnet_id": None, "network_security_group_id": None},
        "azurerm_public_ip.development": named("pip", allocation_method="Static", ip_version="IPv4", sku="Standard", sku_tier="Regional", ddos_protection_mode="VirtualNetworkInherited"),
        "azurerm_network_interface.development": named("nic", accelerated_networking_enabled=False, ip_forwarding_enabled=False, ip_configuration=[{"name": "primary", "subnet_id": None, "private_ip_address_allocation": "Dynamic", "private_ip_address_version": "IPv4", "public_ip_address_id": None, "primary": True}]),
        "azurerm_linux_virtual_machine.development": named("vm", computer_name="nutrition-development", size=SKU, admin_username="azureuser", admin_password=None, custom_data=None, user_data=None, disable_password_authentication=True, network_interface_ids=[None], provision_vm_agent=True, allow_extension_operations=False, secure_boot_enabled=False, vtpm_enabled=False, priority="Regular", max_bid_price=-1, admin_ssh_key=[{"username": "azureuser", "public_key": v["ssh_public_key"]}], os_disk=[{"name": prefix + "-os", "caching": "ReadWrite", "storage_account_type": "StandardSSD_LRS", "disk_size_gb": 64, "write_accelerator_enabled": False}], source_image_reference=[dict(zip(("publisher", "offer", "sku", "version"), IMAGE.split(":")))]),
        "azurerm_managed_disk.data": named("data", storage_account_type="StandardSSD_LRS", create_option="Empty", disk_size_gb=64, network_access_policy="AllowAll", public_network_access_enabled=True, optimized_frequent_attach_enabled=False, performance_plus_enabled=False),
        "azurerm_virtual_machine_data_disk_attachment.data": {"managed_disk_id": None, "virtual_machine_id": None, "lun": 0, "caching": "None", "create_option": "Attach", "write_accelerator_enabled": False},
        "azurerm_dev_test_global_vm_shutdown_schedule.development": {"virtual_machine_id": None, "location": LOCATION, "enabled": True, "daily_recurrence_time": utc(v["shutdown_deadline_utc"], "deadline").strftime("%H%M"), "timezone": "UTC", "tags": TAGS, "notification_settings": [{"enabled": False, "time_in_minutes": 30}]},
    }

def match(actual, expected, label):
    if label.endswith(".tags"):
        require(actual == expected, label + " exact tags required")
    if isinstance(expected, dict):
        require(isinstance(actual, dict), label + " must be an object")
        for key, value in expected.items():
            require(key in actual, label + " missing " + key); match(actual[key], value, label + "." + key)
        for key in set(actual) - set(expected):
            require(H._neutral(actual[key]), label + " unreviewed field " + key)
    elif isinstance(expected, list):
        require(isinstance(actual, list) and len(actual) == len(expected), label + " array mismatch")
        if label.endswith("security_rule"):
            actual = sorted(actual, key=lambda x: x.get("name", "")); expected = sorted(expected, key=lambda x: x["name"])
        for a, e in zip(actual, expected): match(a, e, label + "[]")
    else:
        require(actual == expected and (type(actual) is bool) == (type(expected) is bool), label + " value mismatch")

# Computed fields from the qualified AzureRM 4.79.0 schema and existing plan contract.
UNKNOWN_RULES = {'azurerm_dev_test_global_vm_shutdown_schedule.development': ({('virtual_machine_id',), ('id',)},
                                                              {('virtual_machine_id',), ('id',)}),
 'azurerm_linux_virtual_machine.development': ({('id',),
                                                ('network_interface_ids', 0),
                                                ('os_disk', 0, 'id'),
                                                ('patch_assessment_mode',),
                                                ('patch_mode',)},
                                               {('disk_controller_type',),
                                                ('id',),
                                                ('network_interface_ids', 0),
                                                ('os_disk', 0, 'id'),
                                                ('os_managed_disk_id',),
                                                ('patch_assessment_mode',),
                                                ('patch_mode',),
                                                ('private_ip_address',),
                                                ('private_ip_addresses',),
                                                ('public_ip_address',),
                                                ('public_ip_addresses',),
                                                ('virtual_machine_id',),
                                                ('vm_agent_platform_updates_enabled',)}),
 'azurerm_managed_disk.data': ({('id',)},
                               {('disk_iops_read_only',),
                                ('disk_iops_read_write',),
                                ('disk_mbps_read_only',),
                                ('disk_mbps_read_write',),
                                ('id',),
                                ('logical_sector_size',),
                                ('max_shares',),
                                ('source_uri',),
                                ('tier',)}),
 'azurerm_network_interface.development': ({('id',),
                                            ('ip_configuration', 0, 'public_ip_address_id'),
                                            ('ip_configuration', 0, 'subnet_id')},
                                           {('applied_dns_servers',),
                                            ('id',),
                                            ('internal_domain_name_suffix',),
                                            ('ip_configuration', 0, 'private_ip_address'),
                                            ('ip_configuration', 0, 'private_ip_address_version'),
                                            ('ip_configuration', 0, 'public_ip_address_id'),
                                            ('ip_configuration', 0, 'subnet_id'),
                                            ('mac_address',),
                                            ('private_ip_address',),
                                            ('private_ip_addresses',),
                                            ('virtual_machine_id',)}),
 'azurerm_network_security_group.development': ({('id',)}, {('id',)}),
 'azurerm_public_ip.development': ({('ip_address',), ('id',)},
                                   {('ip_address',), ('id',), ('fqdn',)}),
 'azurerm_resource_group.development': ({('id',)}, {('id',)}),
 'azurerm_subnet.development': ({('id',)}, {('id',)}),
 'azurerm_subnet_network_security_group_association.development': ({('id',),
                                                                    ('network_security_group_id',),
                                                                    ('subnet_id',)},
                                                                   {('id',),
                                                                    ('network_security_group_id',),
                                                                    ('subnet_id',)}),
 'azurerm_virtual_machine_data_disk_attachment.data': ({('id',),
                                                        ('managed_disk_id',),
                                                        ('virtual_machine_id',)},
                                                       {('id',),
                                                        ('managed_disk_id',),
                                                        ('virtual_machine_id',)}),
 'azurerm_virtual_network.development': ({('guid',), ('id',)},
                                         {('guid',), ('subnet',), ('id',), ('dns_servers',)})}

EXPECTED = frozenset(UNKNOWN_RULES)
SCHEMAS = {k: 1 if k == "azurerm_managed_disk.data" else 0 for k in EXPECTED}
REFERENCES = (
    ("azurerm_dev_test_global_vm_shutdown_schedule.development", ("virtual_machine_id",), "azurerm_linux_virtual_machine.development.id"),
    ("azurerm_linux_virtual_machine.development", ("network_interface_ids",), "azurerm_network_interface.development.id"),
    ("azurerm_network_interface.development", ("ip_configuration", 0, "subnet_id"), "azurerm_subnet.development.id"),
    ("azurerm_network_interface.development", ("ip_configuration", 0, "public_ip_address_id"), "azurerm_public_ip.development.id"),
    ("azurerm_subnet_network_security_group_association.development", ("subnet_id",), "azurerm_subnet.development.id"),
    ("azurerm_subnet_network_security_group_association.development", ("network_security_group_id",), "azurerm_network_security_group.development.id"),
    ("azurerm_virtual_machine_data_disk_attachment.data", ("managed_disk_id",), "azurerm_managed_disk.data.id"),
    ("azurerm_virtual_machine_data_disk_attachment.data", ("virtual_machine_id",), "azurerm_linux_virtual_machine.development.id"),
)

def audit_plan(document, documents, hashes, now):
    require(isinstance(document, dict), "plan must be an object")
    require(document.get("format_version") == "1.2" and document.get("terraform_version") == "1.5.7", "unreviewed Terraform JSON version")
    require(not set(document).intersection({"applyable", "complete", "errored"}), "unsupported Terraform metadata")
    require(document.get("resource_drift") in (None, []) and document.get("deferred_changes") in (None, []), "drift or deferred changes not admitted")
    require(document.get("prior_state") in (None, {}), "prior state not admitted")
    values = inputs(document, documents, hashes, now)
    expected = expected_values(values)
    configuration = document.get("configuration", {})
    H._audit_provider_configuration(configuration)
    root = configuration.get("root_module", {})
    require(not root.get("module_calls"), "nested modules not admitted")
    configured = unique(root.get("resources"), "address", "configured resources")
    require(set(configured) == EXPECTED, "configuration graph differs")
    for address, item in configured.items():
        resource_type, name = address.split(".")
        require(item.get("mode") == "managed" and item.get("type") == resource_type and item.get("name") == name
                and item.get("provider_config_key") == "azurerm" and item.get("schema_version") == SCHEMAS[address], "configured resource identity mismatch")
        require(not any(item.get(k) for k in ("count_expression", "for_each_expression", "provisioners", "connection")), "dynamic or executable configuration not admitted")
        require(isinstance(item.get("expressions"), dict), "missing expressions")
    for address, path, leaf in REFERENCES:
        H._require_reference(configured, address, path, leaf)
    changes = unique(document.get("resource_changes"), "address", "resource changes")
    require(set(changes) == EXPECTED, "exact eleven-resource graph required")
    for address, entry in changes.items():
        resource_type, name = address.split(".")
        require(set(entry) <= {"address", "mode", "type", "name", "provider_name", "change"}, "unreviewed lifecycle metadata")
        require(entry.get("mode") == "managed" and entry.get("type") == resource_type and entry.get("name") == name
                and entry.get("provider_name") == PROVIDER, "resource identity mismatch")
        change = entry.get("change", {})
        require(set(change) <= {"actions", "before", "after", "after_unknown", "before_sensitive", "after_sensitive", "replace_paths", "importing"}, "unreviewed change metadata")
        require(change.get("actions") == ["create"] and change.get("before") is None
                and change.get("replace_paths") in (None, []) and change.get("importing") is None, "only new create actions admitted")
        match(change.get("after"), expected[address], address)
        paths = H._flatten_mask(change.get("after_unknown"), "unknown fields")
        required, allowed = UNKNOWN_RULES[address]
        require(required <= paths and all(any(H._path_matches(p, a) for a in allowed) for p in paths), "unknown field mask differs")
        require(not H._flatten_mask(change.get("before_sensitive"), "prior sensitivity"), "prior sensitive value")
        sensitive = {("admin_password",), ("custom_data",), ("admin_ssh_key", 0, "public_key")} if resource_type == "azurerm_linux_virtual_machine" else set()
        require(H._flatten_mask(change.get("after_sensitive"), "sensitivity") == sensitive, "sensitivity mask differs")
    # If Terraform supplies planned_values, it must describe the same create graph.
    if "planned_values" in document:
        planned = document["planned_values"].get("root_module", {})
        require(not planned.get("child_modules"), "planned child modules not admitted")
        resources = unique(planned.get("resources"), "address", "planned resources")
        require(set(resources) == EXPECTED, "planned representation graph differs")
        for address, item in resources.items():
            require(item.get("mode") == "managed" and item.get("provider_name") == PROVIDER
                    and item.get("schema_version") == SCHEMAS[address], "planned resource identity differs")
            require(item.get("type") == address.split(".")[0] and item.get("name") == address.split(".")[1], "planned address metadata differs")
            # Terraform omits unknown values or represents them as null. All known fields remain equal.
            absent = object()
            def known(value):
                if value is None: return absent
                if isinstance(value, dict):
                    return {k: v for k, original in value.items() if (v := known(original)) is not absent}
                if isinstance(value, list):
                    members = [known(v) for v in value]
                    return absent if members and all(v is absent for v in members) else [None if v is absent else v for v in members]
                return value
            require(known(item.get("values")) == known(changes[address]["change"]["after"]), "planned values disagree with changes")
    address = "azurerm_resource_group.development"
    require(document.get("checks") == [{"address": H._check_address(address), "status": "unknown", "instances": [{"address": {"to_display": address}, "status": "unknown"}]}], "required apply-time preconditions differ")
    return {"resource_count": 11, "scope": "local empty-host plan policy only"}

def source_digest():
    files = [ROOT / n for n in (".terraform.lock.hcl", "versions.tf", "variables.tf", "main.tf", "outputs.tf", "audit-plan.py")]
    require({p.name for p in ROOT.glob("*.tf")} == {"versions.tf", "variables.tf", "main.tf", "outputs.tf"}
            and not list(ROOT.glob("*.tf.json")), "unreviewed Terraform source file")
    files.append(HELPER)
    data = []
    for path in files:
        require(path.is_file() and not path.is_symlink(), "source must be regular")
        data.append([str(path.relative_to(REPO)), sha(path.read_bytes()), stat.S_IMODE(path.stat().st_mode)])
    require(sha((ROOT / ".terraform.lock.hcl").read_bytes()) == LOCK_SHA256, "provider lock changed")
    return sha(json.dumps(data, separators=(",", ":")).encode())

def private_json(path):
    expected = H._secure_regular_file(path, "original evidence", ".json", MAX_JSON)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) == (expected.st_dev, expected.st_ino, expected.st_size, expected.st_mtime_ns), "evidence replaced while opening")
        raw = os.read(fd, MAX_JSON + 1); after = os.fstat(fd)
        require((before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_ino, after.st_size, after.st_mtime_ns)
                and len(raw) == before.st_size, "evidence changed during read")
        return strict_json(raw), sha(raw)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise Error("invalid evidence JSON") from error
    finally: os.close(fd)

def run_json(command, cwd, env, pass_fds=(), timeout=60):
    # Disk-backed bounded output avoids unbounded PIPE buffering. This command may not leave descendants.
    with tempfile.TemporaryDirectory(prefix="nourishing-plan-show-") as temporary:
        outpath, errpath = Path(temporary)/"out", Path(temporary)/"err"
        with outpath.open("wb") as out, errpath.open("wb") as err:
            child = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                     stdout=out, stderr=err, pass_fds=pass_fds, start_new_session=True,
                                     preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_JSON + 1, MAX_JSON + 1)))
            failure = None
            def group_exists():
                try: os.killpg(child.pid, 0); return True
                except ProcessLookupError: return False
            try:
                end = time.monotonic() + timeout
                while child.poll() is None:
                    if time.monotonic() >= end or max(outpath.stat().st_size, errpath.stat().st_size) > MAX_JSON:
                        failure = "renderer exceeded time or output bound"; break
                    time.sleep(0.02)
                if failure is None and (child.returncode != 0 or group_exists()): failure = "renderer failed or left descendants"
            finally:
                if child.poll() is None or group_exists():
                    cleanup_errors = []
                    try: os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        if group_exists(): cleanup_errors.append("group remains after missing-process signal")
                    except OSError: cleanup_errors.append("group kill failed")
                    try: child.wait(timeout=5)
                    except (OSError, subprocess.TimeoutExpired): cleanup_errors.append("leader did not settle")
                    deadline = time.monotonic()+5
                    while group_exists() and time.monotonic()<deadline: time.sleep(0.02)
                    require(not group_exists() and not cleanup_errors, "renderer cleanup failed or process group did not settle")
            require(failure is None, failure or "renderer failed")
        require(0 < outpath.stat().st_size <= MAX_JSON and errpath.stat().st_size == 0, "renderer output invalid")
        try: return strict_json(outpath.read_bytes())
        except (UnicodeError, json.JSONDecodeError) as error: raise Error("renderer JSON malformed") from error

def provider_digest(directory, private_root=None):
    require(directory.is_absolute() and directory.resolve() == directory, "absolute regular provider directory required")
    if private_root is not None:
        H._require_private_directory(private_root, "private provider root")
        require(private_root in directory.parents, "provider escaped private root")
    for path in [directory, *directory.parents[:-1]]:
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, os.getuid()) and not info.st_mode & 0o022, "unsafe provider directory")
        if path == private_root: break
    require({p.name for p in directory.iterdir()} == set(PROVIDER_FILES), "unexpected provider package files")
    result = {}
    for name, (expected, mode) in PROVIDER_FILES.items():
        path = directory / name; info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid in (0, os.getuid())
                and stat.S_IMODE(info.st_mode) == mode and info.st_nlink == 1, "unsafe provider package file")
        result[name] = H.secure_executable_digest(path)[0]
        require(result[name] == expected, "qualified provider package digest changed")
    return result

def prepare_provider(home, directory):
    expected = provider_digest(directory)
    target = Path(home) / "terraform/providers/registry.terraform.io/hashicorp/azurerm/4.79.0/linux_amd64"
    target.mkdir(parents=True, mode=0o700)
    for name, (_, mode) in PROVIDER_FILES.items():
        source_fd = os.open(directory / name, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            with os.fdopen(source_fd, "rb", closefd=False) as source:
                output_fd = os.open(target / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
                with os.fdopen(output_fd, "wb") as output:
                    shutil.copyfileobj(source, output)
                    os.fchmod(output.fileno(), mode)
        finally: os.close(source_fd)
    require(provider_digest(target, Path(home)) == expected and provider_digest(directory) == expected, "provider changed during private copy")
    return target, expected

class PublishedResultError(Error):
    """Complete result was published, but durability or temporary-file cleanup failed."""

def publish_result(path, result):
    parent = path.absolute().parent
    H._require_private_directory(parent, "local result")
    payload = (json.dumps(result, sort_keys=True) + "\n").encode()
    require(len(payload) <= 64 * 1024, "local result exceeds bound")
    descriptor, temporary = tempfile.mkstemp(prefix=".plan-result-", dir=parent)
    published = False
    try:
        try:
            os.fchmod(descriptor, 0o600)
            offset = 0
            while offset < len(payload):
                count = os.write(descriptor, payload[offset:])
                require(count > 0, "local result write stalled")
                offset += count
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        # link is atomic and create-only; an existing destination is never replaced.
        os.link(temporary, path, follow_symlinks=False)
        published = True
        os.unlink(temporary)
        directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory_fd)
        finally: os.close(directory_fd)
    except BaseException as error:
        if published:
            raise PublishedResultError("complete local result published; durability or temporary cleanup unconfirmed") from error
        raise
    finally:
        if os.path.lexists(temporary):
            try: os.unlink(temporary)
            except OSError as error:
                if published: raise PublishedResultError("complete local result published; private temporary cleanup failed") from error
                raise Error("result not published; private temporary cleanup failed") from error

def audit_binary_plan(plan, terraform, expected_plan, expected_source, evidence_paths, provider_directory, *, renderer=run_json, now=None):
    require(source_digest() == expected_source, "reviewed source changed")
    require(plan.is_absolute() and terraform.is_absolute() and terraform.resolve() == terraform, "absolute non-symlink tool path required")
    for path in [terraform, *terraform.parents[:-1]]:
        info = path.lstat()
        require(info.st_uid in (0, os.getuid()) and not info.st_mode & 0o022, "unsafe Terraform path ownership or mode")
    require(H.secure_executable_digest(terraform)[0] == TF_SHA256 and os.access(terraform, os.X_OK), "unreviewed Terraform executable")
    digest, size = H.secure_plan_digest(plan)
    require(digest == expected_plan, "reviewed binary plan changed")
    require(set(evidence_paths) == EVIDENCE_KINDS, "six evidence paths required")
    docs, hashes = {}, {}
    for kind, path in evidence_paths.items(): docs[kind], hashes[kind] = private_json(path)
    with tempfile.TemporaryDirectory(prefix="nourishing-plan-home-") as home:
        provider_copy, provider_hashes = prepare_provider(home, provider_directory)
        env = {"HOME": home, "TMPDIR": home, "PATH": "/usr/bin:/bin", "TF_CLI_CONFIG_FILE": "/dev/null",
               "TF_DATA_DIR": home + "/terraform", "CHECKPOINT_DISABLE": "1", "TF_IN_AUTOMATION": "1", "TF_INPUT": "0"}
        version = renderer([str(terraform), "version", "-json"], ROOT, env)
        require(version.get("terraform_version") == "1.5.7" and version.get("platform") == "linux_amd64", "Terraform version/platform mismatch")
        fd = H.open_verified_plan_descriptor(plan, digest)
        try: document = renderer([str(terraform), "show", "-json", "/proc/self/fd/" + str(fd)], ROOT, env, (fd,))
        finally: os.close(fd)
        require(provider_digest(provider_copy, Path(home)) == provider_hashes and provider_digest(provider_directory) == provider_hashes, "provider changed around rendering")
    result = audit_plan(document, docs, hashes, now or datetime.now(timezone.utc))
    require(H.secure_plan_digest(plan) == (digest, size) and source_digest() == expected_source
            and H.secure_executable_digest(terraform)[0] == TF_SHA256, "plan/source/tool changed around rendering")
    for kind, path in evidence_paths.items(): require(private_json(path)[1] == hashes[kind], "original evidence changed")
    return {**result, "plan_sha256": digest, "source_sha256": expected_source, "terraform_sha256": TF_SHA256, "provider_sha256": provider_hashes, "evidence_sha256": hashes}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-digest", action="store_true", help="print current inputs digest for independent review; not acceptance")
    parser.add_argument("--plan", type=Path); parser.add_argument("--plan-sha256")
    parser.add_argument("--provider-directory", type=Path, help="qualified AzureRM 4.79.0 Linux AMD64 package directory")
    parser.add_argument("--terraform", type=Path); parser.add_argument("--source-sha256")
    parser.add_argument("--evidence", action="append", default=[], metavar="KIND=PRIVATE_JSON")
    parser.add_argument("--result", type=Path)
    args = parser.parse_args()
    try:
        if args.source_digest: print(source_digest()); return 0
        require(all((args.plan, args.plan_sha256, args.terraform, args.source_sha256, args.result, args.provider_directory)), "explicit reviewed inputs and private result required")
        paths = {}
        for item in args.evidence:
            kind, path = item.split("=", 1); require(kind not in paths, "duplicate evidence input"); paths[kind] = Path(path).absolute()
        result = audit_binary_plan(args.plan.absolute(), args.terraform.absolute(), args.plan_sha256, args.source_sha256, paths, args.provider_directory.absolute())
        publish_result(args.result.absolute(), result)
    except PublishedResultError:
        parser.exit(2, "Complete local result was published; durability or temporary cleanup is unconfirmed. No provider action occurred.\n")
    except (Error, OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, "Development plan audit rejected; no provider action or new result publication by this invocation. " + type(error).__name__ + "\n")
    print("Local development plan policy passed; no apply/runtime acceptance.")
    return 0

if __name__ == "__main__": raise SystemExit(main())
