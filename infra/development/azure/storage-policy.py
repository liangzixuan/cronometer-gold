#!/usr/bin/env python3
"""Pure resource-policy normalization for retained Azure storage evidence."""
from datetime import datetime, timedelta
import importlib.util
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("storage_auth_helpers", ROOT / "auth-preflight.py")
P = importlib.util.module_from_spec(spec); spec.loader.exec_module(P)
A, require = P.A, P.A.require
encoded = lambda value: (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()

def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys), "exact Azure storage fields required")

NAMES = ("artifact", "erasure", "backup")
VERSION = "2025-06-01"
ACCOUNT_FIELDS = ("supportsHttpsTrafficOnly", "minimumTlsVersion", "allowSharedKeyAccess",
                  "allowBlobPublicAccess", "publicNetworkAccess", "networkAcls", "encryption",
                  "immutableStorageWithVersioning")
SERVICE_FIELDS = ("isVersioningEnabled", "deleteRetentionPolicy", "containerDeleteRetentionPolicy",
                  "restorePolicy", "changeFeed", "automaticSnapshotPolicyEnabled")
CONTAINER_FIELDS = ("publicAccess", "hasLegalHold", "hasImmutabilityPolicy",
                    "immutableStorageWithVersioning", "defaultEncryptionScope", "denyEncryptionScopeOverride",
                    "legalHold", "immutabilityPolicy")

def properties(doc, resource_id):
    require(type(doc) is dict and str(doc.get("id", "")).lower() == resource_id.lower()
            and type(doc.get("properties")) is dict, "exact storage resource identity required")
    return doc["properties"]

def selected(value, fields):
    require(all(k in value for k in fields), "explicit storage policy fields required")
    return {k:value[k] for k in fields}

def boolean(v):
    require(type(v) is bool, "explicit storage policy boolean required")
    return v

def generation(value):
    require(type(value) is str and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+]00:00)", value),
            "explicit UTC account creation timestamp required")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(parsed.tzinfo is not None and parsed.utcoffset() == timedelta(0), "UTC generation required")
    return parsed

def owner_identity(ownership, destination):
    exact(ownership, {"account_id", "container_id", "creation_time", "location", "sku", "policy"})
    url = destination["container_url"]
    account_name = url.split("/")[2].split(".")[0]
    container_name = url.split("/")[3]
    account_id = ownership["account_id"]
    require(type(account_id) is str and re.fullmatch(
        r"/subscriptions/[0-9a-f-]{36}/resourceGroups/[A-Za-z0-9_.()-]{1,90}/providers/Microsoft.Storage/storageAccounts/"
        + re.escape(account_name), account_id), "fixed Azure account ID required")
    require(ownership["container_id"] == account_id + "/blobServices/default/containers/" + container_name,
            "container and account identities differ")
    generation(ownership["creation_time"])
    require(type(ownership["location"]) is str and re.fullmatch(r"[a-z0-9]{1,64}", ownership["location"]),
            "explicit storage location required")
    exact(ownership["sku"], {"name", "tier"})
    require(ownership["sku"]["name"] in ("Standard_LRS", "Standard_ZRS", "Standard_GRS", "Standard_RAGRS",
            "Standard_GZRS", "Standard_RAGZRS") and ownership["sku"]["tier"] == "Standard",
            "explicit standard storage SKU required")
    exact(ownership["policy"], {"account", "service", "container"})
    return account_id, account_name, container_name

