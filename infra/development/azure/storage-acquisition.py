#!/usr/bin/env python3
"""Retained Azure storage transaction stages. Never starts a child or deletes storage."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys

ROOT = Path(__file__).resolve().parent
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
Q = load("storage_prepare_helpers", "prepare-plan-input.py")
V = load("storage_policy_helpers", "storage-policy.py")
S = load("storage_session_helpers", "session-policy.py")
A, P = Q.A, Q.P
require, exact, encoded = A.require, V.exact, V.encoded
STACK = ROOT / "storage"
NAMES = V.NAMES
TF_FILES = ("versions.tf", "variables.tf", "main.tf", ".terraform.lock.hcl")
MAX_JSON = 20 * 1024 * 1024
MAX_STDERR = 65536
MAX_ORDINARY_METADATA = 65536
MAX_DIAGNOSTIC_REFERENCES = 86  # plan 8 + execute 40 + reconcile 38
MAX_DIAGNOSTIC_REFERENCE_BYTES = 512
MAX_DIAGNOSTIC_METADATA = MAX_DIAGNOSTIC_REFERENCES * MAX_DIAGNOSTIC_REFERENCE_BYTES
MAX_BINDING_BYTES = MAX_ORDINARY_METADATA + MAX_DIAGNOSTIC_METADATA
RG = "azurerm_resource_group.storage"
DEPLOYMENT = "azurerm_resource_group_template_deployment.containers"
SCHEMAS = {RG:0, DEPLOYMENT:0, **{"azurerm_storage_account."+n:4 for n in NAMES}}
TAGS = {"environment":"development", "terraform_scope":"retained-storage"}
TIMEOUTS = {"create":"2m", "read":"1m", "update":"2m", "delete":"2m"}
# Declared computed fields in AzureRM v4.79.0, not evidence of live policy.
ACCOUNT_COMPUTED = set("primary_location secondary_location primary_blob_endpoint primary_blob_host primary_blob_internet_endpoint primary_blob_internet_host primary_blob_microsoft_endpoint primary_blob_microsoft_host secondary_blob_endpoint secondary_blob_host secondary_blob_internet_endpoint secondary_blob_internet_host secondary_blob_microsoft_endpoint secondary_blob_microsoft_host primary_queue_endpoint primary_queue_host primary_queue_microsoft_endpoint primary_queue_microsoft_host secondary_queue_endpoint secondary_queue_host secondary_queue_microsoft_endpoint secondary_queue_microsoft_host primary_table_endpoint primary_table_host primary_table_microsoft_endpoint primary_table_microsoft_host secondary_table_endpoint secondary_table_host secondary_table_microsoft_endpoint secondary_table_microsoft_host primary_web_endpoint primary_web_host primary_web_internet_endpoint primary_web_internet_host primary_web_microsoft_endpoint primary_web_microsoft_host secondary_web_endpoint secondary_web_host secondary_web_internet_endpoint secondary_web_internet_host secondary_web_microsoft_endpoint secondary_web_microsoft_host primary_dfs_endpoint primary_dfs_host primary_dfs_internet_endpoint primary_dfs_internet_host primary_dfs_microsoft_endpoint primary_dfs_microsoft_host secondary_dfs_endpoint secondary_dfs_host secondary_dfs_internet_endpoint secondary_dfs_internet_host secondary_dfs_microsoft_endpoint secondary_dfs_microsoft_host primary_file_endpoint primary_file_host primary_file_internet_endpoint primary_file_internet_host primary_file_microsoft_endpoint primary_file_microsoft_host secondary_file_endpoint secondary_file_host secondary_file_internet_endpoint secondary_file_internet_host secondary_file_microsoft_endpoint secondary_file_microsoft_host primary_access_key secondary_access_key primary_connection_string secondary_connection_string primary_blob_connection_string secondary_blob_connection_string id large_file_share_enabled routing share_properties queue_properties static_website".split())
DEPLOYMENT_COMPUTED = {"id", "output_content"}
SENSITIVE = {"primary_access_key","secondary_access_key","primary_connection_string",
             "secondary_connection_string","primary_blob_connection_string","secondary_blob_connection_string"}

def source_digest():
    manifest = STACK / "source-files.json"
    names = A.strict_json(manifest.read_bytes())
    require(type(names) is list and names == sorted(set(names)) and len(names) <= 100,
            "fixed source manifest required")
    entries = []
    for name in names:
        require(type(name) is str and not name.startswith("/") and ".." not in Path(name).parts,
                "source escaped checkout")
        path = A.REPO / name; P.safe_path(path); info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o644
                and info.st_size <= 1024*1024, "bounded public source required")
        entries.append([name,A.sha(path.read_bytes()),stat.S_IMODE(info.st_mode)])
    require("infra/development/azure/storage/source-files.json" in names, "manifest must bind itself")
    require({p.name for p in STACK.iterdir()} == {*TF_FILES,"source-files.json"},
            "implicit storage source inputs rejected")
    return A.sha(json.dumps(entries,separators=(",",":")).encode())

def ref(value):
    exact(value, {"path","sha256"})
    return S.reference(Path(value["path"]), value["sha256"])

def identity(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o700, "private owned directory required")
    return [info.st_dev,info.st_ino]

def config(storage, subscription):
    exact(storage, {"suffix","ipv4_rules","policies"})
    require(type(storage["suffix"]) is str and re.fullmatch(r"[0-9a-f]{12}",storage["suffix"]),
            "fresh storage suffix required")
    ips = storage["ipv4_rules"]
    require(type(ips) is list and 1 <= len(ips) <= 4 and len(set(ips)) == len(ips),
            "one to four explicit public IPv4 addresses required")
    for value in ips:
        require(type(value) is str and str(ipaddress.IPv4Address(value)) == value
                and ipaddress.IPv4Address(value).is_global, "canonical public IPv4 required")
    exact(storage["policies"], NAMES)
    # Independently supplied expected policy is checked against the same consumer.
    values = {"subscription_id":subscription, "suffix":storage["suffix"], "ipv4_rules":ips}
    for n in NAMES:
        own = owner(values,n,"2026-01-01T00:00:00Z",storage["policies"][n])
        ac={"id":own["account_id"],"name":account_name(values,n),"kind":"StorageV2","location":"centralus",
            "sku":own["sku"],"properties":{**own["policy"]["account"],"provisioningState":"Succeeded",
            "creationTime":own["creation_time"],"primaryEndpoints":{"blob":account_url(values,n)+"/"}}}
        se={"id":own["account_id"]+"/blobServices/default","properties":own["policy"]["service"]}
        co={"id":own["container_id"],"etag":"expected-policy","properties":own["policy"]["container"]}
        V.normalize(ac,se,co,own,destination(values,n))
        net=own["policy"]["account"]["networkAcls"]
        require(net == {"defaultAction":"Deny","bypass":"None",
            "ipRules":[{"action":"Allow","value":ip} for ip in ips],
            "ipv6Rules":[],"virtualNetworkRules":[],"resourceAccessRules":[]},
            "expected network policy differs from fixed source")
        require(own["policy"]["account"]["publicNetworkAccess"] == "Enabled"
                and own["policy"]["account"]["immutableStorageWithVersioning"] == {"enabled":False}
                and own["policy"]["container"]["hasLegalHold"] is False
                and own["policy"]["container"]["hasImmutabilityPolicy"] is False
                and own["policy"]["container"]["immutableStorageWithVersioning"] == {"enabled":False},
                "unconfigured retention or network policy")
        require(all(own["policy"]["service"][k] == {"enabled":False} for k in
            ("deleteRetentionPolicy","containerDeleteRetentionPolicy","restorePolicy","changeFeed")),
            "fixed source does not configure retention policies")
    return values

def account_name(values,n):
    return "nourish"+values["suffix"]+{"artifact":"art","erasure":"era","backup":"bak"}[n]
def group_name(values): return "nourishing-storage-"+values["suffix"]
def account_url(values,n): return "https://"+account_name(values,n)+".blob.core.windows.net"
def destination(values,n):
    return {"container_url":account_url(values,n)+"/nourishing-development-"+n}
def resource_ids(values):
    group="/subscriptions/"+values["subscription_id"]+"/resourceGroups/"+group_name(values)
    out={RG:group}
    for n in NAMES:
        aid=group+"/providers/Microsoft.Storage/storageAccounts/"+account_name(values,n)
        out["azurerm_storage_account."+n]=aid
    out[DEPLOYMENT]=group+"/providers/Microsoft.Resources/deployments/"+deployment_name(values)
    return out

def deployment_name(v): return "nourishing-containers-"+v["suffix"]
def container_ids(v):
    ids=resource_ids(v)
    return {n:ids["azurerm_storage_account."+n]+"/blobServices/default/containers/nourishing-development-"+n for n in NAMES}

def container_template(v):
    return {"$schema":"https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
        "contentVersion":"1.0.0.0","parameters":{},"variables":{},"outputs":{},
        "resources":[{"type":"Microsoft.Storage/storageAccounts/blobServices/containers",
            "apiVersion":"2025-06-01","name":account_name(v,n)+"/default/nourishing-development-"+n,
            "properties":{"publicAccess":"None","defaultEncryptionScope":"$account-encryption-key",
                "denyEncryptionScopeOverride":True,"metadata":{}}} for n in NAMES]}
def owner(values,n,generation,policy):
    ids=resource_ids(values)
    return {"account_id":ids["azurerm_storage_account."+n],"container_id":container_ids(values)[n],
        "creation_time":generation,"location":"centralus","sku":{"name":"Standard_LRS","tier":"Standard"},"policy":policy}

def expected_values(v, resolved=False):
    ids=resource_ids(v)
    out={RG:{"name":group_name(v),"location":"centralus","tags":TAGS,"timeouts":TIMEOUTS}}
    for n in NAMES:
        a="azurerm_storage_account."+n
        out[a]={"name":account_name(v,n),"resource_group_name":group_name(v),"location":"centralus",
            "account_kind":"StorageV2","account_tier":"Standard","account_replication_type":"LRS",
            "access_tier":"Hot","https_traffic_only_enabled":True,"min_tls_version":"TLS1_2",
            "shared_access_key_enabled":False,"allow_nested_items_to_be_public":False,
            "default_to_oauth_authentication":True,"public_network_access_enabled":True,
            "infrastructure_encryption_enabled":True,"is_hns_enabled":False,"nfsv3_enabled":False,
            "sftp_enabled":False,"local_user_enabled":False,"cross_tenant_replication_enabled":False,
            "dns_endpoint_type":"Standard","queue_encryption_key_type":"Service","table_encryption_key_type":"Service","network_rules":[{"default_action":"Deny","bypass":["None"],
                "ip_rules":v["ipv4_rules"],"virtual_network_subnet_ids":[],"private_link_access":[]}],
            "blob_properties":[{"versioning_enabled":n!="artifact"}],"tags":TAGS,"timeouts":TIMEOUTS}
    out[DEPLOYMENT]={"name":deployment_name(v),"resource_group_name":group_name(v),
        "deployment_mode":"Incremental","template_content":json.dumps(container_template(v),separators=(",",":")),
        "parameters_content":"{}","tags":TAGS,"timeouts":TIMEOUTS}
    if resolved:out[DEPLOYMENT]["output_content"]="{}"
    if resolved:
        for address,item in out.items(): item["id"]=ids[address]
    return out

def equivalent(actual, expected, label):
    if isinstance(expected,dict):
        require(type(actual) is dict, label+" must be an object")
        for k,v in expected.items():
            require(k in actual or v is None, label+" missing field")
            equivalent(actual.get(k),v,label+"."+k)
        for k in set(actual)-set(expected):
            require(A.H._neutral(actual[k]),label+" unqualified field")
    elif isinstance(expected,list):
        require(type(actual) is list and len(actual)==len(expected),label+" list differs")
        if label.endswith((".ip_rules",".bypass",".virtual_network_subnet_ids")):
            require(sorted(actual)==sorted(expected),label+" set differs")
        else:
            for a,e in zip(actual,expected):equivalent(a,e,label+"[]")
    else:
        require(actual==expected and (type(actual) is bool)==(type(expected) is bool),label+" differs")

def known_values(address, actual, wanted, resolved=False):
    require(type(actual) is dict,"resource values missing")
    checked=json.loads(json.dumps(actual))
    computed=ACCOUNT_COMPUTED if address.startswith("azurerm_storage_account.") else DEPLOYMENT_COMPUTED if address==DEPLOYMENT else {"id"}
    for key in computed:
        if key in wanted: continue
        value=checked.pop(key,None)
        if resolved:
            require(value is None or type(value) in (str,bool,dict,list), "computed shape differs")
        else:
            require(A.H._neutral(value),"computed plan field unexpectedly known")
    if address.startswith("azurerm_storage_account."):
        # These two Optional+Computed leaves are unset by the fixed HCL.
        for block,field in (("network_rules","virtual_network_subnet_ids"),
                            ("blob_properties","default_service_version")):
            rows=checked.get(block)
            if type(rows) is list and len(rows)==1 and type(rows[0]) is dict:
                value=rows[0].pop(field,None)
                if field=="virtual_network_subnet_ids":
                    require(value is None or value==[], "unconfigured subnet membership")
                else:
                    require(value is None or type(value) is str and (resolved or value==""),
                            "unqualified computed service version")
        wanted=json.loads(json.dumps(wanted))
        wanted["network_rules"][0].pop("virtual_network_subnet_ids",None)
    if address==DEPLOYMENT:
        wanted=json.loads(json.dumps(wanted))
        for key in ("template_content","parameters_content",*( ("output_content",) if resolved else () )):
            require(type(checked.get(key)) is str and len(checked[key].encode())<=65536,"known bounded deployment JSON required")
            actual_json=A.strict_json(checked[key].encode());expected_json=A.strict_json(wanted[key].encode())
            require(encoded(actual_json)==encoded(expected_json),"exact deployment JSON differs")
            checked[key]=expected_json;wanted[key]=expected_json
    equivalent(checked,wanted,address)

def audit_plan(doc,v):
    require(doc.get("format_version")=="1.2" and doc.get("terraform_version")=="1.5.7","qualified plan version")
    require(not set(doc)&{"applyable","complete","errored"} and not doc.get("resource_drift")
            and not doc.get("deferred_changes"),"unsupported plan metadata")
    require(doc.get("variables")=={k:{"value":x} for k,x in v.items()},"plan variables changed")
    prior=doc.get("prior_state")
    require(prior in (None,{}) or prior=={"format_version":"1.0","terraform_version":"1.5.7",
            "values":{"root_module":{}}}, "empty prior state required")
    conf=doc.get("configuration");require(type(conf) is dict,"configuration required")
    provider=conf.get("provider_config");exact(provider,{"azurerm"})
    expected_provider={"name":"azurerm","full_name":A.PROVIDER,"version_constraint":"4.79.0",
        "expressions":{"subscription_id":{"references":["var.subscription_id"]},
        "resource_provider_registrations":{"constant_value":"none"},
        "features":[{"skip_import_check_on_create_and_allow_overwriting_existing_resources":{"constant_value":False},
            "resource_group":[{"prevent_deletion_if_contains_resources":{"constant_value":True}}],
            "storage":[{"data_plane_available":{"constant_value":False}}],
            "template_deployment":[{"delete_nested_items_during_deletion":{"constant_value":False}}]}]}}
    require(provider["azurerm"]==expected_provider,"provider configuration differs")
    root=conf.get("root_module",{});require(not root.get("module_calls"),"nested module rejected")
    configured=A.unique(root.get("resources"),"address","configured resources")
    changes=A.unique(doc.get("resource_changes"),"address","changes")
    planned=doc.get("planned_values",{});require(not planned.get("outputs"),"outputs not admitted")
    pr=planned.get("root_module",{});require(not pr.get("child_modules"),"nested planned module rejected")
    planned_resources=A.unique(pr.get("resources"),"address","planned resources")
    require(set(configured)==set(changes)==set(planned_resources)==set(SCHEMAS),"exact five Terraform resource graph")
    wanted=expected_values(v)
    for address,entry in changes.items():
        typ,name=address.split("."); c=configured[address]; p=planned_resources[address]
        require(c.get("mode")==p.get("mode")==entry.get("mode")=="managed"
                and c.get("type")==p.get("type")==entry.get("type")==typ
                and c.get("name")==p.get("name")==entry.get("name")==name
                and c.get("provider_config_key")=="azurerm"
                and p.get("provider_name")==entry.get("provider_name")==A.PROVIDER
                and type(c.get("schema_version")) is int and c["schema_version"]==SCHEMAS[address]
                and p.get("schema_version")==SCHEMAS[address],"resource identity differs")
        require(not any(c.get(k) for k in ("count_expression","for_each_expression","provisioners","connection"))
                and type(c.get("expressions")) is dict,"dynamic/executable configuration rejected")
        require(set(entry)<={"address","mode","type","name","provider_name","change"},"unreviewed lifecycle")
        change=entry["change"]
        require(set(change)<={"actions","before","after","after_unknown","before_sensitive","after_sensitive","replace_paths","importing"}
                and change.get("actions")==["create"] and change.get("before") is None
                and change.get("replace_paths") in (None,[]) and change.get("importing") is None,"only creates admitted")
        unknown=A.unknown_paths(change.get("after_unknown"))
        computed=ACCOUNT_COMPUTED if typ=="azurerm_storage_account" else DEPLOYMENT_COMPUTED if address==DEPLOYMENT else {"id"}
        allowed=computed
        nested={("network_rules",0,"virtual_network_subnet_ids"),("blob_properties",0,"default_service_version")} if typ=="azurerm_storage_account" else set()
        require({("id",)} <= unknown and all((len(k)==1 and k[0] in allowed) or k in nested for k in unknown),
                "unqualified unknown fields")
        if address==DEPLOYMENT:
            accounts={"azurerm_storage_account."+n for n in NAMES}
            require(type(c.get("depends_on")) is list and len(c["depends_on"])==3
                    and set(c["depends_on"])==accounts,"exact three account dependencies required")
            A.H._require_reference(configured,address,("resource_group_name",),RG+".name")
            refs=c["expressions"].get("template_content",{}).get("references")
            require(type(refs) is list and len(refs)==6
                    and set(refs)==accounts|{a+".name" for a in accounts},"exact known template account references required")
        if typ=="azurerm_storage_account":
            A.H._require_reference(configured,address,("resource_group_name",),RG+".name")
        known_values(address,change["after"],wanted[address])
        known_values(address,p.get("values"),wanted[address])
        require(not A.H._flatten_mask(change.get("before_sensitive"),"before sensitivity"),"prior sensitivity")
        sensitive=A.H._flatten_mask(change.get("after_sensitive"),"sensitivity")
        require(all(len(k)==1 and k[0] in SENSITIVE for k in sensitive)
                and (typ=="azurerm_storage_account" or not sensitive),"unqualified sensitive fields")
    require(doc.get("checks") in (None,[]),"unexpected checks")
    return {"resource_count":5,"azure_object_count":8,"planned_ids":resource_ids(v),"container_ids":container_ids(v)}

def raw_and_rendered(raw, rendered, v, partial=False):
    require(raw.get("version")==4 and raw.get("terraform_version")=="1.5.7"
            and type(raw.get("serial")) is int and raw["serial"]>=0
            and type(raw.get("lineage")) is str and re.fullmatch(S.UUID,raw["lineage"]),
            "state lineage/serial/version required")
    require(rendered.get("format_version")=="1.0" and rendered.get("terraform_version")=="1.5.7",
            "qualified state renderer required")
    require(not raw.get("outputs") and not rendered.get("values",{}).get("outputs"),"state outputs rejected")
    root=rendered.get("values",{}).get("root_module",{});require(not root.get("child_modules"),"nested state")
    resources=A.unique(root.get("resources"),"address","rendered state")
    rr=raw.get("resources");require(type(rr) is list,"raw resources missing")
    rawmap={r.get("type","")+"."+r.get("name",""):r for r in rr}
    require(len(rawmap)==len(rr) and set(rawmap)==set(resources) and set(resources)<=set(SCHEMAS),
            "raw/rendered graph differs")
    require(partial or set(resources)==set(SCHEMAS),"complete five-resource Terraform state required")
    expected=expected_values(v,True)
    for address,item in resources.items():
        typ,name=address.split(".");r=rawmap[address];instances=r.get("instances")
        require(item.get("mode")==r.get("mode")=="managed" and item.get("provider_name")==A.PROVIDER
                and r.get("provider")=='provider["'+A.PROVIDER+'"]' and not r.get("module")
                and item.get("type")==typ and item.get("name")==name
                and type(item.get("schema_version")) is int and item["schema_version"]==SCHEMAS[address]
                and type(instances) is list and len(instances)==1,"state identity differs")
        one=instances[0]
        require(one.get("status") is None and one.get("deposed") is None and "index_key" not in one
                and type(one.get("schema_version")) is int and one["schema_version"]==SCHEMAS[address]
                and encoded(one.get("attributes"))==encoded(item.get("values")),"ambiguous/different state instance")
        known_values(address,item["values"],expected[address],True)
    return resources

def load_request(mode,path,now):
    request,digest=S.private(path)
    common={"schema_version","source_sha256","operation_name","not_after_utc"}
    exact(request,common|({"identity_file","profile_directory","terraform","provider_directory","storage"} if mode=="plan"
        else {"plan_request","plan_result","origin"}))
    require(type(request["schema_version"]) is int and request["schema_version"]==1
            and request["source_sha256"]==source_digest(),"reviewed acquisition source required")
    require(re.fullmatch("nourishing-storage-"+mode+r"-[0-9a-f]{12}",request["operation_name"]),
            "new fixed operation name")
    end=A.utc(request["not_after_utc"],"action deadline")
    require(now<end<=now+timedelta(hours=4),"fresh bounded action deadline")
    if mode=="plan":
        expected,identity_hash=P.identity(Path(request["identity_file"]))
        profile=P.profile_digest(Path(request["profile_directory"]))
        v=config(request["storage"],expected["subscriptionId"])
        require(A.H.secure_executable_digest(Path(request["terraform"]))[0]==A.TF_SHA256,"qualified Terraform")
        provider=A.provider_digest(Path(request["provider_directory"]));P.tool_digest(Path("/usr/bin/az"))
        snapshot={"source":request["source_sha256"],"request":digest,"identity":identity_hash,
                  "profile":profile,"provider":provider,"terraform":A.TF_SHA256,"azure":P.CLI_SHA256}
        return request,expected,v,snapshot,None
    require(mode in ("execute","reconcile"),"fixed mode")
    original_request=ref(request["plan_request"]);result=ref(request["plan_result"])
    recorded=A.receipt_utc(result.get("completed_at_utc"),"plan completion")
    plan_path=Path(request["plan_request"]["path"])
    plan,expected,v,snapshot,_=load_request("plan",plan_path,recorded)
    directory=plan_path.parent/plan["operation_name"]
    require(Path(request["plan_result"]["path"])==directory/"result.json"
            and result.get("kind")=="nutrition-azure-storage-plan-v1" and result.get("completed") is True
            and result.get("snapshot")==snapshot and result.get("resource_count")==5
            and result.get("azure_object_count")==8 and result.get("planned_ids")==resource_ids(v)
            and result.get("container_ids")==container_ids(v)
            and result.get("plan_request_path")==str(plan_path)
            and result.get("plan_directory_identity")==identity(directory),"original plan binding differs")
    require(original_request==plan,"plan request changed")
    binary=directory/"plan.tfplan";bh,bs=A.H.secure_plan_digest(binary)
    require(bh==result.get("binary_plan_sha256") and bs==result.get("binary_plan_bytes"),"original saved plan changed")
    rendered,_=S.private(directory/"rendered.json");audit_plan(rendered,v)
    require(A.sha(S.private_bytes(directory/"rendered.json"))==result.get("rendered_sha256"),"original rendering changed")
    # Original request's finite window admits execute, but never bounds future retained storage lifetime.
    if mode=="execute":require(now<A.utc(plan["not_after_utc"],"plan action expiry") and request["origin"] is None,
                               "original plan action expired")
    original={"request":plan,"directory":str(directory),"binary":str(binary),"result":result,
              "request_reference":request["plan_request"],"result_reference":request["plan_result"]}
    if mode=="reconcile":
        origin=request["origin"];exact(origin,{"request","directory","session_sha256","intent_sha256","state_sha256"})
        action=ref(origin["request"]);intent=S.reference(Path(origin["directory"])/"mutation-intent.json",origin["intent_sha256"])
        when=A.receipt_utc(intent.get("created_at_utc"),"intent time")
        old,_,oldv,oldsnap,_=load_request("execute",Path(origin["request"]["path"]),when)
        require(now>A.utc(old["not_after_utc"],"original action expiry") and oldv==v
                and old["plan_request"]==request["plan_request"] and old["plan_result"]==request["plan_result"],
                "original execution must be expired and bound to this plan")
        olddir=Path(origin["directory"])
        require(olddir==Path(origin["request"]["path"]).parent/old["operation_name"],"original execution directory differs")
        state=S.reference(olddir/"session.json",origin["session_sha256"])
        settled,_=S.private(olddir/"local-settlement.json")
        require(settled=={"kind":"nutrition-storage-local-settlement-v1","session_sha256":origin["session_sha256"],
                         "request_sha256":oldsnap["request"],"local_process_settled":True},
                "original supervised processes have not been verified settled")
        require(state["snapshot"]==oldsnap and state["directory_identity"]==identity(olddir)
                and intent.get("session_sha256")==origin["session_sha256"]
                and intent.get("snapshot")==oldsnap and intent.get("binary_plan_sha256")==bh,
                "original intent/session differs")
        claim,_=S.private(directory/"execution-claim.json")
        require(claim=={"directory":str(olddir),"request_sha256":oldsnap["request"],
                        "session_sha256":origin["session_sha256"]},"original apply claim differs")
        require(not os.path.lexists(olddir/"work/errored.tfstate"),"emergency state requires separate recovery")
        statebytes=S.private_bytes(olddir/"work/terraform.tfstate")
        require(A.sha(statebytes)==origin["state_sha256"],"retained original state changed")
        original["origin"]={"directory":str(olddir),"directory_identity":identity(olddir),
            "state_sha256":origin["state_sha256"],"state_path":str(olddir/"work/terraform.tfstate"),
            "intent":intent,"session_sha256":origin["session_sha256"]}
    return request,expected,v,{"source":request["source_sha256"],"request":digest,"original":snapshot,
             "plan_result":request["plan_result"]["sha256"],"origin":request["origin"]},original

def write(path,value): A.publish_result(path,value)

def copy_file(source,target,maximum=Q.MAX_FILE):
    P.safe_path(source);before=source.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_size<=maximum,"bounded regular source")
    fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        fields=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns,x.st_mode,x.st_uid,x.st_nlink)
        require(fields(os.fstat(fd))==fields(before)==fields(source.stat()),"source replaced")
        out=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            while block:=os.read(fd,1024*1024):
                offset=0
                while offset<len(block):
                    count=os.write(out,block[offset:]);require(count>0,"copy stalled");offset+=count
            os.fsync(out)
        finally:os.close(out)
        require(fields(source.stat())==fields(before)==fields(os.fstat(fd)),"source changed during copy")
    finally:os.close(fd)

def prepare(mode,path,now):
    request,expected,v,snapshot,original=load_request(mode,path,now)
    directory=path.parent/request["operation_name"];directory.mkdir(mode=0o700)
    for name in ("work","home","tmp","data"): (directory/name).mkdir(mode=0o700)
    source_request=request if mode=="plan" else original["request"]
    mirror,_=A.prepare_provider(directory,Path(source_request["provider_directory"]))
    for parent in [mirror,*mirror.parents]:
        if parent==directory:break
        parent.chmod(0o700)
    for n in TF_FILES:copy_file(STACK/n,directory/"work"/n)
    Q.write_json(directory/"work/inputs.tfvars.json",v)
    rc='provider_installation {\n filesystem_mirror {\n path = '+json.dumps(str(directory/"terraform/providers"))+'\n include = ["registry.terraform.io/hashicorp/azurerm"]\n }\n}\n'
    fd=os.open(directory/"terraform.rc",os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,"w") as out:out.write(rc);out.flush();os.fsync(out.fileno())
    if original:
        copy_file(Path(original["binary"]),directory/"plan.tfplan")
        if mode=="reconcile":copy_file(Path(original["origin"]["state_path"]),directory/"work/terraform.tfstate")
    baseline=Q.tree(directory)
    state={"created_at_utc":now.isoformat(),"mode":mode,"request":str(path),"snapshot":snapshot,"values":v,"original":original,
        "directory_identity":identity(directory),"baseline":baseline,"mirror":str(mirror)}
    Q.write_json(directory/"session.json",state)
    digest=A.sha((directory/"session.json").read_bytes())
    require(load_request(mode,path,now)[3]==snapshot,"input changed during preparation")
    return {"directory":str(directory),"state_sha256":digest,"terraform":{"path":source_request["terraform"],"sha256":A.TF_SHA256},
        "azure":{"path":"/usr/bin/az","sha256":P.CLI_SHA256},"auth_commands":P.commands(expected),
        "profile_directory":source_request["profile_directory"],"subscription_id":expected["subscriptionId"],
        "tenant_id":expected["tenantId"],"group_name":group_name(v)}

def storage_tree(directory,mode,v):
    """Keep the shared ordinary-entry/aggregate limits; allow only fixed stderr names separately."""
    diagnostics={name+".stderr" for name in phase_labels(mode,v)}
    entries={};pending=[directory];ordinary=0;total=0
    while pending:
        current=pending.pop()
        for path in current.iterdir():
            name=str(path.relative_to(directory));info=path.lstat()
            require(info.st_uid==os.getuid(),"session ownership changed")
            if name in diagnostics:
                raw=private_diagnostic(path);total+=len(raw)
                entries[name]={"type":"file","mode":0o600,"size":len(raw),"sha256":A.sha(raw)}
            else:
                ordinary+=1;require(ordinary<=96,"session entry count exceeds bound")
                if stat.S_ISDIR(info.st_mode):
                    require(stat.S_IMODE(info.st_mode)==0o700,"private session directory required")
                    entries[name]={"type":"directory"};pending.append(path)
                elif stat.S_ISLNK(info.st_mode):entries[name]={"type":"link","target":os.readlink(path)}
                else:
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size<=Q.MAX_FILE,
                            "unsafe or oversized session file")
                    total+=info.st_size
                    require(total<=Q.MAX_AGGREGATE,"aggregate session size exceeds bound")
                    import hashlib
                    digest=hashlib.sha256()
                    with path.open("rb") as source:
                        for block in iter(lambda:source.read(1024*1024),b""):digest.update(block)
                    entries[name]={"type":"file","mode":stat.S_IMODE(info.st_mode),"size":info.st_size,"sha256":digest.hexdigest()}
            require(total<=Q.MAX_AGGREGATE,"aggregate session size exceeds bound")
    return entries

def verify(mode,path,directory,digest,now,expected_claim=None):
    state=S.reference(directory/"session.json",digest)
    request,expected,v,snapshot,original=load_request(mode,path,now)
    require(directory==path.parent/request["operation_name"] and state["request"]==str(path)
            and state["mode"]==mode and state["snapshot"]==snapshot and state["values"]==v
            and state["original"]==original and identity(directory)==state["directory_identity"],"session changed")
    current=storage_tree(directory,mode,v)
    for name,value in state["baseline"].items():
        require(current.get(name)==value,"fixed transaction input changed")
    link="data/providers/registry.terraform.io/hashicorp/azurerm/4.79.0/linux_amd64"
    parents={str(p) for p in Path(link).parents if str(p)!="."}
    outputs={"session.json","plan.tfplan","rendered.json","version.json","init.stdout","plan.stdout","apply.stdout",
             "state.json","phases.json","result.json","mutation-intent.json","group-absent.json","local-settlement.json","first-group.json","second-group.json",
             "work/terraform.tfstate","work/terraform.tfstate.backup",
             *{"auth-"+n+".json" for n,_ in P.commands(expected)},
             *{prefix+"-"+row["label"]+".json" for prefix in ("first","second") for row in resource_read_arguments(v)},
             *{n+"-ownership.json" for n in NAMES}}
    if expected_claim is not None:
        require(mode=="plan" and S.private(directory/"execution-claim.json")[0]==expected_claim,
                "historical single-use claim differs")
        current.pop("execution-claim.json")
    diagnostics={name+".stderr" for name in phase_labels(mode,v)}
    outputs |= diagnostics
    for name in set(current)-set(state["baseline"]):
        row=current[name]
        if name==link:require(row=={"type":"link","target":state["mirror"]},"provider link changed")
        elif name in parents:require(row=={"type":"directory"},"provider directory changed")
        else:require(name in outputs and row["type"]=="file" and row["mode"]==0o600
                     and row["size"] <= (Q.MAX_FILE if name=="plan.tfplan" else MAX_STDERR if name in diagnostics else MAX_JSON),"unexpected private output")
    return state,request,expected,v

def authenticate(mode,path,directory,digest,now,expected_claim=None):
    _,_,expected,_=verify(mode,path,directory,digest,now,expected_claim)
    for n,_ in P.commands(expected): P.validate_response(n,S.private(directory/("auth-"+n+".json"))[0],expected)
    version,_=S.private(directory/"version.json")
    require(version.get("terraform_version")=="1.5.7" and version.get("platform")=="linux_amd64","Terraform version differs")

def plan_finish(mode,path,directory,digest,now,publish=True,expected_claim=None):
    state,request,expected,v=verify(mode,path,directory,digest,now,expected_claim);authenticate(mode,path,directory,digest,now,expected_claim)
    require(mode=="plan","plan mode required")
    doc,rh=S.private(directory/"rendered.json");summary=audit_plan(doc,v)
    bh,bs=A.H.secure_plan_digest(directory/"plan.tfplan")
    phases=validate_phases(directory,mode,expected,now)
    result={"kind":"nutrition-azure-storage-plan-v1","completed":True,"completed_at_utc":now.isoformat(),
        "source_sha256":source_digest(),"snapshot":state["snapshot"],"binary_plan_sha256":bh,
        "plan_request_path":str(path),"plan_directory_identity":state["directory_identity"],
        "binary_plan_bytes":bs,"rendered_sha256":rh,"phases_sha256":A.sha(encoded(phases)),**summary,
        "operationalAcceptance":False}
    if not publish:return result
    write(directory/"result.json",result)
    return {"completed":True,"result_sha256":A.sha((directory/"result.json").read_bytes())}

def intent(mode,path,directory,digest,now):
    state,request,_,v=verify(mode,path,directory,digest,now);authenticate(mode,path,directory,digest,now)
    require(mode=="execute","only execute may mutate")
    doc,_=S.private(directory/"rendered.json");audit_plan(doc,v)
    require(S.private(directory/"group-absent.json")[0] is False,"new retained group must be absent")
    original=state["original"]
    bh,_=A.H.secure_plan_digest(directory/"plan.tfplan")
    require(bh==original["result"]["binary_plan_sha256"],"saved plan changed")
    # One shared create-only claim prevents alternate requests from applying the same plan again.
    write(Path(original["directory"])/"execution-claim.json",
          {"directory":str(directory),"request_sha256":state["snapshot"]["request"],"session_sha256":digest})
    result={"kind":"nutrition-azure-storage-intent-v1","created_at_utc":now.isoformat(),
        "not_after_utc":request["not_after_utc"],"session_sha256":digest,"snapshot":state["snapshot"],
        "binary_plan_sha256":bh,"planned_ids":resource_ids(v),"container_ids":container_ids(v),"remote_outcome":"unknown"}
    write(directory/"mutation-intent.json",result)
    return {"intent_sha256":A.sha((directory/"mutation-intent.json").read_bytes())}

def read_commands(mode,path,directory,digest,now):
    _,_,_,v=verify(mode,path,directory,digest,now)
    return resource_read_arguments(v)

def resource_read_arguments(v):
    ids=resource_ids(v)
    def read(label,rid,version):
        return {"label":label,"arguments":["rest","--method","get","--url",
            "https://management.azure.com"+rid+"?api-version="+version,"--only-show-errors","--output","json"]}
    rows=[{"label":"group","arguments":["group","show","--name",group_name(v),"--subscription",v["subscription_id"],"--only-show-errors","--output","json"]},
          read("members",ids[RG]+"/resources","2021-04-01"),
          read("deployment",ids[DEPLOYMENT],"2020-06-01")]
    for n in NAMES:
        aid=ids["azurerm_storage_account."+n]
        for kind,rid in (("account",aid),("service",aid+"/blobServices/default"),("container",container_ids(v)[n]),
                         ("containers",aid+"/blobServices/default/containers")):
            rows.append(read(n+"-"+kind,rid,"2025-08-01" if kind=="containers" else V.VERSION))
    return rows

def collection_members(document, expected):
    """Validate a terminal ARM collection; retain raw bodies separately in phase evidence."""
    require(type(document) is dict and set(document) <= {"value","nextLink"}
            and type(document.get("value")) is list
            and document.get("nextLink") in (None,""), "complete bounded ARM collection required")
    require(len(document["value"]) == len(expected), "unexpected ARM membership count")
    found={}
    for row in document["value"]:
        require(type(row) is dict and all(type(row.get(k)) is str for k in ("id","type")),
                "malformed ARM member")
        rid=row["id"].lower()
        require(rid in expected and rid not in found, "foreign or duplicate ARM member")
        kind=expected[rid]
        require(row["type"].lower()==kind.lower(),
                "ARM member identity differs")
        require(type(row.get("properties",{})) is dict and ("deleted" not in row.get("properties",{}) or row["properties"]["deleted"] is False), "deleted ARM member")
        found[rid]={"id":rid,"type":kind.lower()}
    return [found[rid] for rid in sorted(found)]

def deployment_observation(document,v):
    require(type(document) is dict and document.get("nextLink") in (None,""),"complete deployment record required")
    require(type(document.get("id")) is str and document["id"].lower()==resource_ids(v)[DEPLOYMENT].lower()
            and document.get("name")==deployment_name(v)
            and str(document.get("type","")).lower()=="microsoft.resources/deployments"
            and document.get("tags")==TAGS,"deployment identity differs")
    props=document.get("properties")
    require(type(props) is dict and props.get("provisioningState")=="Succeeded"
            and props.get("mode")=="Incremental" and props.get("nextLink") in (None,"")
            and props.get("error") is None and props.get("templateLink") is None
            and props.get("onErrorDeployment") is None,"completed inline Incremental deployment required")
    require(props.get("parameters") in (None,{}) and props.get("outputs") in (None,{}),"unexpected deployment parameters or outputs")
    targets=props.get("outputResources");require(type(targets) is list and len(targets)==3,"three deployment targets required")
    ids=[]
    for target in targets:
        exact(target,{"id"});require(type(target["id"]) is str,"malformed deployment target")
        ids.append(target["id"].lower())
    require(len(set(ids))==3 and set(ids)=={x.lower() for x in container_ids(v).values()},"deployment targets differ")
    return {"id":document["id"].lower(),"name":document["name"],"type":"microsoft.resources/deployments",
            "mode":"Incremental","provisioningState":"Succeeded","outputResources":sorted(ids)}

def observations(directory,prefix,v,storage,intent,now):
    out={}
    group=S.private(directory/(prefix+"-group.json"))[0]
    require(str(group.get("id","")).lower()==resource_ids(v)[RG].lower() and group.get("name")==group_name(v)
            and group.get("location")=="centralus" and group.get("tags")==TAGS
            and group.get("managedBy") in (None,"") and group.get("properties",{}).get("provisioningState")=="Succeeded",
            "retained resource group readback differs")
    out["group"]={"id":group["id"],"location":group["location"],"tags":group["tags"]}
    ids=resource_ids(v)
    expected={ids["azurerm_storage_account."+n].lower():"Microsoft.Storage/storageAccounts" for n in NAMES}
    out["members"]=collection_members(S.private(directory/(prefix+"-members.json"))[0],expected)
    out["deployment"]=deployment_observation(S.private(directory/(prefix+"-deployment.json"))[0],v)
    start=A.receipt_utc(intent["created_at_utc"],"intent")
    end=A.utc(intent["not_after_utc"],"original action deadline")
    for n in NAMES:
        docs=[S.private(directory/(prefix+"-"+n+"-"+kind+".json"))[0] for kind in ("account","service","container")]
        created=docs[0].get("properties",{}).get("creationTime")
        require(start<=V.generation(created)<=min(now,end),"account generation outside original creation action")
        own=owner(v,n,created,storage["policies"][n])
        observed=V.normalize(*docs,own,destination(v,n))
        require(docs[0].get("tags")==TAGS,"live account tags differ")
        members=collection_members(S.private(directory/(prefix+"-"+n+"-containers.json"))[0],
            {own["container_id"].lower():"Microsoft.Storage/storageAccounts/blobServices/containers"})
        out[n]={"owner":own,"observation":observed,"containers":members}
    return out

def phase_labels(mode,v):
    labels=["auth-"+n for n in ("version","extensions","account","subscription")]+["version","init","show"]
    if mode=="plan":labels=labels[:-1]+["plan","show"]
    else:
        if mode=="execute": labels+=["group-absent","apply","state"]
        else:labels+=["state"]
        labels += [prefix+"-"+row["label"] for prefix in ("first","second") for row in resource_read_arguments(v)]
    return labels

def private_diagnostic(path):
    # stderr can be empty; the shared non-JSON reader intentionally requires nonempty files.
    P.safe_path(path);A.H._require_private_directory(path.parent,"phase diagnostic")
    before=path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_uid==os.getuid()
        and stat.S_IMODE(before.st_mode)==0o600 and before.st_nlink==1
        and 0<=before.st_size<=MAX_STDERR,"invalid private phase diagnostic")
    identity=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        require(identity(os.fstat(fd))==identity(before),"diagnostic replaced while opening")
        raw=os.read(fd,MAX_STDERR+1)
        require(len(raw)==before.st_size and identity(os.fstat(fd))==identity(before)
            and identity(path.lstat())==identity(before),"diagnostic changed during read")
        return raw
    finally:os.close(fd)

def validate_phases(directory,mode,expected,now):
    phases,_=S.private(directory/"phases.json")
    state,_=S.private(directory/"session.json");v=state["values"]
    labels=phase_labels(mode,v)
    require(type(phases) is list and [p.get("phase") for p in phases]==labels
            and all(p.get("completed") is True and type(p.get("exitCode")) is int and p["exitCode"]==0 for p in phases),
            "exact completed action phases required")
    auth={"auth-"+n:args+["--only-show-errors","--output","json"] for n,args in P.commands(expected)}
    reads={prefix+"-"+row["label"]:row["arguments"] for prefix in ("first","second") for row in resource_read_arguments(v)}
    fixed={"version":["version","-json"],
        "init":["init","-backend=false","-lockfile=readonly","-input=false","-no-color"],
        "plan":["plan","-input=false","-no-color","-lock-timeout=0s","-parallelism=1",
                "-var-file=inputs.tfvars.json","-out="+str(directory/"plan.tfplan")],
        "group-absent":["group","exists","--name",group_name(v),"--subscription",v["subscription_id"],
                        "--only-show-errors","--output","json"],**auth,**reads}
    previous=A.receipt_utc(state["created_at_utc"],"session start")
    show=None
    for phase in phases:
        name=phase["phase"];args=phase.get("arguments")
        fields={"phase","completed","exitCode","startedAt","endedAt","sourceSha256","requestSha256",
            "executableSha256","arguments","argumentsSha256","executionReturned","cleanup","failure",
            "stdoutBytes","stdoutSha256","stderrBytes","stderrSha256","stderrComplete","stderrPublished","stderrCaptureOverflow"}
        exact(phase,fields|({"binaryPlanSha256"} if name in ("show","apply") else set()))
        require(phase["sourceSha256"]==state["snapshot"]["source"] and phase["requestSha256"]==state["snapshot"]["request"]
            and phase["executionReturned"] is True and phase["cleanup"]=="settled" and phase["failure"] is None
            and phase["stderrComplete"] is True and phase["stderrPublished"] is True and phase["stderrCaptureOverflow"] is False,
            "phase success evidence incomplete")
        diagnostic=private_diagnostic(directory/(name+".stderr"))
        require(type(phase["stderrBytes"]) is int and 0<=phase["stderrBytes"]==len(diagnostic)<=MAX_STDERR
            and phase["stderrSha256"]==A.sha(diagnostic),"raw phase diagnostics differ")
        start=A.receipt_utc(phase["startedAt"],"phase start");end=A.receipt_utc(phase["endedAt"],"phase end")
        require(previous<=start<=end<=now,"phase time changed");previous=end
        require(type(args) is list and A.sha(json.dumps(args,separators=(",",":"),ensure_ascii=False).encode())==phase["argumentsSha256"],
                "phase arguments differ")
        is_azure=name in auth or name in reads or name=="group-absent"
        require(phase.get("executableSha256")== (P.CLI_SHA256 if is_azure else A.TF_SHA256),
                "phase executable differs")
        if name in ("show","state"):
            require(len(args)==3 and args[:2]==["show","-json"] and type(args[2]) is str
                    and re.fullmatch(r"/proc/[1-9][0-9]*/fd/[0-9]+",args[2]),"held descriptor renderer required")
            if name=="show":
                show=args[2]
                require(phase.get("binaryPlanSha256")==A.H.secure_plan_digest(directory/"plan.tfplan")[0],
                        "rendered binary binding differs")
        elif name=="apply":
            require(show is not None and args==["apply","-input=false","-no-color","-lock-timeout=0s","-parallelism=1",show]
                    and phase.get("binaryPlanSha256")==A.H.secure_plan_digest(directory/"plan.tfplan")[0],
                    "apply differs from held rendered plan")
            intent,_=S.private(directory/"mutation-intent.json")
            require(A.receipt_utc(intent["created_at_utc"],"intent")<=start
                    and end<A.utc(intent["not_after_utc"],"action deadline"),"apply outside original intent")
        else:require(args==fixed[name],"fixed command changed")
        filename={"show":"rendered.json","state":"state.json","init":"init.stdout","plan":"plan.stdout",
                  "apply":"apply.stdout"}.get(name,name+".json")
        raw=S.private_bytes(directory/filename)
        require(type(phase.get("stdoutBytes")) is int and phase["stdoutBytes"]==len(raw)
                and phase.get("stdoutSha256")==A.sha(raw),"raw phase output differs")
    return phases

def finish(mode,path,directory,digest,now,publish=True):
    state,request,expected,v=verify(mode,path,directory,digest,now);authenticate(mode,path,directory,digest,now)
    require(mode in ("execute","reconcile"),"execution or original-state reconciliation required")
    doc,_=S.private(directory/"rendered.json");audit_plan(doc,v)
    original=state["original"]
    if mode=="execute":
        mutation,_=S.private(directory/"mutation-intent.json")
        require(mutation.get("session_sha256")==digest and mutation.get("snapshot")==state["snapshot"]
                and mutation.get("planned_ids")==resource_ids(v) and mutation.get("container_ids")==container_ids(v)
                and mutation.get("binary_plan_sha256")==original["result"]["binary_plan_sha256"],"intent changed")
        claim,_=S.private(Path(original["directory"])/"execution-claim.json")
        require(claim=={"directory":str(directory),"request_sha256":state["snapshot"]["request"],"session_sha256":digest},
                "single-use apply claim differs")
    else:mutation=original["origin"]["intent"]
    raw,rawhash=S.raw_state(directory/"work/terraform.tfstate")
    rendered,renderhash=S.private(directory/"state.json")
    raw_and_rendered(raw,rendered,v)
    first=observations(directory,"first",v,original["request"]["storage"],mutation,now)
    second=observations(directory,"second",v,original["request"]["storage"],mutation,now)
    require(encoded(first)==encoded(second),"resource generations/policies changed between observations")
    phases=validate_phases(directory,mode,expected,now)
    observe_phases=[p for p in phases if p["phase"].startswith(("first-","second-"))]
    require(A.receipt_utc(observe_phases[0]["startedAt"],"readback start")<=now
            <A.receipt_utc(observe_phases[0]["startedAt"],"readback start")+timedelta(seconds=180),
            "fresh bounded resource readback required")
    owners={}
    for n in NAMES:
        if publish:write(directory/(n+"-ownership.json"),second[n]["owner"])
        else:require(S.private(directory/(n+"-ownership.json"))[0]==second[n]["owner"],"retained owner differs")
        owners[n]={"path":str(directory/(n+"-ownership.json")),
                   "sha256":A.sha((directory/(n+"-ownership.json")).read_bytes())}
    verify(mode,path,directory,digest,now)
    require(S.raw_state(directory/"work/terraform.tfstate")[1]==rawhash,"state changed before publication")
    result={"kind":"nutrition-azure-storage-ownership-v1","completed":True,"mode":mode,
        "source_sha256":source_digest(),"recorded_at_utc":now.isoformat(),"original_plan":original["result_reference"],
        "request":{"path":str(path),"sha256":state["snapshot"]["request"]},"session_sha256":digest,
        "intent_sha256":A.sha(encoded(mutation)),"state_path":str(directory/"work/terraform.tfstate"),
        "state_sha256":rawhash,"rendered_state_sha256":renderhash,"lineage":raw["lineage"],"serial":raw["serial"],
        "ownership":owners,"readback_sha256":A.sha(encoded(second)),"phases_sha256":A.sha(encoded(phases)),
        "terraform_resource_count":5,"azure_object_count":8,"resource_ids":resource_ids(v),
        "container_ids":container_ids(v),"deployment":second["deployment"],
        "original_execution_outcome":"observed-complete" if mode=="execute" else "unconfirmed",
        "external_quiescence_verified":False,"storage_retained":True,"operationalAcceptance":False}
    if not publish:return result
    write(directory/"result.json",result)
    return {"completed":True,"result_sha256":A.sha((directory/"result.json").read_bytes())}


def qualify(reference, now):
    """Read-only regeneration of retained acquisition evidence at its historical clocks."""
    exact(reference, {"path","sha256"})
    result_path=Path(reference["path"]);result=ref(reference)
    require(result_path.name=="result.json" and result.get("kind")=="nutrition-azure-storage-ownership-v1"
            and result.get("completed") is True and result.get("mode") in ("execute","reconcile"),
            "completed retained acquisition receipt required")
    recorded=A.receipt_utc(result["recorded_at_utc"],"acquisition completion")
    require(recorded<=now,"future acquisition receipt")
    directory=result_path.parent
    state=S.reference(directory/"session.json",result["session_sha256"])
    request=ref(result["request"]);path=Path(result["request"]["path"])
    require(state["request"]==str(path),"acquisition request differs")
    original=state["original"]
    plan_directory=Path(original["directory"]);plan_path=Path(original["request_reference"]["path"])
    plan_request=ref(original["request_reference"])
    roots={directory,plan_directory}
    if result["mode"]=="reconcile":
        roots.add(Path(original["origin"]["directory"]))
    separate={path,plan_path,Path(plan_request["identity_file"]),
              Path(plan_request["profile_directory"])/"config",
              Path(plan_request["profile_directory"])/"clouds.config"}
    if result["mode"]=="reconcile":separate.add(Path(request["origin"]["request"]["path"]))
    before=evidence_inventory(roots,separate)
    actual=finish(result["mode"],path,directory,result["session_sha256"],recorded,publish=False)
    require(actual==result,"acquisition aggregate differs from regenerated evidence")
    execution_dir=directory if result["mode"]=="execute" else Path(original["origin"]["directory"])
    execution_state,execution_hash=S.private(execution_dir/"session.json")
    settlement,_=S.private(execution_dir/"local-settlement.json")
    claim={"directory":str(execution_dir),"request_sha256":execution_state["snapshot"]["request"],
           "session_sha256":execution_hash}
    require(settlement=={"kind":"nutrition-storage-local-settlement-v1",
        "session_sha256":execution_hash,"request_sha256":claim["request_sha256"],
        "local_process_settled":True},"original local process settlement required")
    original_plan=ref(result["original_plan"])
    plan_recorded=A.receipt_utc(original_plan["completed_at_utc"],"plan completion")
    require(plan_recorded<=recorded,"plan completed after acquisition")
    _,plan_session_hash=S.private(plan_directory/"session.json")
    regenerated=plan_finish("plan",plan_path,plan_directory,plan_session_hash,plan_recorded,
                            publish=False,expected_claim=claim)
    require(regenerated==original_plan,"original plan evidence differs")
    after=evidence_inventory(roots,separate)
    require(before==after,"acquisition evidence changed during qualification")
    binding={"kind":"nutrition-azure-storage-acquisition-binding-v1",
            "receipt":reference,"source_sha256":source_digest(),"ownership":result["ownership"],
            "original_execution_outcome":result["original_execution_outcome"],
            "external_quiescence_verified":False,"evidence":after,
            "evidence_sha256":A.sha(encoded(after))}
    acquisition_metadata(binding,roots)
    return binding

def acquisition_metadata(binding,roots):
    """Account separately for exact stderr metadata; never strip the transmitted inventory."""
    evidence=binding["evidence"];files={row["path"]:row for row in evidence["files"]}
    selected={}
    for root in roots:
        path=root/"session.json"
        session=S.reference(path,files[str(path)]["sha256"])
        require(session["mode"] in ("plan","execute","reconcile"),"fixed diagnostic metadata mode required")
        for label in phase_labels(session["mode"],session["values"]):
            selected[str(root/(label+".stderr"))]=str(root)
    actual={path:root for path,root in selected.items() if path in files}
    require(len(actual)<=MAX_DIAGNOSTIC_REFERENCES,"diagnostic metadata reference limit")
    directories={row["path"]:row for row in evidence["directories"]};contribution=0
    for path,root in actual.items():
        name=Path(path).name
        require(directories[root].get("children",[]).count(name)==1,"diagnostic child metadata differs")
        # Each removed array member can remove at most one comma; include both conservatively.
        size=len(encoded(files[path]))-1+len(encoded(name))-1+2
        require(size<=MAX_DIAGNOSTIC_REFERENCE_BYTES,"diagnostic metadata reference too large")
        contribution+=size
    require(contribution<=MAX_DIAGNOSTIC_METADATA,"diagnostic metadata aggregate limit")
    projected={**binding,"evidence":{**evidence,
        "files":[row for row in evidence["files"] if row["path"] not in actual],
        "directories":[{**row,"children":[name for name in row["children"]
            if str(Path(row["path"])/name) not in actual]} if "children" in row else row
            for row in evidence["directories"]]}}
    ordinary=encoded(projected);raw=encoded(binding)
    require(len(ordinary)<=MAX_ORDINARY_METADATA,"ordinary acquisition metadata limit")
    require(0<=len(raw)-len(ordinary)<=contribution and len(raw)<=MAX_BINDING_BYTES,
            "bounded acquisition evidence output")
    return raw

def evidence_inventory(roots, separate):
    files={};directories={};links={};total=0
    def directory_row(path,children=False):
        P.safe_path(path);info=path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0,os.getuid())
                and not info.st_mode & 0o022,"protected evidence directory")
        row={"path":str(path),"dev":str(info.st_dev),"ino":str(info.st_ino),"mode":stat.S_IMODE(info.st_mode)}
        if children:row["children"]=sorted(p.name for p in path.iterdir())
        old=directories.get(str(path))
        if old and "children" in old and "children" not in row:return
        directories[str(path)]=row
    def file_row(path):
        nonlocal total
        if str(path) in files:return
        P.safe_path(path);info=path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_nlink==1
                and stat.S_IMODE(info.st_mode) in (0o600,0o644,0o755)
                and info.st_size<=Q.MAX_FILE,"bounded retained evidence file")
        import hashlib
        digest=hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda:source.read(1024*1024),b""):digest.update(block)
        after=path.lstat()
        require((info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)==
                (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),
                "evidence file changed")
        total+=info.st_size;require(total<=2*1024*1024*1024,"aggregate retained evidence bound")
        files[str(path)]={"path":str(path),"sha256":digest.hexdigest(),"size":info.st_size,
                         "mode":stat.S_IMODE(info.st_mode),"dev":str(info.st_dev),"ino":str(info.st_ino)}
        directory_row(path.parent)
    for root in sorted(roots):
        identity(root);directory_row(root,True)
        session,_=S.private(root/"session.json")
        require(session["mode"] in ("plan","execute","reconcile"),"fixed storage inventory mode required")
        for rel,row in storage_tree(root,session["mode"],session["values"]).items():
            path=root/rel
            if row["type"]=="file":file_row(path)
            elif row["type"]=="directory":directory_row(path,True)
            else:
                info=path.lstat()
                links[str(path)]={"path":str(path),"target":row["target"],"dev":str(info.st_dev),
                    "ino":str(info.st_ino),"mtime_ns":str(info.st_mtime_ns),"ctime_ns":str(info.st_ctime_ns)}
    for path in sorted(separate):file_row(path)
    require(len(files)+len(directories)+len(links)<=384,"finite retained evidence")
    return {"files":[files[k] for k in sorted(files)],"directories":[directories[k] for k in sorted(directories)],
            "links":[links[k] for k in sorted(links)]}

def main():
    os.umask(0o077);signal.alarm(30)
    args=sys.argv[1:]
    if args==["source"]:
        print(source_digest());return
    if len(args)==3 and args[0]=="qualify":
        raw=encoded(qualify({"path":args[1],"sha256":args[2]},datetime.now(timezone.utc)))
        require(len(raw)<=MAX_BINDING_BYTES,"bounded acquisition evidence output")
        sys.stdout.buffer.write(raw);return
    require(len(args) in (3,5),"fixed stage arguments required")
    stage,mode,name=args[:3];require(mode in ("plan","execute","reconcile"),"fixed mode")
    path=Path(name);now=datetime.now(timezone.utc)
    if stage=="prepare":
        require(len(args)==3,"prepare arguments");value=prepare(mode,path,now)
    else:
        require(len(args)==5,"action arguments");directory=Path(args[3]);digest=args[4]
        if stage=="verify":verify(mode,path,directory,digest,now);value={"verified":True}
        elif stage=="authenticate":authenticate(mode,path,directory,digest,now);value={"authenticated":True}
        elif stage=="plan-finish":value=plan_finish(mode,path,directory,digest,now)
        elif stage=="intent":value=intent(mode,path,directory,digest,now)
        elif stage=="reads":value=read_commands(mode,path,directory,digest,now)
        elif stage=="finish":value=finish(mode,path,directory,digest,now)
        else:raise ValueError("unknown stage")
    raw=encoded(value);require(len(raw)<=65536,"bounded public helper result")
    sys.stdout.buffer.write(raw)
if __name__=="__main__":
    try:main()
    except BaseException:
        sys.stderr.write("Storage acquisition stage rejected; retain private operation state.\n");sys.exit(1)
