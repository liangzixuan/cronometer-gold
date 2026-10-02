#!/usr/bin/env python3
"""Synthetic contract tests; no Azure credentials, requests, plans or resources."""
import copy
import configparser
import contextlib
import ctypes
import io
import itertools
import signal
import subprocess
import time
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
A = load("development_auditor", HERE / "audit-plan.py")
B = load("independent_beta_fixture", REPO / "infra/azure/tests/test_audit_saved_plan.py")
P = load("development_auth_preflight", HERE / "auth-preflight.py")
NOW = datetime(2026, 10, 1, 8, 0, tzinfo=timezone.utc)
SUB = "11111111-2222-3333-4444-555555555555"
PREFIX = "nourishing-dev-0123456789ab"
PROFILE = "/providers/Microsoft.Billing/billingAccounts/synthetic/billingProfiles/synthetic"
HASHES = {k: "ab" * 32 for k in ("credit", "providers", "compute", "quota", "sku", "image")}

def response(label, path, selected):
    return {"label": label, "startedAt": "2026-10-01T07:00:00Z", "endedAt": "2026-10-01T07:00:01Z",
            "completed": True, "timedOut": False, "exitCode": 0,
            "stdoutSha256": "cd"*32, "stderrSha256": "ef"*32,
            "arguments": ["-IBm", "azure.cli", "rest", "--method", "get", "--url", "https://management.azure.com"+path+"?api-version=2026-01-01", "--subscription", SUB, "--query", "synthetic selected projection", "--only-show-errors", "--output", "json"], "selected": selected}

def evidence():
    base = "/subscriptions/"+SUB
    d = {k: {"commands": []} for k in HASHES}
    def put(kind, label, path, selected): d[kind]["commands"].append(response(label,path,selected))
    put("providers", "after-subscription-policy", base, {"subscriptionId": SUB, "state": "Enabled", "subscriptionPolicies": {"quotaId": "AzureForStudents_2018-01-01", "spendingLimit": "On"}})
    put("providers", "after-billing-property", base+"/providers/Microsoft.Billing/billingProperty/default", {"billingProfileId": PROFILE, "billingProfileSpendingLimit": "On", "billingProfileStatus": "Active", "subscriptionBillingStatus": "Active", "subscriptionBillingType": "Free"})
    for kind, label, namespace in [("compute","after-compute-registration-once","Microsoft.Compute"),("providers","after-Microsoft.Network-once","Microsoft.Network"),("providers","after-Microsoft.DevTestLab-once","Microsoft.DevTestLab")]:
        put(kind,label,base+"/providers/"+namespace,{"namespace":namespace,"registrationState":"Registered"})
    money={"currency":"USD","value":100}; zero={"currency":"USD","value":0}
    put("credit","credit-balance-summary",PROFILE+"/providers/Microsoft.Consumption/credits/balanceSummary", {"isEstimatedBalance":False,"creditCurrency":"USD","billingCurrency":"USD","balanceSummary":{"currentBalance":money},"pendingEligibleCharges":zero,"pendingCreditAdjustments":zero})
    put("credit","credit-lots",PROFILE+"/providers/Microsoft.Consumption/lots", {"hasNext":False,"credits":[{"source":"Azure for students credit","isEstimatedBalance":False,"startDate":"2026-09-28T00:00:00Z","expirationDate":"2027-09-28T00:00:00Z","closedBalance":money}]})
    put("quota","centralus-positive-and-arm-family-quotas",base+"/providers/Microsoft.Compute/locations/centralus/usages", {"hasNext":False,"nextLink":None,"matches":[{"name":name,"unit":"Count","limit":limit,"currentValue":0} for name,limit in [("cores",6),("standardBpsv2Family",10)]]})
    put("sku","centralus-Standard_B4ps_v2-exact",base+"/providers/Microsoft.Compute/skus", {"hasNext":False,"nextLink":None,"matches":[{"name":"Standard_B4ps_v2","family":"standardBpsv2Family","locations":["centralus"],"restrictions":[],"capabilities":[{"name":k,"value":v} for k,v in {"vCPUs":"4","vCPUsAvailable":"4","MemoryGB":"16","CpuArchitectureType":"Arm64","HyperVGenerations":"V1,V2","TrustedLaunchDisabled":"True"}.items()]}]})
    image=response("selected-exact-CentralUS-Canonical-Arm64-image","unused",{"name":"24.04.202609040","location":"centralus","architecture":"Arm64","hyperVGeneration":"V2","plan":None,"imageDeprecationStatus":{"imageState":"Active"},"osDiskImage":{"operatingSystem":"Linux"}})
    image["arguments"]=["vm","image","show","--location","centralus","--urn","Canonical:ubuntu-24_04-lts:server-arm64:24.04.202609040","--query","synthetic selected projection"]
    d["image"]["commands"].append(image)
    d["credit"]["records"]=d["credit"].pop("commands")
    return d

def plan():
    # Transform the older independently hand-written provider fixture, not the new policy's expected_values.
    raw=json.dumps(B.valid_plan()).replace(".beta", ".development").replace('"beta"','"development"').replace("nutrition-beta",PREFIX).replace("eastus2","centralus").replace("10.42.","10.43.")
    p=json.loads(raw)
    discard=("azurerm_management_lock", "azurerm_consumption_budget")
    p["resource_changes"]=[x for x in p["resource_changes"] if not x["address"].startswith(discard)]
    p["configuration"]["root_module"]["resources"]=[x for x in p["configuration"]["root_module"]["resources"] if not x["address"].startswith(discard)]
    v={"subscription_id":SUB,"name_prefix":PREFIX,"admin_ipv4_cidr":"8.8.8.8/32","ssh_public_key":B.SSH_KEY,"shutdown_deadline_utc":"2026-10-01T10:00:00Z",
       "live_preflight":{"checked_at_utc":"2026-10-01T07:00:00Z","subscription_id":SUB,"spending_limit":"On","billing_limit":"On","credit_currency":"USD","remaining_credit":100,"credit_expires_utc":"2027-09-28T00:00:00Z","regional_remaining":6,"family_remaining":10,"source_sha256":HASHES}}
    p["variables"]={k:{"value":v} for k,v in v.items()};p["timestamp"]="2026-10-01T08:00:00Z"
    p["checks"]=[B._check("azurerm_resource_group.development","unknown")]
    vm=after(p,"azurerm_linux_virtual_machine.development")
    vm.update(computer_name="nutrition-development",size="Standard_B4ps_v2",secure_boot_enabled=False,vtpm_enabled=False)
    vm["source_image_reference"][0]["version"]="24.04.202609040"
    after(p,"azurerm_managed_disk.data")["tags"].pop("preservation")
    rules=after(p,"azurerm_network_security_group.development")["security_rule"]
    rules[:]=[x for x in rules if x["destination_port_range"]!="80"]
    rules[1]["description"]="Public HTTPS reaches Caddy; Caddy must enforce the one-/32 synthetic development application allowlist."
    rules.append({"name":"deny-all-other-inbound","description":"No public dependencies, HTTP or implicit VNet ingress.","priority":4096,"direction":"Inbound","access":"Deny","protocol":"*","source_port_range":"*","destination_port_range":"*","source_address_prefix":"*","destination_address_prefix":"*"})
    schedule=after(p,"azurerm_dev_test_global_vm_shutdown_schedule.development")
    schedule.update(daily_recurrence_time="1000",notification_settings=[{"enabled":False,"time_in_minutes":30}])
    return p

def change(p,address): return next(x["change"] for x in p["resource_changes"] if x["address"]==address)
def after(p,address): return change(p,address)["after"]
def selected(d,kind,label): return next(x for x in d[kind].get("commands",d[kind].get("records",[])) if x["label"]==label)["selected"]
def setpath(obj,path,value):
    for key in path[:-1]: obj=obj[key]
    obj[path[-1]]=value