def normalize(account, service, container, ownership, destination):
    account_id, account_name, container_name = owner_identity(ownership, destination)
    url = destination["container_url"]
    ap = properties(account, account_id)
    sp = properties(service, account_id + "/blobServices/default")
    cp = properties(container, ownership["container_id"])
    require(account.get("kind") == "StorageV2" and account.get("name") == account_name
            and account.get("location") == ownership["location"]
            and account.get("sku") == ownership["sku"]
            and ap.get("provisioningState") == "Succeeded"
            and generation(ap.get("creationTime")) == generation(ownership["creation_time"])
            and ap.get("primaryEndpoints", {}).get("blob") == url.rsplit("/", 1)[0] + "/",
            "storage account generation or selected profile differs")
    ac, sv, co = selected(ap, ACCOUNT_FIELDS), selected(sp, SERVICE_FIELDS), selected(cp, CONTAINER_FIELDS)
    require(ac["supportsHttpsTrafficOnly"] is True and ac["minimumTlsVersion"] == "TLS1_2"
            and ac["allowSharedKeyAccess"] is False and ac["allowBlobPublicAccess"] is False,
            "explicit TLS and OAuth-only private storage required")
    require(ac["publicNetworkAccess"] in ("Enabled", "Disabled"), "explicit public network policy required")
    network = ac["networkAcls"]
    require(type(network) is dict and network.get("defaultAction") in ("Allow", "Deny")
            and network.get("bypass") in ("None", "Logging", "Metrics", "Logging, Metrics")
            and all(type(network.get(k)) is list for k in ("ipRules", "ipv6Rules", "virtualNetworkRules", "resourceAccessRules")),
            "explicit network rules without AzureServices bypass required")
    encryption = ac["encryption"]
    require(type(encryption) is dict and encryption.get("keySource") == "Microsoft.Storage"
            and encryption.get("services", {}).get("blob", {}).get("enabled") is True
            and co["defaultEncryptionScope"] == "$account-encryption-key"
            and co["denyEncryptionScopeOverride"] is True, "account-managed encryption profile required")
    require(co["publicAccess"] == "None", "private container required")
    for field in ("hasLegalHold", "hasImmutabilityPolicy"):
        boolean(co[field])
    for item in (ac["immutableStorageWithVersioning"], co["immutableStorageWithVersioning"]):
        require(type(item) is dict, "explicit version immutability policy required")
        boolean(item.get("enabled"))
        if item["enabled"] is False:
            require(item.get("immutabilityPolicy") is None, "contradictory disabled immutability")
    boolean(sv["isVersioningEnabled"]);boolean(sv["automaticSnapshotPolicyEnabled"])
    for field in ("deleteRetentionPolicy", "containerDeleteRetentionPolicy", "restorePolicy", "changeFeed"):
        require(type(sv[field]) is dict, "explicit retention object required")
        boolean(sv[field].get("enabled"))
    if not co["hasLegalHold"]:
        require(co["legalHold"] is None or type(co["legalHold"]) is dict
                and co["legalHold"].get("hasLegalHold") is False and co["legalHold"].get("tags") == [],
                "contradictory legal hold")
    else:
        require(type(co["legalHold"]) is dict and co["legalHold"].get("hasLegalHold") is True,
                "missing actual legal hold")
    if not co["hasImmutabilityPolicy"]:
        require(co["immutabilityPolicy"] is None, "contradictory immutability policy")
    else:
        require(type(co["immutabilityPolicy"]) is dict
                and type(co["immutabilityPolicy"].get("properties")) is dict,
                "wire immutability nesting required")
        immutable = co["immutabilityPolicy"]["properties"]
        require(immutable.get("state") == "Locked" and type(immutable.get("immutabilityPeriodSinceCreationInDays")) is int
                and 1 <= immutable["immutabilityPeriodSinceCreationInDays"] <= 146000
                and immutable.get("allowProtectedAppendWrites") is False
                and immutable.get("allowProtectedAppendWritesAll") is False,
                "locked retained policy without append exceptions required")
    if container_name == "nourishing-development-artifact":
        require(sv["isVersioningEnabled"] is False and sv["automaticSnapshotPolicyEnabled"] is False
                and all(sv[k]["enabled"] is False for k in ("deleteRetentionPolicy", "containerDeleteRetentionPolicy", "restorePolicy", "changeFeed"))
                and co["hasLegalHold"] is False and co["hasImmutabilityPolicy"] is False
                and ac["immutableStorageWithVersioning"]["enabled"] is False
                and co["immutableStorageWithVersioning"]["enabled"] is False,
                "export erasure policy retains data")
    else:
        require(sv["isVersioningEnabled"] is True and sv["automaticSnapshotPolicyEnabled"] is False,
                "retained singleton recovery requires versioning without automatic snapshots")
    policy = {"account":ac, "service":sv, "container":co}
    require(policy == ownership["policy"], "observed policy differs from independently bound storage policy")
    require(type(container.get("etag")) is str and 1 <= len(container["etag"]) <= 256,
            "container conservation token required")
    return {"account_id":account_id, "creation_time":ap["creationTime"], "container_id":ownership["container_id"],
            "container_etag":container["etag"], "policy":policy}
