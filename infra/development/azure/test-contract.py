#!/usr/bin/env python3
"""Synthetic contract tests; no Azure credentials, requests, plans or resources."""
import copy
import ctypes
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

if __name__ == '__main__': unittest.main(verbosity=2)