class Contract(unittest.TestCase):
    def rejects(self,p=None,d=None,now=NOW):
        with self.assertRaises(A.Error): A.audit_plan(p or plan(),d or evidence(),HASHES,now)
    def test_complete_synthetic_plan_passes(self): A.audit_plan(plan(),evidence(),HASHES,NOW)
    def test_rules_unordered(self):
        p=plan();after(p,"azurerm_network_security_group.development")["security_rule"].reverse();A.audit_plan(p,evidence(),HASHES,NOW)
    def test_configuration_reference_mutations(self):
        for address,path,leaf in A.REFERENCES:
            p=plan();item=next(x for x in p["configuration"]["root_module"]["resources"] if x["address"]==address)
            setpath(item["expressions"],path,{"references":["azurerm_linux_virtual_machine.other.id"]})
            with self.subTest(address=address,path=path): self.rejects(p)
    def test_each_create_action_schema_and_unknown_mask(self):
        for item in plan()["resource_changes"]:
            address=item["address"]
            for mode in ("action","schema","unknown","duplicate"):
                p=plan()
                if mode=="action": change(p,address)["actions"]=["delete","create"]
                elif mode=="schema": next(x for x in p["configuration"]["root_module"]["resources"] if x["address"]==address)["schema_version"]=99
                elif mode=="unknown": change(p,address)["after_unknown"]["admin_password"]=True
                else:p["resource_changes"].append(copy.deepcopy(item))
                with self.subTest(address=address,mode=mode): self.rejects(p)
    def test_plan_graph_lifecycle_and_metadata(self):
        for mutate in [lambda p:p["resource_changes"].pop(),lambda p:p.update(prior_state={"values":{"root_module":{"resources":[{}]}}}),lambda p:p.update(resource_drift=[{}]),lambda p:p.update(terraform_version="1.6.0"),lambda p:p["configuration"]["root_module"].update(module_calls={"x":{}}),lambda p:p["resource_changes"][0].update(previous_address="old"),lambda p:p["resource_changes"][0]["change"].update(importing={"id":"old"}),lambda p:p["configuration"]["provider_config"]["azurerm"].update(version_constraint="4.80.0"),lambda p:p["checks"].clear()]:
            p=plan();mutate(p);self.rejects(p)
    def test_time_and_variable_mutations(self):
        for key,value in [("admin_ipv4_cidr","0.0.0.0/0"),("admin_ipv4_cidr","127.0.0.1/32"),("ssh_public_key","ssh-ed25519 invalid"),("name_prefix","nourishing-beta"),("shutdown_deadline_utc","2026-10-02T10:00:00Z"),("shutdown_deadline_utc","2026-10-01T12:01:00Z"),("shutdown_deadline_utc","2026-10-01T08:20:00Z"),("shutdown_deadline_utc","2026-10-01T10:00:01Z")]:
            p=plan();p["variables"][key]["value"]=value
            with self.subTest(key=key,value=value):self.rejects(p)
        self.rejects(now=NOW+timedelta(minutes=16))
    def test_security_and_cost_mutations(self):
        cases=[("azurerm_linux_virtual_machine.development",("size",),"Standard_M416ms_v2"),("azurerm_linux_virtual_machine.development",("custom_data",),"runtime"),("azurerm_linux_virtual_machine.development",("user_data",),"runtime"),("azurerm_linux_virtual_machine.development",("disable_password_authentication",),False),("azurerm_linux_virtual_machine.development",("allow_extension_operations",),True),("azurerm_linux_virtual_machine.development",("secure_boot_enabled",),True),("azurerm_linux_virtual_machine.development",("os_disk",0,"disk_size_gb"),1024),("azurerm_linux_virtual_machine.development",("source_image_reference",0,"version"),"latest"),("azurerm_managed_disk.data",("disk_size_gb",),1024),("azurerm_network_security_group.development",("security_rule",0,"source_address_prefix"),"Internet"),("azurerm_network_security_group.development",("security_rule",1,"destination_port_range"),"80"),("azurerm_network_security_group.development",("security_rule",2,"access"),"Allow"),("azurerm_dev_test_global_vm_shutdown_schedule.development",("enabled",),False),("azurerm_dev_test_global_vm_shutdown_schedule.development",("daily_recurrence_time",),"1100"),("azurerm_dev_test_global_vm_shutdown_schedule.development",("timezone",),"Central Standard Time")]
        for address,path,value in cases:
            p=plan();setpath(after(p,address),path,value)
            with self.subTest(address=address,path=path):self.rejects(p)
    def test_evidence_field_failures(self):
        cases=[("providers","after-subscription-policy",("subscriptionPolicies","spendingLimit"),"Off"),("providers","after-billing-property",("billingProfileSpendingLimit",),"Off"),("providers","after-Microsoft.Network-once",("registrationState",),"NotRegistered"),("credit","credit-balance-summary",("balanceSummary","currentBalance","value"),19),("credit","credit-balance-summary",("isEstimatedBalance",),True),("credit","credit-balance-summary",("pendingEligibleCharges","value"),1),("credit","credit-lots",("hasNext",),True),("credit","credit-lots",("credits",0,"expirationDate"),"2026-10-02T00:00:00Z"),("quota","centralus-positive-and-arm-family-quotas",("matches",0,"limit"),3),("quota","centralus-positive-and-arm-family-quotas",("hasNext",),True),("sku","centralus-Standard_B4ps_v2-exact",("matches",0,"restrictions"),["blocked"]),("image","selected-exact-CentralUS-Canonical-Arm64-image",("architecture",),"x64"),("image","selected-exact-CentralUS-Canonical-Arm64-image",("plan",),{"name":"paid"})]
        for kind,label,path,value in cases:
            d=evidence();setpath(selected(d,kind,label),path,value)
            with self.subTest(kind=kind,path=path):self.rejects(d=d)
    def test_evidence_completion_times_identity(self):
        for key,value in [("completed",False),("exitCode",1),("timedOut",True),("stdoutSha256",None),("startedAt","2026-09-30T01:00:00Z"),("endedAt","2026-10-01T09:00:00Z"),("arguments",["az","fake"])]:
            d=evidence();d["providers"]["commands"][0][key]=value
            with self.subTest(key=key):self.rejects(d=d)
        d=evidence();d["providers"]["commands"].append(copy.deepcopy(d["providers"]["commands"][0]));self.rejects(d=d)
        p=plan();p["variables"]["live_preflight"]["value"]["source_sha256"]={};self.rejects(p)
    def test_planned_representation_disagreement(self):
        p=plan();p["planned_values"]={"root_module":{"resources":[]}};self.rejects(p)
    def test_planned_representation_full_agreement_and_missing_known_value(self):
        p=plan();resources=[]
        for item in p["resource_changes"]:
            address=item["address"]
            resources.append({"address":address,"mode":"managed","type":item["type"],"name":item["name"],"provider_name":item["provider_name"],"schema_version":1 if item["type"]=="azurerm_managed_disk" else 0,"values":copy.deepcopy(item["change"]["after"])})
        p["planned_values"]={"root_module":{"resources":resources}}
        A.audit_plan(p,evidence(),HASHES,NOW)
        resources[0]["values"]={}
        self.rejects(p)
    def test_protected_plan_descriptor(self):
        with tempfile.TemporaryDirectory() as t:
            path=Path(t)/"owned.tfplan";path.write_bytes(b"synthetic binary fixture");path.chmod(0o600)
            digest,size=A.H.secure_plan_digest(path);fd=A.H.open_verified_plan_descriptor(path,digest)
            try:self.assertEqual(os.read(fd,100),b"synthetic binary fixture")
            finally:os.close(fd)
            path.chmod(0o644)
            with self.assertRaises(A.Error):A.H.secure_plan_digest(path)
            path.chmod(0o600);link=Path(t)/"link.tfplan";link.symlink_to(path)
            with self.assertRaises(A.Error):A.H.secure_plan_digest(link)
            path.write_bytes(b"changed")
            with self.assertRaises(A.Error):A.H.open_verified_plan_descriptor(path,digest)
    def test_private_evidence_and_source_binding(self):
        with tempfile.TemporaryDirectory() as t:
            path=Path(t)/"evidence.json";path.write_text('{}');path.chmod(0o600)
            self.assertEqual(A.private_json(path)[0],{})
            path.chmod(0o644)
            with self.assertRaises(A.Error):A.private_json(path)
        with self.assertRaises(A.Error):A.audit_binary_plan(Path('/unused.tfplan'),Path('/unused'),"invalid","changed",{},Path('/unused-provider'))
        self.assertEqual(len(A.source_digest()),64)
    def test_actual_renderer_success_malformed_failed_and_timeout(self):
        env={"PATH":"/usr/bin:/bin"}
        self.assertEqual(A.run_json([sys.executable,"-I","-c","print('{}')"],HERE,env),{})
        for code in ["print('invalid')","raise SystemExit(1)","import time;time.sleep(2)"]:
            with self.subTest(code=code),self.assertRaises(A.Error):A.run_json([sys.executable,"-I","-c",code],HERE,env,timeout=0.1)
        with mock.patch.object(A,"MAX_JSON",1024):
            with self.assertRaises(A.Error):A.run_json([sys.executable,"-I","-c","print('x'*2048)"],HERE,env)
    def test_source_and_ci_contract(self):
        main=(HERE/'main.tf').read_text();ci=(REPO/'.github/workflows/ci.yml').read_text()
        self.assertEqual(main.count('\nresource "'),11)
        self.assertNotIn('destination_port_range     = "80"',main)
        for forbidden in ('azurerm_management_lock','azurerm_consumption_budget','custom_data','provisioner','cloud-init'):
            self.assertNotIn(forbidden,main)
        self.assertRegex(main, r'default_outbound_access_enabled\s*= false')
        self.assertIn('resource_provider_registrations = "none"',(HERE/'versions.tf').read_text())
        self.assertEqual((HERE/'.terraform.lock.hcl').read_bytes(),(REPO/'infra/azure/.terraform.lock.hcl').read_bytes())
        for command in ('init -backend=false -lockfile=readonly -input=false','fmt -check','validate','python3 -B infra/development/azure/test-contract.py'):
            self.assertIn(command,ci)


    def test_ambiguous_json_and_extra_tags_rejected(self):
        for raw in ('{"x":1,"x":2}', '{"x":NaN}'):
            with self.assertRaises(A.Error):A.strict_json(raw)
        p=plan();after(p,"azurerm_resource_group.development")["tags"]["extra"]="";self.rejects(p)

    def test_saved_windows_utc_offset(self):
        d=evidence();item=d["image"]["commands"][0]
        for key in ("startedAt","endedAt"):item[key]=item[key].replace("Z","+00:00")
        item.pop("completed");item["error"]=None
        A.audit_plan(plan(),d,HASHES,NOW)
        item["startedAt"]=item["startedAt"].replace("+00:00","+01:00")
        self.rejects(d=d)
    def test_incomplete_nonimage_receipt_rejected(self):
        d=evidence();d["providers"]["commands"][0].pop("completed");self.rejects(d=d)
    def test_binary_boundary_conserves_inputs_and_suppresses_failed_acceptance(self):
        # Exact synthetic executable/renderer seam; no claim that this is an Azure binary plan.
        executable=Path('/usr/bin/true')
        with tempfile.TemporaryDirectory() as t:
            folder=Path(t);binary=folder/'plan.tfplan';binary.write_bytes(b'owned synthetic binary');binary.chmod(0o600)
            docs=evidence();paths={};hashes={}
            for kind,doc in docs.items():
                path=folder/(kind+'.json');path.write_text(json.dumps(doc));path.chmod(0o600);paths[kind]=path;hashes[kind]=A.sha(path.read_bytes())
            p=plan();p['variables']['live_preflight']['value']['source_sha256']=hashes
            expected=A.H.secure_plan_digest(binary)[0];source=A.source_digest();tool=A.H.secure_executable_digest(executable)[0]
            def renderer(command,cwd,env,pass_fds=()):
                self.assertNotIn('ARM_CLIENT_SECRET',env);self.assertEqual(env['TF_CLI_CONFIG_FILE'],'/dev/null')
                if command[1]=='version':return {'terraform_version':'1.5.7','platform':'linux_amd64'}
                self.assertEqual(len(pass_fds),1);self.assertEqual(os.read(pass_fds[0],100),b'owned synthetic binary')
                return p
            with mock.patch.object(A,'TF_SHA256',tool),mock.patch.object(A,'prepare_provider',return_value=(folder,{})),mock.patch.object(A,'provider_digest',return_value={}):
                result=A.audit_binary_plan(binary,executable,expected,source,paths,folder,renderer=renderer,now=NOW)
                self.assertEqual(result['resource_count'],11)
                def changed_plan(*args,**kwargs):
                    result=renderer(*args,**kwargs)
                    if args[0][1]=='show':binary.write_bytes(b'changed')
                    return result
                with self.assertRaises(A.Error):A.audit_binary_plan(binary,executable,expected,source,paths,folder,renderer=changed_plan,now=NOW)
                binary.write_bytes(b'owned synthetic binary')
                def changed_evidence(*args,**kwargs):
                    result=renderer(*args,**kwargs)
                    if args[0][1]=='show':paths['credit'].write_text('{}')
                    return result
                with self.assertRaises(A.Error):A.audit_binary_plan(binary,executable,expected,source,paths,folder,renderer=changed_evidence,now=NOW)
            with mock.patch.object(A,'source_digest',side_effect=[source,'different']),mock.patch.object(A,'TF_SHA256',tool),mock.patch.object(A,'prepare_provider',return_value=(folder,{})),mock.patch.object(A,'provider_digest',return_value={}):
                for kind,doc in docs.items():paths[kind].write_text(json.dumps(doc))
                with self.assertRaises(A.Error):A.audit_binary_plan(binary,executable,expected,source,paths,folder,renderer=renderer,now=NOW)
            with mock.patch.object(A,'TF_SHA256',tool),mock.patch.object(A,'prepare_provider',return_value=(folder,{})),mock.patch.object(A,'provider_digest',return_value={'changed':'provider'}):
                with self.assertRaisesRegex(A.Error,'provider changed around rendering'):A.audit_binary_plan(binary,executable,expected,source,paths,folder,renderer=renderer,now=NOW)
            with mock.patch.object(A.H,'secure_executable_digest',side_effect=[(A.TF_SHA256,1),('changed',1)]),mock.patch.object(A,'prepare_provider',return_value=(folder,{})),mock.patch.object(A,'provider_digest',return_value={}):
                with self.assertRaises(A.Error):A.audit_binary_plan(binary,executable,expected,source,paths,folder,renderer=renderer,now=NOW)


    def test_result_publication_is_create_only_private_and_atomic(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);path=root/'result.json';result={'scope':'synthetic local result'}
            A.publish_result(path,result)
            self.assertEqual(json.loads(path.read_text()),result);self.assertEqual(path.stat().st_mode & 0o777,0o600)
            with self.assertRaises(FileExistsError):A.publish_result(path,{'other':True})
            self.assertEqual(json.loads(path.read_text()),result);self.assertEqual(list(root.iterdir()),[path])
            interrupted=root/'interrupted.json';write=os.write;calls=0
            def interrupted_write(fd,data):
                nonlocal calls
                calls+=1
                if calls==1:return write(fd,data[:3])
                raise KeyboardInterrupt('synthetic interrupted write')
            with mock.patch.object(A.os,'write',side_effect=interrupted_write),self.assertRaises(KeyboardInterrupt):A.publish_result(interrupted,result)
            self.assertFalse(interrupted.exists());self.assertEqual(list(root.iterdir()),[path])
            with mock.patch.object(A.os,'fsync',side_effect=OSError('synthetic file fsync failure')),self.assertRaises(OSError):A.publish_result(interrupted,result)
            self.assertFalse(interrupted.exists());self.assertEqual(list(root.iterdir()),[path])
    def test_post_publication_failure_reports_complete_result(self):
        with tempfile.TemporaryDirectory() as t:
            path=Path(t)/'result.json';fsync=os.fsync;calls=0
            def fail_directory(fd):
                nonlocal calls
                calls+=1
                if calls==2:raise OSError('synthetic directory fsync failure')
                return fsync(fd)
            with mock.patch.object(A.os,'fsync',side_effect=fail_directory),self.assertRaises(A.PublishedResultError):A.publish_result(path,{'complete':True})
            self.assertEqual(json.loads(path.read_text()),{'complete':True});self.assertEqual(list(Path(t).iterdir()),[path])
    def test_real_orphan_descendant_is_killed_reaped_and_rejected(self):
        # A test-local Linux subreaper lets this process reap precisely its orphan fixture.
        libc=ctypes.CDLL(None,use_errno=True);original=ctypes.c_int()
        self.assertEqual(libc.prctl(37,ctypes.byref(original),0,0,0),0)
        self.assertEqual(libc.prctl(36,1,0,0,0),0)
        old_handler=signal.getsignal(signal.SIGCHLD)
        state={};reaped=[]
        with tempfile.TemporaryDirectory() as t:
            path=Path(t)/'descendant.json'
            def reap(signum=None,frame=None):
                if path.exists() and not state:
                    try:state.update(json.loads(path.read_text()))
                    except json.JSONDecodeError:return
                if state and state['pid'] not in reaped:
                    try:
                        pid,status=os.waitpid(state['pid'],os.WNOHANG)
                        if pid:reaped.append(pid)
                    except ChildProcessError:pass
            signal.signal(signal.SIGCHLD,reap)
            descendant="import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(10)"
            leader="import subprocess,sys,json,os; p=subprocess.Popen([sys.executable,'-I','-c',"+repr(descendant)+"]);open("+repr(str(path))+",'w').write(json.dumps({'pid':p.pid,'group':os.getpgrp()}));print('{}')"
            try:
                with self.assertRaises(A.Error):A.run_json([sys.executable,'-I','-c',leader],HERE,{'PATH':'/usr/bin:/bin'},timeout=2)
                reap();self.assertTrue(state,'actual descendant identity was not captured');self.assertIn(state['pid'],reaped)
                with self.assertRaises(ProcessLookupError):os.kill(state['pid'],0)
            finally:
                reap()
                if state and state['pid'] not in reaped:
                    try:
                        if os.getpgid(state['pid'])==state['group']:os.kill(state['pid'],signal.SIGKILL)
                    except ProcessLookupError:pass
                    try:os.waitpid(state['pid'],0)
                    except ChildProcessError:pass
                signal.signal(signal.SIGCHLD,old_handler);self.assertEqual(libc.prctl(36,original.value,0,0,0),0)
    def test_failed_kill_or_unsettled_group_never_returns_json(self):
        for failure in ('denied','unsettled'):
            child=mock.Mock(pid=12345);child.poll.return_value=None;child.wait.return_value=0
            def kill(pid,sig):
                if sig==signal.SIGKILL and failure=='denied':raise PermissionError('synthetic kill denied')
            with self.subTest(failure=failure),mock.patch.object(A.subprocess,'Popen',return_value=child),mock.patch.object(A.os,'killpg',side_effect=kill),mock.patch.object(A.time,'monotonic',side_effect=itertools.count(0,10)),mock.patch.object(A.time,'sleep'),self.assertRaises(A.Error):
                A.run_json(['/synthetic'],HERE,{},timeout=1)
    def test_provider_package_rejects_missing_and_unqualified_bytes(self):
        with tempfile.TemporaryDirectory() as t:
            private=Path(t);root=private/'provider';root.mkdir()
            with self.assertRaisesRegex(A.Error,'unexpected provider package files'):A.provider_digest(root,private)
            for name,(_,mode) in A.PROVIDER_FILES.items():
                (root/name).write_bytes(b'synthetic wrong package');(root/name).chmod(mode)
            with self.assertRaisesRegex(A.Error,'qualified provider package digest changed'):A.provider_digest(root,private)

class Authentication(unittest.TestCase):
    def setUp(self):
        # Canonical user-owned ancestors match the production path checks; no live profile is read.
        self.temporary = tempfile.TemporaryDirectory(prefix='nourishing-auth-test-', dir=Path.home())
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.profile = self.root / 'profile'; self.profile.mkdir(mode=0o700)
        self.expected = {'subscriptionId': SUB, 'tenantId': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}
        self.input = self.root / 'expected.json'; self.input.write_text(json.dumps(self.expected)); self.input.chmod(0o600)
        self.config = self.profile / 'config'
        settings = configparser.ConfigParser(); settings.read_dict(P.SETTINGS)
        with self.config.open('w') as output: settings.write(output)
        self.config.chmod(0o600)
        self.clouds = self.profile / 'clouds.config'
        self.clouds.write_text('[AzureCloud]\nsubscription = '+SUB+'\n'); self.clouds.chmod(0o644)
        self.version = {'azure-cli': P.CLI_VERSION, 'azure-cli-core': P.CLI_VERSION, 'azure-cli-telemetry': '1.1.0', 'extensions': {}}
        self.account = {'id':SUB, 'tenantId':self.expected['tenantId'], 'state':'Enabled', 'environmentName':'AzureCloud'}
        self.subscription = {**self.expected, 'state':'Enabled', 'subscriptionPolicies':{'quotaId':'AzureForStudents_2018-01-01','spendingLimit':'On','locationPlacementId':'Public_2014-09-01'}}
        self.values = [self.version, [], self.account, self.subscription]
        self.cli = self.root / 'az'
        self.write_cli("import json,sys\nvalues="+repr(self.values)+"\nindex={'version':0,'extension':1,'account':2,'rest':3}[sys.argv[1]]\nprint(json.dumps(values[index]))\n")
        self.patch = mock.patch.object(P, 'CLI_SHA256', A.sha(self.cli.read_bytes())); self.patch.start(); self.addCleanup(self.patch.stop)
        self.source = P.source_digest()
        self.result = self.root / 'result.json'
    def write_cli(self, body):
        self.cli.write_text('#!/usr/bin/python3\n'+body); self.cli.chmod(0o755)
    def args(self):
        return ['--cli',str(self.cli),'--profile',str(self.profile),'--expected-identity',str(self.input),
                '--source-sha256',self.source,'--result',str(self.result)]
    def check(self, **kwargs):
        return P.preflight(self.cli,self.profile,self.input,self.source,**kwargs)
    def test_actual_cli_and_private_create_only_result(self):
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured): self.assertEqual(P.main(self.args()),0)
        result = json.loads(self.result.read_text())
        self.assertEqual(result['authentication'],'passed'); self.assertEqual(self.result.stat().st_mode & 0o777,0o600)
        self.assertEqual(set(result['parsed_response_sha256']), {'version','extensions','account','subscription'})
        for value in self.expected.values(): self.assertNotIn(value,captured.getvalue()+self.result.read_text())
        original = self.result.read_bytes()
        with contextlib.redirect_stdout(captured): self.assertEqual(P.main(self.args()),1)
        self.assertEqual(self.result.read_bytes(),original)
    def test_exact_commands_environment_and_response_hashes(self):
        # A different valid cached default must not replace either explicit subscription selection.
        self.clouds.write_text('[AzureCloud]\nsubscription = '+self.expected['tenantId']+'\n')
        commands=[]; environments=[]
        def runner(command,cwd,env,timeout):
            self.assertEqual(timeout,60); self.assertEqual(str(cwd),env['HOME']); self.assertEqual(env['TMPDIR'],env['HOME'])
            self.assertEqual(set(env),{'HOME','TMPDIR','PATH','LANG','AZURE_CONFIG_DIR','AZURE_CORE_COLLECT_TELEMETRY','AZURE_EXTENSION_USE_DYNAMIC_INSTALL','AZURE_LOGGING_ENABLE_LOG_FILE'})
            commands.append(command); environments.append(env)
            return self.values[len(commands)-1]
        with mock.patch.dict(os.environ,{'ARM_CLIENT_SECRET':'PRIVATE_CANARY','AZURE_CLIENT_SECRET':'PRIVATE_CANARY','PYTHONPATH':'PRIVATE_CANARY','HTTPS_PROXY':'PRIVATE_CANARY'}):
            result=self.check(runner=runner)
        suffix=['--only-show-errors','--output','json']
        self.assertEqual(commands[0],[str(self.cli),'version',*suffix])
        self.assertEqual(commands[1],[str(self.cli),'extension','list',*suffix])
        self.assertEqual(commands[2],[str(self.cli),'account','show','--subscription',SUB,'--query',P.ACCOUNT_QUERY,*suffix])
        self.assertEqual(commands[3],[str(self.cli),'rest','--method','get','--url','https://management.azure.com/subscriptions/'+SUB+'?api-version=2022-12-01','--subscription',SUB,'--query',P.SUBSCRIPTION_QUERY,*suffix])
        self.assertNotIn('PRIVATE_CANARY',repr(environments)+json.dumps(result))
        self.assertFalse(Path(environments[0]['HOME']).exists())
        self.assertEqual(result['parsed_response_sha256']['subscription'],A.sha(json.dumps(self.subscription,sort_keys=True,separators=(',',':')).encode()))
    def test_expected_identity_rejects_ambiguous_and_noncanonical_fields(self):
        variants = ['{}','[]',json.dumps({**self.expected,'extra':'PRIVATE_CANARY'}),'{"subscriptionId":"x","subscriptionId":"y","tenantId":"z"}',
                    json.dumps({**self.expected,'tenantId':None}),json.dumps({**self.expected,'tenantId':self.expected['tenantId'].upper()}),
                    json.dumps({**self.expected,'subscriptionId':'https://attacker.invalid/'})]
        for raw in variants:
            with self.subTest(raw=raw):
                self.input.write_text(raw)
                with self.assertRaises(P.Error): self.check(runner=mock.Mock(side_effect=AssertionError('must not execute')))
    def test_input_and_tool_path_protection(self):
        self.input.chmod(0o644)
        with self.assertRaises(P.Error): self.check()
        self.input.chmod(0o600)
        link=self.root/'linked.json';link.symlink_to(self.input)
        with self.assertRaises(P.Error): P.identity(link)
        hard=self.root/'hard.json';os.link(self.input,hard)
        with self.assertRaises(P.Error): self.check()
        hard.unlink(); self.cli.chmod(0o777)
        with self.assertRaises(P.Error): self.check()
        self.cli.chmod(0o755); self.cli.write_text('unqualified bytes')
        with self.assertRaises(P.Error): self.check()
    def test_exact_config_and_cloud_policy(self):
        original=self.config.read_text(); clouds=self.clouds.read_text()
        for extra in ['\n[core]\ncollect_telemetry=yes\n','\n[DEFAULT]\nclient_secret=PRIVATE_CANARY\n','\n[identity]\nauthority=PRIVATE_CANARY\n',
                      '\n[extension]\nuse_dynamic_install=yes\n']:
            self.config.write_text(original+extra)
            with self.subTest(extra=extra),self.assertRaises((P.Error,configparser.Error)): self.check()
        self.config.write_text(original)
        for value in [clouds+'endpoint_resource_manager = https://attacker.invalid/\n',clouds+'\n[PrivateCloud]\nsubscription = '+SUB+'\n',
                      clouds.replace(SUB,'not-a-uuid'),clouds.replace(SUB,self.expected['tenantId'].upper()),
                      clouds+'subscription = '+SUB+'\n',clouds+'\n[DEFAULT]\nprofile=latest\n']:
            self.clouds.write_text(value)
            with self.assertRaises((P.Error,configparser.Error)): self.check()
        self.clouds.write_text(clouds); self.clouds.chmod(0o600)
        self.assertEqual(set(P.profile_digest(self.profile)),{'config','clouds.config'})
    def test_profile_file_and_directory_protection(self):
        for path,mode in [(self.profile,0o755),(self.config,0o644),(self.clouds,0o666)]:
            saved=path.stat().st_mode & 0o777;path.chmod(mode)
            with self.subTest(path=path),self.assertRaises(P.Error):self.check()
            path.chmod(saved)
        saved=self.clouds.read_bytes();self.clouds.unlink();self.clouds.symlink_to(self.input)
        with self.assertRaises(P.Error):self.check()
        self.clouds.unlink();self.clouds.write_bytes(saved);self.clouds.chmod(0o644)
        link=self.root/'profile-link';link.symlink_to(self.profile)
        with self.assertRaises(P.Error):P.profile_digest(link)
    def test_rejects_version_extensions_cached_and_live_identity(self):
        mutations=[(0,'azure-cli','0'),(0,'azure-cli-core','0'),(0,'extensions',{'unexpected':'1'}),
                   (2,'environmentName','PrivateCloud'),(2,'tenantId',SUB),(2,'state','Disabled'),(2,'id',self.expected['tenantId']),
                   (3,'subscriptionId',self.expected['tenantId']),(3,'tenantId',SUB),(3,'state','Disabled'),
                   (3,'subscriptionPolicies',{'quotaId':'PayAsYouGo','spendingLimit':'Off'})]
        for index,key,value in mutations:
            values=copy.deepcopy(self.values);values[index][key]=value
            runner=mock.Mock(side_effect=values)
            with self.subTest(index=index,key=key),self.assertRaises(P.Error):self.check(runner=runner)
            self.assertEqual(runner.call_count,index+1)
        for index in range(4):
            values=copy.deepcopy(self.values);values[index]=None
            with self.subTest(index=index),self.assertRaises(P.Error):self.check(runner=mock.Mock(side_effect=values))
        values=copy.deepcopy(self.values);values[1]=[{'name':'alias'}]
        with self.assertRaises(P.Error):self.check(runner=mock.Mock(side_effect=values))
    def test_source_and_input_changes_abort_before_next_command(self):
        original={p:p.read_bytes() for p in (self.cli,self.input,self.config,self.clouds)}
        for path in original:
            def changed(command,cwd,env,timeout):
                path.write_bytes(original[path]+b'\n');return self.version
            with self.subTest(path=path),self.assertRaises(P.Error):self.check(runner=changed)
            path.write_bytes(original[path])
        with mock.patch.object(P,'source_digest',side_effect=[self.source,'changed']),self.assertRaises(P.Error):self.check()
    def test_actual_nonzero_malformed_stderr_and_timeout_have_no_result(self):
        for body in ["print('PRIVATE_CANARY');raise SystemExit(9)","print('PRIVATE_CANARY')","import sys;print('{}');print('PRIVATE_CANARY',file=sys.stderr)","import time;time.sleep(3)"]:
            self.write_cli(body)
            with mock.patch.object(P,'CLI_SHA256',A.sha(self.cli.read_bytes())):
                def bounded(command,cwd,env,timeout):return P.A.run_json(command,cwd,env,timeout=0.1)
                with self.assertRaises(P.Error):self.check(runner=bounded)
            self.assertFalse(self.result.exists())
    def test_signal_handlers_restore_and_repeat_signals_are_ignored_during_cleanup(self):
        before={s:signal.getsignal(s) for s in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP)}
        with self.assertRaises(InterruptedError):
            with P.signal_scope():
                try:os.kill(os.getpid(),signal.SIGTERM)
                finally:
                    for number in before:self.assertEqual(signal.getsignal(number),signal.SIG_IGN)
                    os.kill(os.getpid(),signal.SIGINT)
        self.assertEqual({s:signal.getsignal(s) for s in before},before)
    def test_actual_int_term_hup_settle_owned_cli(self):
        for number in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP):
            ready=self.root/('ready-'+str(number)+'.json')
            self.write_cli("import os,json,time\nopen("+repr(str(ready))+",'w').write(json.dumps({'pid':os.getpid(),'group':os.getpgrp()}))\ntime.sleep(30)\n")
            probe="import importlib.util;from pathlib import Path;s=importlib.util.spec_from_file_location('probe',"+repr(str(HERE/'auth-preflight.py'))+");p=importlib.util.module_from_spec(s);s.loader.exec_module(p);p.CLI_SHA256="+repr(A.sha(self.cli.read_bytes()))+";raise SystemExit(p.main("+repr(self.args())+"))"
            child=subprocess.Popen([sys.executable,'-B','-I','-c',probe],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
            state=None
            try:
                deadline=time.monotonic()+5
                while state is None and child.poll() is None and time.monotonic()<deadline:
                    if ready.exists():
                        try:state=json.loads(ready.read_text())
                        except json.JSONDecodeError:pass
                    if state is None:time.sleep(0.02)
                self.assertIsNotNone(state,'owned CLI never completed signal fixture handshake')
                self.assertEqual(set(state),{'pid','group'});self.assertEqual(type(state['pid']),int)
                self.assertEqual(state['pid'],state['group']);self.assertGreater(state['pid'],1)
                os.kill(child.pid,number);out,err=child.communicate(timeout=8)
                self.assertEqual(child.returncode,1);self.assertEqual(err,b'');self.assertIn(b'preflight did not complete',out)
                with self.assertRaises(ProcessLookupError):os.kill(state['pid'],0)
                with self.assertRaises(ProcessLookupError):os.killpg(state['group'],0)
                self.assertFalse(self.result.exists())
            finally:
                if child.poll() is None:os.killpg(child.pid,signal.SIGKILL)
                child.communicate(timeout=5)
                if state:
                    try:
                        if os.getpgid(state['pid'])==state['group']:os.killpg(state['group'],signal.SIGKILL)
                    except ProcessLookupError:pass
    def test_console_rejection_never_prints_private_exceptions(self):
        for error in [P.Error('PRIVATE_CANARY'),OSError('PRIVATE_CANARY'),ValueError('PRIVATE_CANARY'),InterruptedError('PRIVATE_CANARY'),subprocess.SubprocessError('PRIVATE_CANARY')]:
            captured=io.StringIO()
            with mock.patch.object(P,'preflight',side_effect=error),contextlib.redirect_stdout(captured):self.assertEqual(P.main(self.args()),1)
            self.assertNotIn('PRIVATE_CANARY',captured.getvalue());self.assertFalse(self.result.exists())
    def test_interruption_after_publication_does_not_claim_no_output(self):
        publish=P.A.publish_result;captured=io.StringIO()
        def interrupted(path,result):
            publish(path,result)
            raise InterruptedError('PRIVATE_CANARY')
        with mock.patch.object(P,'preflight',return_value={'scope':'synthetic'}),mock.patch.object(P.A,'publish_result',side_effect=interrupted),contextlib.redirect_stdout(captured):
            self.assertEqual(P.main(self.args()),1)
        self.assertEqual(json.loads(self.result.read_text()),{'scope':'synthetic'})
        self.assertIn('inspect the requested result path',captured.getvalue())
        self.assertNotIn('no new result',captured.getvalue());self.assertNotIn('PRIVATE_CANARY',captured.getvalue())
    def test_publication_failures_distinguish_complete_output(self):
        captured=io.StringIO()
        with mock.patch.object(P,'preflight',return_value={'scope':'synthetic'}),mock.patch.object(P.A.os,'fsync',side_effect=OSError('PRIVATE_CANARY')),contextlib.redirect_stdout(captured):
            self.assertEqual(P.main(self.args()),1)
        self.assertFalse(self.result.exists());self.assertNotIn('PRIVATE_CANARY',captured.getvalue())
        real_fsync=os.fsync;calls=0
        def fail_directory(fd):
            nonlocal calls
            calls+=1
            if calls==2:raise OSError('PRIVATE_CANARY')
            return real_fsync(fd)
        with mock.patch.object(P,'preflight',return_value={'scope':'synthetic'}),mock.patch.object(P.A.os,'fsync',side_effect=fail_directory),contextlib.redirect_stdout(captured):
            self.assertEqual(P.main(self.args()),2)
        self.assertEqual(json.loads(self.result.read_text()),{'scope':'synthetic'})
        self.assertIn('Complete authentication result was published',captured.getvalue());self.assertNotIn('PRIVATE_CANARY',captured.getvalue())


Q = load("development_plan_input", HERE / "prepare-plan-input.py")

class PlanPreparation(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nourishing-plan-input-', dir=Path.home())
        self.addCleanup(self.temporary.cleanup); self.root = Path(self.temporary.name)
        self.profile = self.root/'profile'; self.profile.mkdir(mode=0o700)
        settings = configparser.ConfigParser(); settings.read_dict(P.SETTINGS)
        with (self.profile/'config').open('w') as output: settings.write(output)
        (self.profile/'config').chmod(0o600)
        (self.profile/'clouds.config').write_text('[AzureCloud]\nsubscription = '+SUB+'\n')
        (self.profile/'clouds.config').chmod(0o600)
        self.expected = {'subscriptionId':SUB,'tenantId':'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}
        self.identity = self.root/'identity.json'; Q.write_json(self.identity,self.expected)
        self.tf = self.root/'terraform'; self.tf.write_bytes(b'#!/bin/false\n'); self.tf.chmod(0o755)
        self.provider = self.root/'provider'; self.provider.mkdir(mode=0o700)
        pins = {}
        for name,mode in [('terraform-provider-azurerm_v4.79.0_x5',0o755),('LICENSE.txt',0o644)]:
            raw=('synthetic-'+name).encode(); p=self.provider/name;p.write_bytes(raw);p.chmod(mode)
            pins[name]=(A.sha(raw),mode)
        for owner,name,value in [(Q.A,'TF_SHA256',A.sha(self.tf.read_bytes())),(Q.A,'PROVIDER_FILES',pins)]:
            patch=mock.patch.object(owner,name,value);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(Q.P,'tool_digest',return_value=(P.CLI_SHA256,100));patch.start();self.addCleanup(patch.stop)
        self.documents=evidence();paths={}
        for kind,value in self.documents.items():
            file=self.root/(kind+'.json');Q.write_json(file,value);paths[kind]=str(file)
        self.request={'schema_version':1,'source_sha256':Q.source_digest(),'identity_file':str(self.identity),
            'profile_directory':str(self.profile),'terraform':str(self.tf),'provider_directory':str(self.provider),
            'operation_name':PREFIX,'admin_ipv4_cidr':'8.8.8.8/32','ssh_public_key':B.SSH_KEY,
            'shutdown_deadline_utc':'2026-10-01T10:00:00Z','not_after_utc':'2026-10-01T08:20:00Z','evidence_paths':paths}
        self.input=self.root/'request.json';Q.write_json(self.input,self.request)
    def prepare(self):
        self.description=Q.prepare(self.input,NOW);self.directory=Path(self.description['directory'])
        self.args=(self.input,self.directory,self.description['state_sha256'],NOW)
        return self.description
    def complete_files(self):
        expected=self.expected
        values=[{'azure-cli':P.CLI_VERSION,'azure-cli-core':P.CLI_VERSION,'azure-cli-telemetry':'1','extensions':{}},[],
                {'id':SUB,'tenantId':expected['tenantId'],'state':'Enabled','environmentName':'AzureCloud'},
                {**expected,'state':'Enabled','subscriptionPolicies':{'quotaId':'AzureForStudents_2018-01-01','spendingLimit':'On'}}]
        for (label,_),value in zip(Q.P.commands(expected),values):Q.write_json(self.directory/('auth-'+label+'.json'),value)
        Q.write_json(self.directory/'version.json',{'terraform_version':'1.5.7','platform':'linux_amd64'})
        document=plan();variables=json.loads((self.directory/'work/inputs.tfvars.json').read_text())
        document['variables']={k:{'value':v} for k,v in variables.items()}
        Q.write_json(self.directory/'rendered.json',document)
        (self.directory/'plan.tfplan').write_bytes(b'private synthetic binary plan');(self.directory/'plan.tfplan').chmod(0o600)
        names=['prepare','auth-version','auth-extensions','auth-account','auth-subscription','authenticate','version','init','plan','show']
        phases=[{'phase':n,'completed':True,'exitCode':0} for n in names];phases[-1]['binaryPlanSha256']=A.sha((self.directory/'plan.tfplan').read_bytes())
        Q.write_json(self.directory/'phases.json',phases)
    def test_private_prepare_and_exact_offline_mirror(self):
        result=self.prepare();Q.verify(*self.args)
        self.assertEqual(set(result['azure']),{'path','sha256'})
        self.assertEqual(result['auth_commands'],Q.P.commands(self.expected))
        config=(self.directory/'terraform.rc').read_text()
        self.assertIn('filesystem_mirror',config);self.assertNotIn('direct',config)
        self.assertEqual(set(p.name for p in (self.directory/'work').iterdir()),set(Q.TF_FILES)|{'inputs.tfvars.json'})
        with self.assertRaises(FileExistsError):Q.prepare(self.input,NOW)
    def test_auth_extraction_retains_pure_exact_validation(self):
        self.prepare();self.complete_files();self.assertEqual(set(Q.authenticate(*self.args)),{'version','extensions','account','subscription'})
        file=self.directory/'auth-account.json';file.write_text('{}')
        with self.assertRaises(Q.A.Error):Q.authenticate(*self.args)
    def test_real_auditor_and_create_only_publication_retain_plan(self):
        self.prepare();self.complete_files();result=Q.finish(*self.args)
        self.assertTrue(result['completed']);self.assertEqual(set(p.name for p in self.directory.iterdir()),{'result.json','plan.tfplan','phases.json'})
        receipt=json.loads((self.directory/'result.json').read_text())
        self.assertEqual(receipt['resource_count'],11);self.assertEqual(receipt['binary_plan_sha256'],A.sha((self.directory/'plan.tfplan').read_bytes()))
        self.assertEqual((self.directory/'result.json').stat().st_mode&0o777,0o600)
        with self.assertRaises((Q.A.Error,OSError)):Q.finish(*self.args)
    def test_exact_existing_source_and_snapshot_reject_changed_inputs(self):
        self.prepare()
        paths=[self.identity,self.tf,self.profile/'config',self.root/'credit.json',self.provider/'LICENSE.txt',self.directory/'work/main.tf',self.directory/'session.json']
        for path in paths:
            raw=path.read_bytes();path.write_bytes(raw+b'\n')
            with self.subTest(path=path.name),self.assertRaises((Q.A.Error,ValueError)):Q.verify(*self.args)
            path.write_bytes(raw)
        Q.verify(*self.args)
    def test_missing_duplicate_stale_and_unsafe_request_rejected_before_directory(self):
        raw=self.input.read_bytes()
        variants=[{**self.request,'extra':1},{**self.request,'operation_name':'../other'},
                  {**self.request,'admin_ipv4_cidr':'127.0.0.1/32'},{**self.request,'source_sha256':'0'*64},
                  {**self.request,'not_after_utc':'2026-10-01T07:00:00Z'},
                  {**self.request,'evidence_paths':{}}]
        for value in variants:
            self.input.write_text(json.dumps(value))
            with self.subTest(value=value),self.assertRaises((Q.A.Error,ValueError)):Q.prepare(self.input,NOW)
            self.assertFalse((self.root/PREFIX).exists())
        self.input.write_bytes(raw[:-2]+b',"schema_version":1}\n')
        with self.assertRaises(Q.A.Error):Q.prepare(self.input,NOW)
        self.input.write_bytes(raw);self.input.chmod(0o644)
        with self.assertRaises(Q.A.Error):Q.prepare(self.input,NOW)
        self.input.chmod(0o600)
        with self.assertRaises(Q.A.Error):Q.prepare(self.input,NOW+timedelta(hours=5))
    def test_session_allowlist_link_and_aggregate_bounds(self):
        self.prepare();extra=self.directory/'unexpected';extra.write_text('x')
        with self.assertRaises(Q.A.Error):Q.verify(*self.args)
        extra.unlink();extra.symlink_to(self.identity)
        with self.assertRaises(Q.A.Error):Q.verify(*self.args)
        extra.unlink()
        output=self.directory/'rendered.json';output.write_bytes(b'123');output.chmod(0o600)
        with mock.patch.dict(Q.OUTPUTS,{'rendered.json':2}),self.assertRaises(Q.A.Error):Q.verify(*self.args)
        output.unlink()
        with mock.patch.object(Q,'MAX_AGGREGATE',2),self.assertRaises(Q.A.Error):Q.tree(self.directory)
        for i in range(97):(self.directory/('unexpected'+str(i))).touch(mode=0o600)
        with self.assertRaises(Q.A.Error):Q.tree(self.directory)
    def test_plan_policy_failure_and_cleanup_failure_never_publish(self):
        self.prepare();self.complete_files()
        file=self.directory/'rendered.json';raw=file.read_bytes();file.write_text('{}')
        with self.assertRaises(Q.A.Error):Q.finish(*self.args)
        file.write_bytes(raw)
        with mock.patch.object(Q.shutil,'rmtree',side_effect=OSError('PRIVATE_CANARY')),self.assertRaises(OSError):Q.finish(*self.args)
        self.assertFalse((self.directory/'result.json').exists());self.assertTrue((self.directory/'plan.tfplan').exists())
    def test_after_publication_failure_preserves_complete_result(self):
        self.prepare();self.complete_files();real=Q.A.publish_result
        def interrupted(path,result):real(path,result);raise Q.A.PublishedResultError('PRIVATE_CANARY')
        with mock.patch.object(Q.A,'publish_result',side_effect=interrupted),self.assertRaises(Q.A.PublishedResultError):Q.finish(*self.args)
        self.assertTrue(json.loads((self.directory/'result.json').read_text())['completed'])
        self.assertTrue((self.directory/'plan.tfplan').exists())
    def test_replaced_operation_is_not_cleaned_or_published(self):
        self.prepare();self.complete_files()
        original=self.directory;renamed=self.root/'retained-operation';original.rename(renamed)
        original.mkdir(mode=0o700)
        (original/'session.json').write_bytes((renamed/'session.json').read_bytes());(original/'session.json').chmod(0o600)
        with self.assertRaisesRegex(Q.A.Error,'operation or inputs changed'):Q.finish(*self.args)
        self.assertTrue((renamed/'plan.tfplan').exists());self.assertTrue((original/'session.json').exists())
    def test_binary_binding_and_requested_values_are_required(self):
        self.prepare();self.complete_files()
        binary=self.directory/'plan.tfplan';original=binary.read_bytes();binary.write_bytes(b'changed private binary')
        with self.assertRaises(Q.A.Error):Q.finish(*self.args)
        binary.write_bytes(original)
        file=self.directory/'rendered.json';value=json.loads(file.read_text())
        value['variables']['admin_ipv4_cidr']['value']='1.1.1.1/32'
        values={k:v['value'] for k,v in value['variables'].items()}
        for entry in value['resource_changes']:entry['change']['after']=Q.A.expected_values(values)[entry['address']]
        file.write_text(json.dumps(value))
        with self.assertRaisesRegex(Q.A.Error,'inputs differ'):Q.finish(*self.args)
        self.assertFalse((self.directory/'result.json').exists())
    def test_pure_helper_has_no_child_executor(self):
        import ast
        module=ast.parse((HERE/'prepare-plan-input.py').read_text())
        for node in ast.walk(module):
            if isinstance(node,ast.Import):self.assertFalse({'subprocess','resource'}&{n.name for n in node.names})
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute):self.assertNotIn(node.func.attr,{'run_json','Popen','system','audit_binary_plan'})


E = load("development_evidence", HERE / "collect-evidence.py")

def native_fixture():
    old = evidence(); documents = {}
    for kind in sorted(A.EVIDENCE_KINDS):
        commands = []
        for family, label, *_ in A.NATIVE_READS:
            if family != kind: continue
            value = selected(old, kind, label); raw = json.dumps(value) + '\n'
            commands.append({'format':A.NATIVE_FORMAT,'label':label,'arguments':A.native_arguments(label,SUB,PROFILE),
                'startedAt':'2026-10-01T07:00:00Z','endedAt':'2026-10-01T07:00:01Z','completed':True,'timedOut':False,'exitCode':0,
                'stdout':raw,'selected':value,'stdoutBytes':len(raw.encode()),'stdoutSha256':A.sha(raw.encode()),
                'stderrBytes':0,'stderrSha256':A.sha(b'')})
        documents[kind]={'format':A.NATIVE_FORMAT,'schemaVersion':2,'readOnly':True,'mutationAttempted':False,
                         'provenance':A.native_provenance(),'commands':commands}
    return documents

class NativeEvidencePolicy(unittest.TestCase):
    def accepts(self, docs): return A.evidence_values(docs,HASHES,SUB,NOW+timedelta(hours=2),NOW)
    def test_native_and_windows_facts_match_without_relabeling(self):
        self.assertEqual(self.accepts(native_fixture()),self.accepts(evidence()))
    def test_every_exact_native_argument_and_provenance_is_required(self):
        original=native_fixture()
        for kind,doc in original.items():
            for i,record in enumerate(doc['commands']):
                for index in range(len(record['arguments'])):
                    bad=copy.deepcopy(original);bad[kind]['commands'][i]['arguments'][index]+='-substituted'
                    with self.subTest(kind=kind,label=record['label'],index=index),self.assertRaises(A.Error):self.accepts(bad)
            for key in doc['provenance']:
                bad=copy.deepcopy(original);bad[kind]['provenance'][key]='unreviewed'
                with self.subTest(kind=kind,key=key),self.assertRaises(A.Error):self.accepts(bad)
    def test_original_raw_response_and_actual_diagnostic_metadata_are_bound(self):
        for key,value in [('stdout','{}'),('selected',{}),('stdoutBytes',0),('stdoutSha256','0'*64),
                          ('stderrBytes',-1),('stderrBytes',65537),('stderrSha256','0'*64),('completed',False),
                          ('exitCode',True),('exitCode',False),('exitCode',0.0),('startedAt','2026-09-30T01:00:00Z'),('endedAt','2026-10-01T09:00:00Z')]:
            bad=native_fixture();bad['credit']['commands'][0][key]=value
            with self.subTest(key=key,value=value),self.assertRaises(A.Error):self.accepts(bad)
        bad=native_fixture();item=bad['credit']['commands'][0];item['stdout']='{"duplicate":1,"duplicate":2}';item['stdoutBytes']=len(item['stdout']);item['stdoutSha256']=A.sha(item['stdout'].encode())
        with self.assertRaises(A.Error):self.accepts(bad)
    def test_native_raw_binding_preserves_nested_json_types(self):
        for original,substituted in [(0,False),(1,True),(1,1.0),({'items':[0]},{'items':[False]})]:
            bad=native_fixture();item=bad['credit']['commands'][0]
            item['selected']['bindingProbe']=original
            item['stdout']=json.dumps(item['selected']);item['stdoutBytes']=len(item['stdout'].encode());item['stdoutSha256']=A.sha(item['stdout'].encode())
            item['selected']['bindingProbe']=substituted
            with self.subTest(original=original,substituted=substituted),self.assertRaises(A.Error):self.accepts(bad)
    def test_mixed_unknown_partial_and_extra_formats_are_rejected(self):
        for mode in ['mixed','unknown','numeric-schema','missing','extra','legacy-native-item','unknown-legacy-schema']:
            bad=native_fixture()
            if mode=='mixed':bad['credit']=evidence()['credit']
            if mode=='unknown':bad['credit']['format']='other'
            if mode=='numeric-schema':bad['credit']['schemaVersion']=2.0
            if mode=='missing':bad['credit']['commands'].pop()
            if mode=='extra':bad['credit']['commands'].append(copy.deepcopy(bad['credit']['commands'][0]))
            if mode=='legacy-native-item':bad=evidence();bad['providers']['commands'][0]['format']=A.NATIVE_FORMAT
            if mode=='unknown-legacy-schema':bad=evidence();bad['credit']['schemaVersion']=3
            with self.subTest(mode=mode),self.assertRaises(A.Error):self.accepts(bad)
    def test_each_family_value_gate_survives_raw_receipt_rebinding(self):
        changes=[('providers','after-subscription-policy',('subscriptionPolicies','spendingLimit'),'Off'),
                 ('providers','after-billing-property',('billingProfileStatus',),'Inactive'),
                 ('compute','after-compute-registration-once',('registrationState',),'NotRegistered'),
                 ('credit','credit-balance-summary',('balanceSummary','currentBalance','value'),19),
                 ('credit','credit-lots',('hasNext',),True),
                 ('quota','centralus-positive-and-arm-family-quotas',('hasNext',),True),
                 ('sku','centralus-Standard_B4ps_v2-exact',('nextLink',),'https://foreign.invalid'),
                 ('image','selected-exact-CentralUS-Canonical-Arm64-image',('architecture',),'x64')]
        for kind,label,path,value in changes:
            bad=native_fixture();item=next(x for x in bad[kind]['commands'] if x['label']==label)
            setpath(item['selected'],path,value);item['stdout']=json.dumps(item['selected']);item['stdoutBytes']=len(item['stdout'].encode());item['stdoutSha256']=A.sha(item['stdout'].encode())
            with self.subTest(kind=kind,label=label),self.assertRaises(A.Error):self.accepts(bad)
    def test_billing_paths_cannot_inject_or_redirect(self):
        for value in [None,PROFILE+'?x=1',PROFILE+'#fragment',PROFILE+'/extra',PROFILE.replace('synthetic','..',1),PROFILE+'%2fother','https://foreign.invalid']:
            with self.subTest(value=value),self.assertRaises(A.Error):A.native_arguments('credit-lots',SUB,value)

class EvidencePreparation(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='nourishing-evidence-fixture-',dir=Path.home());self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name);self.profile=self.root/'profile';self.profile.mkdir(mode=0o700)
        config=configparser.ConfigParser();config.read_dict(P.SETTINGS)
        with (self.profile/'config').open('w') as out:config.write(out)
        (self.profile/'config').chmod(0o600);(self.profile/'clouds.config').write_text('[AzureCloud]\nsubscription = '+SUB+'\n');(self.profile/'clouds.config').chmod(0o600)
        self.expected={'subscriptionId':SUB,'tenantId':'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}
        self.identity=self.root/'identity.json';E.write_json(self.identity,self.expected)
        self.request={'schema_version':1,'source_sha256':E.A.native_source_digest(),'identity_file':str(self.identity),
            'profile_directory':str(self.profile),'operation_name':'nourishing-evidence-0123456789ab',
            'not_after_utc':'2026-10-01T08:12:00Z','shutdown_deadline_utc':'2026-10-01T10:00:00Z'}
        self.input=self.root/'request.json';E.write_json(self.input,self.request)
        patch=mock.patch.object(E.P,'tool_digest',return_value=(P.CLI_SHA256,100));patch.start();self.addCleanup(patch.stop)
    def prepare(self):
        description=E.prepare(self.input,NOW-timedelta(seconds=5));self.directory=Path(description['directory'])
        self.args=(self.input,self.directory,description['state_sha256'],NOW);return description
    def complete_files(self):
        auth=[{'azure-cli':P.CLI_VERSION,'azure-cli-core':P.CLI_VERSION,'azure-cli-telemetry':'1','extensions':{}},[],
              {'id':SUB,'tenantId':self.expected['tenantId'],'state':'Enabled','environmentName':'AzureCloud'},
              {**self.expected,'state':'Enabled','subscriptionPolicies':{'quotaId':'AzureForStudents_2018-01-01','spendingLimit':'On'}}]
        phases=[]
        def put(label,args,value):
            file=self.directory/(label+'.json');E.write_json(file,value);raw=file.read_bytes()
            phases.append({'label':label,'arguments':args,'executableSha256':P.CLI_SHA256,'startedAt':'2026-10-01T08:00:00Z','endedAt':'2026-10-01T08:00:00Z',
                'completed':True,'exitCode':0,'stdoutBytes':len(raw),'stdoutSha256':A.sha(raw),'stderrBytes':0,'stderrSha256':A.sha(b'')})
        for (label,args),value in zip(E.P.commands(self.expected),auth):put('auth-'+label,args+['--only-show-errors','--output','json'],value)
        old=evidence()
        for kind,label,*_ in A.NATIVE_READS:put('read-'+label,A.native_arguments(label,SUB,PROFILE),selected(old,kind,label))
        E.write_json(self.directory/'phases.json',phases)
    def test_complete_private_index_binds_six_families_and_retains_inputs(self):
        description=self.prepare();self.complete_files();result=E.finish(*self.args)
        self.assertTrue(result['completed']);index,_=E.A.private_json(self.directory/'index.json')
        self.assertEqual(set(index['evidence_sha256']),A.EVIDENCE_KINDS)
        for kind,digest in index['evidence_sha256'].items():self.assertEqual(E.A.private_json(self.directory/(kind+'.json'))[1],digest)
        self.assertTrue((self.directory/'session.json').exists());self.assertEqual(description['azure']['path'],'/usr/bin/az')
        with self.assertRaises(FileExistsError):E.finish(*self.args)
    def test_authentication_precedes_all_collection_and_billing_precedes_credit(self):
        self.prepare()
        with self.assertRaises(E.A.Error):E.requests(*self.args)
        self.complete_files();self.assertEqual(len(E.requests(*self.args)),2);self.assertEqual(len(E.requests(*self.args,remaining=True)),8)
        path=self.directory/'auth-account.json';raw=path.read_bytes();path.write_text('{}')
        with self.assertRaises(E.A.Error):E.requests(*self.args)
        path.write_bytes(raw);path=self.directory/'read-after-billing-property.json';value=json.loads(path.read_text());value['billingProfileId']=PROFILE+'?foreign=1';path.write_text(json.dumps(value))
        with self.assertRaises(E.A.Error):E.requests(*self.args,remaining=True)
    def test_request_profile_identity_source_and_session_are_conserved(self):
        self.prepare()
        for path in [self.identity,self.input,self.profile/'config',self.directory/'session.json']:
            raw=path.read_bytes();path.write_bytes(raw+b'\n')
            with self.subTest(path=path.name),self.assertRaises(E.A.Error):E.verify(*self.args)
            path.write_bytes(raw)
        with mock.patch.object(E.A,'native_source_digest',return_value='0'*64),self.assertRaises(E.A.Error):E.verify(*self.args)
        with mock.patch.object(E.P,'tool_digest',return_value=('0'*64,100)),self.assertRaises(E.A.Error):E.verify(*self.args)
    def test_wrong_request_deadline_modes_duplicates_and_existing_operation_rejected(self):
        raw=self.input.read_bytes()
        for key,value in [('schema_version',True),('schema_version',1.0),('operation_name','../other'),('not_after_utc','2026-10-01T07:00:00Z'),('not_after_utc','2026-10-01T09:00:00Z'),
                          ('shutdown_deadline_utc','2026-10-02T10:00:00Z'),('shutdown_deadline_utc','2026-10-01T10:00:01Z')]:
            self.input.write_text(json.dumps({**self.request,key:value}))
            with self.subTest(key=key),self.assertRaises(E.A.Error):E.prepare(self.input,NOW)
        self.input.write_bytes(raw[:-2]+b',"schema_version":1}\n')
        with self.assertRaises(E.A.Error):E.prepare(self.input,NOW)
        self.input.write_bytes(raw);self.input.chmod(0o644)
        with self.assertRaises(E.A.Error):E.prepare(self.input,NOW)
        self.input.chmod(0o600);self.prepare()
        with self.assertRaises(FileExistsError):E.prepare(self.input,NOW)
    def test_unexpected_links_scratch_and_aggregate_are_rejected(self):
        self.prepare();file=self.directory/'unexpected';file.write_text('PRIVATE_CANARY')
        with self.assertRaises(E.A.Error):E.verify(*self.args)
        file.unlink();file=self.directory/'auth-version.json';file.symlink_to(self.identity)
        with self.assertRaises(E.A.Error):E.verify(*self.args)
        file.unlink();(self.directory/'tmp/extra').write_text('PRIVATE_CANARY')
        with self.assertRaises(E.A.Error):E.verify(*self.args)
        (self.directory/'tmp/extra').unlink()
        with mock.patch.object(E,'MAX_AGGREGATE',1),self.assertRaises(E.A.Error):E.verify(*self.args)
    def test_partial_nonzero_missing_stale_and_mutated_phases_never_publish(self):
        self.prepare();self.complete_files();file=self.directory/'phases.json';raw=file.read_bytes()
        changes=[lambda p:p.pop(),lambda p:p[0].update(exitCode=1),lambda p:p[0].update(stderrBytes=-1),
                 lambda p:p[0].update(startedAt='2026-10-01T09:00:00Z'),lambda p:p[0].update(stdoutSha256='0'*64),
                 lambda p:p[4]['arguments'].append('--debug')]
        for change in changes:
            value=json.loads(raw);change(value);file.write_text(json.dumps(value))
            with self.subTest(change=change),self.assertRaises(E.A.Error):E.finish(*self.args)
            self.assertFalse((self.directory/'index.json').exists())
        file.write_bytes(raw);path=self.directory/'read-credit-lots.json';path.write_text('{}')
        with self.assertRaises(E.A.Error):E.finish(*self.args)
        self.assertFalse((self.directory/'index.json').exists())
    def test_family_publication_failure_and_uncertain_index_are_explicit(self):
        self.prepare();self.complete_files();real=E.write_json
        def reject(path,value):
            if path.name=='providers.json':raise OSError('PRIVATE_CANARY')
            return real(path,value)
        with mock.patch.object(E,'write_json',side_effect=reject),self.assertRaises(OSError):E.finish(*self.args)
        self.assertFalse((self.directory/'index.json').exists());self.assertTrue((self.directory/'credit.json').exists())
        for kind in A.EVIDENCE_KINDS:(self.directory/(kind+'.json')).unlink(missing_ok=True)
        real_publish=E.A.publish_result
        def uncertain(path,value):real_publish(path,value);raise E.A.PublishedResultError('PRIVATE_CANARY')
        with mock.patch.object(E.A,'publish_result',side_effect=uncertain),self.assertRaises(E.A.PublishedResultError):E.finish(*self.args)
        self.assertTrue(json.loads((self.directory/'index.json').read_text())['completed'])
    def test_sanitized_failure_and_pure_helper_no_spawning(self):
        stream=io.StringIO()
        with mock.patch.object(E,'prepare',side_effect=OSError('PRIVATE_CANARY')),contextlib.redirect_stderr(stream):self.assertEqual(E.main(['prepare',str(self.input)]),1)
        self.assertNotIn('PRIVATE_CANARY',stream.getvalue());self.assertIn('partial or published',stream.getvalue())
        import ast
        for node in ast.walk(ast.parse((HERE/'collect-evidence.py').read_text())):
            if isinstance(node,ast.Import):self.assertFalse({'subprocess','resource'}&{n.name for n in node.names})
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute):self.assertNotIn(node.func.attr,{'Popen','system','run_json','preflight','audit_binary_plan'})




S = load("development_session", HERE / "session-policy.py")


def session_responses(document):
    """Hand-built ARM/state fixtures, never requests or Terraform execution."""
    values={k:v['value'] for k,v in document['variables'].items()}
    base='/subscriptions/'+SUB+'/resourceGroups/'+PREFIX+'-rg'
    owned={'group':base,'vnet':base+'/providers/Microsoft.Network/virtualNetworks/'+PREFIX+'-vnet',
        'subnet':base+'/providers/Microsoft.Network/virtualNetworks/'+PREFIX+'-vnet/subnets/'+PREFIX+'-subnet',
        'nsg':base+'/providers/Microsoft.Network/networkSecurityGroups/'+PREFIX+'-nsg',
        'pip':base+'/providers/Microsoft.Network/publicIPAddresses/'+PREFIX+'-pip',
        'nic':base+'/providers/Microsoft.Network/networkInterfaces/'+PREFIX+'-nic',
        'vm':base+'/providers/Microsoft.Compute/virtualMachines/'+PREFIX+'-vm',
        'os':base+'/providers/Microsoft.Compute/disks/'+PREFIX+'-os',
        'data':base+'/providers/Microsoft.Compute/disks/'+PREFIX+'-data',
        'schedule':base+'/providers/Microsoft.DevTestLab/schedules/shutdown-computevm-'+PREFIX+'-vm'}
    mapping={'azurerm_resource_group.development':'group','azurerm_virtual_network.development':'vnet',
        'azurerm_subnet.development':'subnet','azurerm_network_security_group.development':'nsg',
        'azurerm_public_ip.development':'pip','azurerm_network_interface.development':'nic',
        'azurerm_linux_virtual_machine.development':'vm','azurerm_managed_disk.data':'data',
        'azurerm_dev_test_global_vm_shutdown_schedule.development':'schedule'}
    resources=[]
    for entry in document['resource_changes']:
        address=entry['address'];v=copy.deepcopy(entry['change']['after'])
        v['id']=owned[mapping[address]] if address in mapping else owned['subnet'] if 'association' in address else owned['vm']+'/dataDisks/'+PREFIX+'-data'
        resources.append({'address':address,'mode':'managed','type':entry['type'],'name':entry['name'],
            'provider_name':A.PROVIDER,'schema_version':A.SCHEMAS[address],'values':v})
    by={r['address']:r['values'] for r in resources}
    for address,path,target in A.REFERENCES:
        expected=by[target.rsplit('.',1)[0]]['id']
        setpath(by[address],path,[expected] if path==('network_interface_ids',) else expected)
    by['azurerm_linux_virtual_machine.development']['os_disk'][0]['id']=owned['os']
    state={'format_version':'1.0','terraform_version':'1.5.7','values':{'root_module':{'resources':resources}}}
    raw={'version':4,'terraform_version':'1.5.7','serial':1,'lineage':'12345678-aaaa-bbbb-cccc-0123456789ab','outputs':{},
        'resources':[{'mode':'managed','type':r['type'],'name':r['name'],'provider':'provider["'+A.PROVIDER+'"]',
            'instances':[{'schema_version':r['schema_version'],'attributes':r['values']}]} for r in resources]}
    live={}
    for index,(key,resource_id) in enumerate(owned.items()):
        props={'provisioningState':'Succeeded'}
        field='vmId' if key=='vm' else 'uniqueId' if key in ('os','data') else 'uniqueIdentifier' if key=='schedule' else 'resourceGuid'
        if key not in ('group','subnet'):props[field]='11111111-aaaa-bbbb-cccc-'+str(index).zfill(12)
        live[key]={'id':resource_id,'location':'centralus','properties':props}
    by['azurerm_linux_virtual_machine.development']['virtual_machine_id']=live['vm']['properties']['vmId']
    by['azurerm_virtual_network.development']['guid']=live['vnet']['properties']['resourceGuid']
    live['members']={'value':[{'id':v} for k,v in owned.items() if k not in ('group','subnet')]}
    live['extensions']={'value':[]}
    live['vm']['properties'].update(hardwareProfile={'vmSize':'Standard_B4ps_v2'},networkProfile={'networkInterfaces':[{'id':owned['nic']}]},
        storageProfile={'osDisk':{'managedDisk':{'id':owned['os']}},'dataDisks':[{'lun':0,'managedDisk':{'id':owned['data']}}]})
    for key in ('os','data'):
        live[key].update(managedBy=owned['vm'],sku={'name':'StandardSSD_LRS'});live[key]['properties']['diskSizeGB']=64
    configuration=owned['nic']+'/ipConfigurations/primary'
    live['subnet']['properties'].update(networkSecurityGroup={'id':owned['nsg']},addressPrefix='10.43.1.0/24',ipConfigurations=[{'id':configuration}])
    live['vnet']['properties'].update(addressSpace={'addressPrefixes':['10.43.0.0/16']},subnets=[{'id':owned['subnet']}],virtualNetworkPeerings=[])
    live['nic']['properties'].update(virtualMachine={'id':owned['vm']},enableIPForwarding=False,enableAcceleratedNetworking=False,
        ipConfigurations=[{'name':'primary','id':configuration,'properties':{'subnet':{'id':owned['subnet']},'publicIPAddress':{'id':owned['pip']}}}])
    live['pip'].update(sku={'name':'Standard'});live['pip']['properties'].update(publicIPAllocationMethod='Static',publicIPAddressVersion='IPv4',ipConfiguration={'id':configuration})
    fields={'priority':'priority','direction':'direction','access':'access','protocol':'protocol','source_port_range':'sourcePortRange',
        'destination_port_range':'destinationPortRange','source_address_prefix':'sourceAddressPrefix','destination_address_prefix':'destinationAddressPrefix'}
    live['nsg']['properties'].update(subnets=[{'id':owned['subnet']}],securityRules=[{'name':r['name'],'properties':{
        'provisioningState':'Succeeded',**{arm:r[key] for key,arm in fields.items()}}} for r in after(document,'azurerm_network_security_group.development')['security_rule']])
    live['schedule']['properties'].update(status='Enabled',taskType='ComputeVmShutdownTask',targetResourceId=owned['vm'],timeZoneId='UTC',
        dailyRecurrence={'time':'1000'},notificationSettings={'status':'Disabled'})
    destroy={'format_version':'1.2','terraform_version':'1.5.7','timestamp':NOW.isoformat().replace('+00:00','Z'),
        'configuration':document['configuration'],'prior_state':state,'planned_values':{'root_module':{}},
        'resource_changes':[{k:r[k] for k in ('address','mode','type','name','provider_name')}|{
            'change':{'actions':['delete'],'before':r['values'],'after':None,'after_unknown':False}} for r in resources]}
    return {'create':document,'state':state,'raw':raw,'live':live,'destroy':destroy}


class SessionPolicy(unittest.TestCase):
    def setUp(self):
        PlanPreparation.setUp(self)
        for owner,name,value in [(S.A,'TF_SHA256',A.sha(self.tf.read_bytes())),(S.A,'PROVIDER_FILES',Q.A.PROVIDER_FILES)]:
            patch=mock.patch.object(owner,name,value);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(S.P,'tool_digest',return_value=(P.CLI_SHA256,100));patch.start();self.addCleanup(patch.stop)
        PlanPreparation.prepare(self);PlanPreparation.complete_files(self)
        phases=json.loads((self.directory/'phases.json').read_text())
        for phase in phases:phase.update(startedAt=NOW.isoformat(),endedAt=NOW.isoformat())
        (self.directory/'phases.json').write_text(json.dumps(phases)+'\n')
        self.responses=session_responses(json.loads((self.directory/'rendered.json').read_text()))
        self.rendered_raw=(self.directory/'rendered.json').read_bytes()
        Q.finish(*self.args)
        self.plan_input=self.input;self.plan_directory=self.directory
        self.request={'schema_version':1,'source_sha256':S.source_digest(),'operation_name':'nourishing-session-0123456789ab',
            'not_after_utc':'2026-10-01T08:18:00Z','plan_request':str(self.plan_input),'plan_result':str(self.plan_directory/'result.json'),
            'plan_result_sha256':A.sha((self.plan_directory/'result.json').read_bytes())}
        self.input=self.root/'session-request.json';Q.write_json(self.input,self.request)
    def prepare(self,mode='execute'):
        self.description=S.prepare(mode,self.input,NOW);self.directory=Path(self.description['directory'])
        self.args=(mode,self.input,self.directory,self.description['state_sha256'],NOW)
        Q.write_json(self.directory/'version.json',{'terraform_version':'1.5.7','platform':'linux_amd64'})
    def auth(self):
        values=[{'azure-cli':P.CLI_VERSION,'azure-cli-core':P.CLI_VERSION,'azure-cli-telemetry':'1','extensions':{}},[],
            {'id':SUB,'tenantId':self.expected['tenantId'],'state':'Enabled','environmentName':'AzureCloud'},
            {**self.expected,'state':'Enabled','subscriptionPolicies':{'quotaId':'AzureForStudents_2018-01-01','spendingLimit':'On'}}]
        for (label,_),value in zip(P.commands(self.expected),values):Q.write_json(self.directory/('auth-'+label+'.json'),value)
    def material(self,prefix='after'):
        file=self.directory/'work/terraform.tfstate'
        if file.exists():file.write_text(json.dumps(self.responses['raw'],sort_keys=True)+'\n')
        else:Q.write_json(file,self.responses['raw'])
        Q.write_json(self.directory/'state.json',self.responses['state'])
        for name,value in self.responses['live'].items():Q.write_json(self.directory/(prefix+'-'+name+'.json'),value)
    def fresh(self):
        name='nourishing-evidence-'+self.request['operation_name'].rsplit('-',1)[1]
        directory=self.directory/name;directory.mkdir(mode=0o700)
        documents=native_fixture();hashes={}
        for kind,value in documents.items():Q.write_json(directory/(kind+'.json'),value);hashes[kind]=A.sha((directory/(kind+'.json')).read_bytes())
        Q.write_json(directory/'index.json',{'completed':True,'source_sha256':A.native_source_digest(),'evidence_sha256':hashes})
    def phase_receipt(self,mode=None):
        """Synthetic successful observations; mutation tests corrupt these retained records."""
        mode=mode or self.args[0];directory=self.directory;descriptor='/proc/123/fd/4'
        tool=A.sha(self.tf.read_bytes());rows=[]
        if mode!='execute':rows += [('auth-'+n,P.CLI_SHA256,[*args,'--only-show-errors','--output','json'],'auth-'+n+'.json') for n,args in P.commands(self.expected)]
        rows += [('version',tool,['version','-json'],'version.json'),('init',tool,['init','-backend=false','-lockfile=readonly','-input=false','-no-color'],'init.stdout')]
        if mode!='execute':
            rows.append(('state',tool,['show','-json',str(directory/'work/terraform.tfstate')],'state.json'))
            rows += [('before-'+r['label'],P.CLI_SHA256,r['arguments'],'before-'+r['label']+'.json') for r in S.read_commands({k:x['value'] for k,x in self.responses['create']['variables'].items()},'resources')]
        if mode=='prepare-dispose':
            rows += [('prepare-dispose',tool,['plan','-destroy','-input=false','-no-color','-lock-timeout=0s','-parallelism=1','-var-file=inputs.tfvars.json','-out='+str(directory/'destroy.tfplan')],'prepare-dispose.stdout'),('show-dispose',tool,['show','-json',descriptor],'rendered.json')]
            binary=directory/'destroy.tfplan'
        else:
            rows.append(('show',tool,['show','-json',descriptor],'rendered.json'))
            if mode=='execute':rows += [('before-'+r['label'],P.CLI_SHA256,r['arguments'],'before-'+r['label']+'.json') for r in S.read_commands({k:x['value'] for k,x in self.responses['create']['variables'].items()},'groups')]
            rows += [('apply',tool,['apply','-input=false','-no-color','-lock-timeout=0s','-parallelism=1',descriptor],'apply.stdout'),('state-after',tool,['show','-json',str(directory/'work/terraform.tfstate')],'state.json' if mode=='execute' else 'final-state.json')]
            rows += [('after-'+r['label'],P.CLI_SHA256,r['arguments'],'after-'+r['label']+'.json') for r in S.read_commands({k:x['value'] for k,x in self.responses['create']['variables'].items()},'resources' if mode=='execute' else 'groups')]
            binary=self.plan_directory/'plan.tfplan' if mode=='execute' else Path(json.loads(self.disposal.read_text())['binary_plan_path'])
        phases=[]
        for label,executable,args,output in rows:
            path=directory/output
            if output.endswith('.stdout') and not path.exists():path.write_bytes(b'synthetic process output');path.chmod(0o600)
            raw=path.read_bytes()
            phase={'phase':label,'completed':True,'exitCode':0,'startedAt':NOW.isoformat(),'endedAt':NOW.isoformat(),
                'executableSha256':executable,'arguments':args,'argumentsSha256':A.sha(json.dumps(args,separators=(',',':')).encode()),
                'stdoutBytes':len(raw),'stdoutSha256':A.sha(raw)}
            if label in ('show','show-dispose','apply'):phase['binaryPlanSha256']=A.sha(binary.read_bytes())
            phases.append(phase)
        target=directory/'phases.json'
        if target.exists():target.write_text(json.dumps(phases)+'\n')
        else:Q.write_json(target,phases)
        return phases

    def execute_complete(self):
        self.prepare();self.fresh();(self.directory/'rendered.json').write_bytes(self.rendered_raw);(self.directory/'rendered.json').chmod(0o600)
        Q.write_json(self.directory/'before-groups.json',{'value':[]});S.intent(*self.args)
        self.material();self.phase_receipt()
        result=S.finish(*self.args);self.ownership=self.directory/'result.json';return result
    def deletion_request(self,mode,reference_path):
        key='ownership' if mode=='prepare-dispose' else 'disposal'
        self.request={'schema_version':1,'source_sha256':S.source_digest(),'operation_name':'nourishing-session-'+('a'*12 if mode=='prepare-dispose' else 'b'*12),
            'not_after_utc':'2026-10-01T08:18:00Z',key+'_result':str(reference_path),key+'_result_sha256':A.sha(reference_path.read_bytes())}
        self.input=self.root/(mode+'-request.json');Q.write_json(self.input,self.request);self.prepare(mode);self.auth();self.material('before')
    def prepare_deletion(self):
        self.execute_complete();self.deletion_request('prepare-dispose',self.ownership)
        S.audit(*self.args);Q.write_json(self.directory/'rendered.json',self.responses['destroy'])
        (self.directory/'destroy.tfplan').write_bytes(b'synthetic destruction plan');(self.directory/'destroy.tfplan').chmod(0o600)
        self.phase_receipt();S.finish(*self.args)
        self.disposal=self.directory/'result.json'
    def test_source_digest_and_successful_owned_execute_keep_private_state(self):
        result=self.execute_complete();self.assertTrue(result['completed'])
        receipt,_=S.private(self.ownership);self.assertEqual(receipt['generations']['vm'],self.responses['live']['vm']['properties']['vmId'])
        self.assertEqual(len(receipt['ids']),10);self.assertEqual(receipt['serial'],1)
        self.assertTrue((self.directory/'mutation-intent.json').exists());self.assertTrue((self.directory/'work/terraform.tfstate').exists())
    def test_saved_deletion_requires_separate_review_and_dispose_verifies_absence(self):
        self.prepare_deletion();self.assertFalse((self.directory/'mutation-intent.json').exists())
        self.deletion_request('dispose',self.disposal)
        Q.write_json(self.directory/'rendered.json',self.responses['destroy']);S.intent(*self.args)
        final={**self.responses['raw'],'serial':2,'resources':[]};(self.directory/'work/terraform.tfstate').write_text(json.dumps(final)+'\n')
        Q.write_json(self.directory/'final-state.json',{'format_version':'1.0','terraform_version':'1.5.7'})
        Q.write_json(self.directory/'after-groups.json',{'value':[]});self.phase_receipt()
        self.assertTrue(S.finish(*self.args)['completed']);self.assertTrue(S.private(self.directory/'result.json')[0]['disposed'])
        self.assertTrue(self.ownership.exists());self.assertTrue(self.disposal.exists())
    def test_rejects_altered_source_plan_provider_and_expired_request_before_session(self):
        for file in [self.plan_directory/'plan.tfplan',self.provider/'LICENSE.txt',self.identity,self.tf]:
            original=file.read_bytes();file.write_bytes(original+b'\n')
            with self.subTest(path=file.name),self.assertRaises((S.A.Error,ValueError)):S.prepare('execute',self.input,NOW)
            file.write_bytes(original)
        with mock.patch.object(S,'source_digest',return_value='0'*64),self.assertRaises(S.A.Error):S.prepare('execute',self.input,NOW)
        with self.assertRaises(S.A.Error):S.prepare('execute',self.input,NOW+timedelta(hours=1))
        self.assertFalse((self.root/self.request['operation_name']).exists())
    def test_foreign_missing_replaced_pending_and_wrong_shutdown_are_rejected(self):
        original=self.responses['live'];v={k:x['value'] for k,x in self.responses['create']['variables'].items()}
        mutations=[lambda d:d['members']['value'].append({'id':'/foreign'}),lambda d:d['members'].update(nextLink='https://other'),
            lambda d:d['vm']['properties'].update(vmId=None),lambda d:d['os']['properties'].update(provisioningState='Updating'),
            lambda d:d['schedule']['properties'].update(targetResourceId='/foreign'),lambda d:d['schedule']['properties'].update(status='Disabled'),
            lambda d:d['schedule']['properties']['notificationSettings'].update(webhookUrl='https://foreign'),
            lambda d:d['vnet']['properties']['subnets'].append({'id':'/foreign'}),lambda d:d['nic']['properties']['ipConfigurations'].append({}),
            lambda d:d['nsg']['properties']['securityRules'][0]['properties'].update(sourceAddressPrefix='*')]
        for change_live in mutations:
            value=copy.deepcopy(original);change_live(value)
            with self.subTest(change=change_live),self.assertRaises(S.A.Error):S.live_graph(value,v)
        first=S.live_graph(original,v);changed=copy.deepcopy(first);changed['generations']['vm']='f'*32
        state={'lineage':'x','serial':1,'state_sha256':'a'}
        with self.assertRaises(S.A.Error):S.same_owned(first|state,changed|state)
    def test_partial_or_ambiguous_state_and_changed_deletion_plan_reject(self):
        self.prepare_deletion();saved=self.directory/'work/terraform.tfstate';raw=saved.read_bytes();saved.write_text('{}')
        with self.assertRaises(S.A.Error):S.load_request('dispose',self._dispose_input(),NOW)
        saved.write_bytes(raw)
        state=self.responses['state'];original={'values':{k:x['value'] for k,x in self.responses['create']['variables'].items()}}
        mutations=[lambda d:d['resource_changes'].pop(),lambda d:d['resource_changes'][0]['change'].update(actions=['create']),
            lambda d:d['resource_changes'][0]['change']['before'].update(id='/foreign'),lambda d:d.update(timestamp='2026-10-01T07:00:00Z')]
        for mutate in mutations:
            value=copy.deepcopy(self.responses['destroy']);mutate(value)
            with self.subTest(change=mutate),self.assertRaises(S.A.Error):S.audit_destroy(value,state,original,NOW)
    def _dispose_input(self):
        path=self.root/'dispose-check.json';value={'schema_version':1,'source_sha256':S.source_digest(),'operation_name':'nourishing-session-'+'f'*12,
            'not_after_utc':'2026-10-01T08:18:00Z','disposal_result':str(self.disposal),'disposal_result_sha256':A.sha(self.disposal.read_bytes())}
        Q.write_json(path,value);return path
    def test_mutation_failure_and_publication_uncertainty_preserve_recovery_material(self):
        self.prepare();self.fresh();(self.directory/'rendered.json').write_bytes(self.rendered_raw);(self.directory/'rendered.json').chmod(0o600)
        Q.write_json(self.directory/'before-groups.json',{'value':[]});S.intent(*self.args)
        self.assertEqual(S.private(self.directory/'mutation-intent.json')[0]['outcome'],'unknown-until-reconciled')
        Q.write_json(self.directory/'phases.json',[{'completed':False,'exitCode':1}])
        with self.assertRaises(S.A.Error):S.finish(*self.args)
        self.assertFalse((self.directory/'result.json').exists());self.assertTrue((self.plan_directory/'plan.tfplan').exists())
        (self.directory/'phases.json').write_text(json.dumps([{'completed':True,'exitCode':0}]))
        self.material();self.phase_receipt();real=S.A.publish_result
        def reject(path,value):real(path,value);raise S.A.PublishedResultError('PRIVATE_CANARY')
        with mock.patch.object(S.A,'publish_result',side_effect=reject),self.assertRaises(S.A.PublishedResultError):S.finish(*self.args)
        self.assertTrue(S.private(self.directory/'result.json')[0]['completed']);self.assertTrue((self.directory/'work/terraform.tfstate').exists())
    def test_unsafe_state_links_extra_files_and_post_command_aggregate_reject(self):
        self.prepare();file=self.directory/'work/terraform.tfstate';file.symlink_to(self.identity)
        with self.assertRaises(S.A.Error):S.verify(*self.args)
        file.unlink();Q.write_json(self.directory/'unexpected.json',{})
        with self.assertRaises(S.A.Error):S.verify(*self.args)
        (self.directory/'unexpected.json').unlink()
        with mock.patch.object(S.Q,'MAX_AGGREGATE',1),self.assertRaises(S.A.Error):S.verify(*self.args)
    def test_sanitized_rejection_does_not_print_private_values(self):
        output=io.StringIO()
        with mock.patch.object(S,'prepare',side_effect=OSError('PRIVATE_CANARY')),contextlib.redirect_stderr(output):
            self.assertEqual(S.main(['prepare','execute',str(self.input)]),1)
        self.assertNotIn('PRIVATE_CANARY',output.getvalue());self.assertIn('remote outcome',output.getvalue())


    def test_review_rejects_empty_intent_and_unrelated_completion_phase(self):
        self.prepare();self.fresh();(self.directory/'rendered.json').write_bytes(self.rendered_raw);(self.directory/'rendered.json').chmod(0o600)
        Q.write_json(self.directory/'before-groups.json',{'value':[]});S.intent(*self.args);self.material()
        (self.directory/'mutation-intent.json').write_text('{}')
        Q.write_json(self.directory/'phases.json',[{'phase':'unrelated','completed':True,'exitCode':0}])
        with self.assertRaises(S.A.Error):S.finish(*self.args)
        self.assertFalse((self.directory/'result.json').exists())
    def test_review_rejects_conflicting_state_and_live_generations(self):
        self.prepare();self.fresh();(self.directory/'rendered.json').write_bytes(self.rendered_raw);(self.directory/'rendered.json').chmod(0o600)
        Q.write_json(self.directory/'before-groups.json',{'value':[]});S.intent(*self.args)
        resources={r['address']:r['values'] for r in self.responses['state']['values']['root_module']['resources']}
        resources['azurerm_linux_virtual_machine.development']['virtual_machine_id']='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        resources['azurerm_virtual_network.development']['guid']='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
        self.material();self.phase_receipt()
        with self.assertRaises(S.A.Error):S.finish(*self.args)
        self.assertFalse((self.directory/'result.json').exists())

    def test_completion_rejects_each_missing_changed_or_unbound_observation(self):
        self.prepare();self.fresh();(self.directory/'rendered.json').write_bytes(self.rendered_raw);(self.directory/'rendered.json').chmod(0o600)
        Q.write_json(self.directory/'before-groups.json',{'value':[]});S.intent(*self.args);self.material();phases=self.phase_receipt()
        target=self.directory/'phases.json';intent=self.directory/'mutation-intent.json';intent_raw=intent.read_bytes()
        mutations=[lambda p:p.pop(),lambda p:p.reverse(),lambda p:p.append(copy.deepcopy(p[-1])),
            lambda p:p[0].update(executableSha256='0'*64),lambda p:p[0].update(arguments=['unreviewed']),
            lambda p:p[0].update(argumentsSha256='0'*64),lambda p:p[0].update(stdoutSha256='0'*64),
            lambda p:p[0].update(stdoutBytes=True),lambda p:p[0].update(exitCode=False),
            lambda p:p[0].update(endedAt='2026-10-01T09:00:00Z'),
            lambda p:next(v for v in p if v['phase']=='apply').update(binaryPlanSha256='0'*64)]
        for change in mutations:
            bad=copy.deepcopy(phases);change(bad);target.write_text(json.dumps(bad))
            with self.subTest(phaseMutation=change),self.assertRaises(S.A.Error):S.finish(*self.args)
        target.write_text(json.dumps(phases));original=json.loads(intent_raw)
        for key,value in [('mode','dispose'),('source_sha256','0'*64),('request_sha256','0'*64),('binary_plan_sha256','0'*64),('owned_state_sha256','0'*64),('outcome','completed'),('createdAt','2026-10-01T09:00:00Z'),('limits','changed')]:
            intent.write_text(json.dumps(original|{key:value}))
            with self.subTest(intentKey=key),self.assertRaises(S.A.Error):S.finish(*self.args)
        intent.write_bytes(intent_raw)
        output=self.directory/'after-vm.json';raw=output.read_bytes();output.write_bytes(raw+b' ')
        with self.assertRaises(S.A.Error):S.finish(*self.args)
        output.write_bytes(raw);self.assertTrue(S.finish(*self.args)['completed'])
    def test_state_generation_must_be_present_typed_and_match_for_each_available_field(self):
        self.prepare();self.material();original=S.verify(*self.args)[2]
        state_path=self.directory/'state.json';raw_path=self.directory/'work/terraform.tfstate'
        for resource_type,key in [('azurerm_linux_virtual_machine','virtual_machine_id'),('azurerm_virtual_network','guid')]:
            for value in [None,False,1,'','ffffffff-ffff-ffff-ffff-ffffffffffff']:
                state=copy.deepcopy(self.responses['state']);raw=copy.deepcopy(self.responses['raw'])
                next(r for r in state['values']['root_module']['resources'] if r['type']==resource_type)['values'][key]=value
                next(r for r in raw['resources'] if r['type']==resource_type)['instances'][0]['attributes'][key]=value
                state_path.write_text(json.dumps(state));raw_path.write_text(json.dumps(raw))
                with self.subTest(resource=resource_type,value=value),self.assertRaises(S.A.Error):S.current_ownership(self.directory,'after',original)

if __name__ == '__main__': unittest.main(verbosity=2)
