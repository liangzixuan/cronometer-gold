import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parent
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
T=module("acquisition",ROOT/"storage-acquisition.py")
F=module("policy_fixtures",ROOT/"test-storage-policy.py")
NOW=datetime(2026,10,10,12,tzinfo=timezone.utc)
SUB=F.SUB

def storage():
    policies={}
    for n in T.NAMES:
        p=F.fixture(n)[3]["policy"]
        p["account"]["networkAcls"]["ipRules"]=[{"action":"Allow","value":"8.8.8.8"}]
        p["account"]["encryption"]["requireInfrastructureEncryption"]=True
        policies[n]=p
    return {"suffix":"abcdef123456","ipv4_rules":["8.8.8.8"],"policies":policies}

def values():return T.config(storage(),SUB)

def template_fixture(v):
    # Fixed ARM fixture is independent of the qualifier's expected_values/template helpers.
    return {"$schema":"https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
        "contentVersion":"1.0.0.0","parameters":{},"variables":{},"outputs":{},
        "resources":[{"type":"Microsoft.Storage/storageAccounts/blobServices/containers", "apiVersion":"2025-06-01",
            "name":"nourish"+v["suffix"]+short+"/default/nourishing-development-"+name,
            "properties":{"publicAccess":"None","defaultEncryptionScope":"$account-encryption-key",
                "denyEncryptionScopeOverride":True,"metadata":{}}}
            for name,short in (("artifact","art"),("erasure","era"),("backup","bak"))]}

def plan(v=None):
    v=values() if v is None else v
    resources=[];changes=[];configured=[]
    for address,want in T.expected_values(v).items():
        typ,name=address.split(".");known=copy.deepcopy(want)
        unknown={"id":True}
        if typ=="azurerm_resource_group_template_deployment":
            known["template_content"]=json.dumps(template_fixture(v));unknown["output_content"]=True
        item={"address":address,"mode":"managed","type":typ,"name":name,
              "provider_name":T.A.PROVIDER,"schema_version":T.SCHEMAS[address],"values":known}
        resources.append(item)
        changes.append({k:item[k] for k in ("address","mode","type","name","provider_name")}|
            {"change":{"actions":["create"],"before":None,"after":copy.deepcopy(known),
                "after_unknown":unknown,"before_sensitive":False,"after_sensitive":{}}})
        expressions={}
        if typ=="azurerm_storage_account":expressions["resource_group_name"]={"references":[T.RG+".name",T.RG]}
        if typ=="azurerm_resource_group_template_deployment":
            expressions["resource_group_name"]={"references":[T.RG+".name",T.RG]}
            expressions["template_content"]={"references":[x for n in ("artifact","erasure","backup")
                for x in ("azurerm_storage_account."+n+".name","azurerm_storage_account."+n)]}
        configured.append({k:item[k] for k in ("address","mode","type","name","schema_version")}|
            {"provider_config_key":"azurerm","expressions":expressions})
        if typ=="azurerm_resource_group_template_deployment":
            configured[-1]["depends_on"]=["azurerm_storage_account."+n for n in ("artifact","erasure","backup")]
    provider={"name":"azurerm","full_name":T.A.PROVIDER,"version_constraint":"4.79.0",
        "expressions":{"subscription_id":{"references":["var.subscription_id"]},
            "resource_provider_registrations":{"constant_value":"none"},"features":[{
                "skip_import_check_on_create_and_allow_overwriting_existing_resources":{"constant_value":False},
                "resource_group":[{"prevent_deletion_if_contains_resources":{"constant_value":True}}],
                "storage":[{"data_plane_available":{"constant_value":False}}],
            "template_deployment":[{"delete_nested_items_during_deletion":{"constant_value":False}}]}]}}
    return {"format_version":"1.2","terraform_version":"1.5.7","variables":{k:{"value":x} for k,x in v.items()},
        "configuration":{"provider_config":{"azurerm":provider},"root_module":{"resources":configured}},
        "resource_changes":changes,"planned_values":{"root_module":{"resources":resources}}}

def states(v=None):
    v=values() if v is None else v
    raw={"version":4,"terraform_version":"1.5.7","serial":1,
         "lineage":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","outputs":{},"resources":[]}
    rendered={"format_version":"1.0","terraform_version":"1.5.7","values":{"root_module":{"resources":[]}}}
    for address,val in T.expected_values(v,True).items():
        typ,name=address.split(".")
        if typ=="azurerm_resource_group_template_deployment":val["template_content"]=json.dumps(template_fixture(v))
        resource={"address":address,"mode":"managed","type":typ,"name":name,"provider_name":T.A.PROVIDER,
                  "schema_version":T.SCHEMAS[address],"values":copy.deepcopy(val)}
        rendered["values"]["root_module"]["resources"].append(resource)
        raw["resources"].append({"mode":"managed","type":typ,"name":name,'provider':'provider["'+T.A.PROVIDER+'"]',
            "instances":[{"schema_version":T.SCHEMAS[address],"attributes":copy.deepcopy(val)}]})
    return raw,rendered

def live(v=None):
    v=values() if v is None else v
    out={}
    for n in T.NAMES:
        owner=T.owner(v,n,NOW.isoformat().replace("+00:00","Z"),storage()["policies"][n])
        out[n+"-account"]={"id":owner["account_id"],"name":T.account_name(v,n),"kind":"StorageV2",
            "location":"centralus","sku":owner["sku"],"tags":T.TAGS,"properties":{**copy.deepcopy(owner["policy"]["account"]),
            "creationTime":owner["creation_time"],"provisioningState":"Succeeded","primaryEndpoints":{"blob":T.account_url(v,n)+"/"}}}
        out[n+"-service"]={"id":owner["account_id"]+"/blobServices/default","properties":copy.deepcopy(owner["policy"]["service"])}
        out[n+"-container"]={"id":owner["container_id"],"etag":"one","properties":copy.deepcopy(owner["policy"]["container"])}
    out["group"]={"id":T.resource_ids(v)[T.RG],"name":T.group_name(v),"location":"centralus",
                  "tags":T.TAGS,"properties":{"provisioningState":"Succeeded"}}
    out["members"]={"value":[{"id":out[n+"-account"]["id"],"name":out[n+"-account"]["name"],
                              "type":"Microsoft.Storage/storageAccounts"} for n in T.NAMES]}
    for n in T.NAMES:
        out[n+"-containers"]={"value":[{"id":out[n+"-container"]["id"],"name":"nourishing-development-"+n,
                                      "type":"Microsoft.Storage/storageAccounts/blobServices/containers"}],"nextLink":None}
    out["deployment"]={"id":T.resource_ids(v)[T.DEPLOYMENT],"name":"nourishing-containers-"+v["suffix"],
        "type":"Microsoft.Resources/deployments","tags":T.TAGS,
        "properties":{"provisioningState":"Succeeded","mode":"Incremental",
            "outputResources":[{"id":out[n+"-container"]["id"]} for n in ("artifact","erasure","backup")]}}
    return out

class PlanTests(unittest.TestCase):
    def test_exact_five_create_graph(self):
        self.assertEqual(T.audit_plan(plan(),values())["resource_count"],5)
    def rejected(self,p):
        with self.assertRaises(Exception):T.audit_plan(p,values())
    def test_each_noncreate_action(self):
        for action in (["update"],["delete"],["delete","create"],["no-op"],[]):
            p=plan();p["resource_changes"][0]["change"]["actions"]=action;self.rejected(p)
    def test_import_and_previous_state(self):
        for key,val in (("importing",{"id":"foreign"}),("before",{}),("replace_paths",[["name"]])):
            p=plan();p["resource_changes"][0]["change"][key]=val;self.rejected(p)
        p=plan();p["prior_state"]={"resources":["foreign"]};self.rejected(p)
    def test_extra_missing_duplicate_graph(self):
        for field in ("resource_changes",):
            p=plan();p[field].append(copy.deepcopy(p[field][0]));self.rejected(p)
            p=plan();p[field].pop();self.rejected(p)
        p=plan();p["planned_values"]["root_module"]["child_modules"]=[{}];self.rejected(p)
    def test_provider_registration_overwrite_and_data_plane(self):
        for field in ("skip_import_check_on_create_and_allow_overwriting_existing_resources",):
            p=plan();p["configuration"]["provider_config"]["azurerm"]["expressions"]["features"][0][field]["constant_value"]=True;self.rejected(p)
        p=plan();p["configuration"]["provider_config"]["azurerm"]["expressions"]["resource_provider_registrations"]["constant_value"]="all";self.rejected(p)
        p=plan();p["configuration"]["provider_config"]["azurerm"]["expressions"]["features"][0]["storage"][0]["data_plane_available"]["constant_value"]=True;self.rejected(p)
    def test_resource_identity_and_unknown_security_field(self):
        p=plan();p["resource_changes"][1]["change"]["after_unknown"]["min_tls_version"]=True;self.rejected(p)
        p=plan();p["planned_values"]["root_module"]["resources"][1]["schema_version"]=1;self.rejected(p)
        p=plan();p["configuration"]["root_module"]["resources"][1]["provisioners"]=[{}];self.rejected(p)
    def test_known_profile_and_planned_disagreement(self):
        for field,value in (("shared_access_key_enabled",True),("min_tls_version","TLS1_0"),("account_replication_type","GRS")):
            p=plan();p["resource_changes"][1]["change"]["after"][field]=value;self.rejected(p)
        p=plan();p["planned_values"]["root_module"]["resources"][1]["values"]["name"]="different";self.rejected(p)
    def test_unknown_computed_cannot_hide_policy(self):
        p=plan();p["resource_changes"][1]["change"]["after_unknown"]["unreviewed_feature"]=True;self.rejected(p)
        p=plan();p["resource_changes"][1]["change"]["after"]["routing"]=[{"choice":"InternetRouting"}];self.rejected(p)
    def test_explicit_configuration_reference(self):
        p=plan();p["configuration"]["root_module"]["resources"][1]["expressions"]["resource_group_name"]={"constant_value":"foreign"};self.rejected(p)
    def test_network_public_ipv4_and_exact_policy(self):
        for ip in ("127.0.0.1","192.168.1.1","8.8.8.8/32","::1"):
            s=storage();s["ipv4_rules"]=[ip]
            with self.assertRaises(Exception):T.config(s,SUB)
        s=storage();s["policies"]["artifact"]["account"]["networkAcls"]["defaultAction"]="Allow"
        with self.assertRaises(Exception):T.config(s,SUB)
    def test_retention_policy_cannot_be_unconfigured(self):
        s=storage();s["policies"]["backup"]["service"]["deleteRetentionPolicy"]={"enabled":True,"days":7}
        with self.assertRaises(Exception):T.config(s,SUB)

class TemplateDeploymentTests(unittest.TestCase):
    def test_actual_module_has_one_fixed_guarded_deployment(self):
        source=(ROOT/"storage/main.tf").read_text();provider=(ROOT/"storage/versions.tf").read_text()
        self.assertNotIn('resource "azurerm_storage_container"',source)
        self.assertEqual(len(re.findall(r'(?m)^resource "',source)),5)
        self.assertEqual(source.count('resource "azurerm_resource_group_template_deployment" "containers"'),1)
        for token in ('deployment_mode     = "Incremental"','lifecycle { prevent_destroy = true }',
                      'template_deployment { delete_nested_items_during_deletion = false }'):
            self.assertIn(token,provider if token.startswith('template_deployment') else source)
        for token in ('type       = "Microsoft.Storage/storageAccounts/blobServices/containers"',
                      'apiVersion = "2025-06-01"','defaultEncryptionScope      = "$account-encryption-key"',
                      'denyEncryptionScopeOverride = true','publicAccess                = "None"'):
            self.assertEqual(source.count(token),3)
        dependencies=re.search(r'depends_on = \[([^]]+)\]',source).group(1)
        self.assertEqual(set(re.findall(r'azurerm_storage_account\.\w+',dependencies)),
                         {'azurerm_storage_account.artifact','azurerm_storage_account.erasure','azurerm_storage_account.backup'})
        for token in ('template_spec_version_id','templateLink','onErrorDeployment','deploymentScripts','"Complete"'):
            self.assertNotIn(token,source)

    def test_independent_template_and_separate_graph_identities(self):
        p=plan();result=T.audit_plan(p,values())
        self.assertEqual(result['resource_count'],5);self.assertEqual(result['azure_object_count'],8)
        self.assertEqual(len(result['planned_ids']),5);self.assertEqual(len(result['container_ids']),3)
        self.assertFalse(any(x.startswith('azurerm_storage_container.') for x in result['planned_ids']))
        self.assertEqual(T.container_template(values()),template_fixture(values()))

    def test_known_template_policy_and_graph_mutations_refuse(self):
        mutations=[lambda t:t['resources'].append(copy.deepcopy(t['resources'][0])),lambda t:t['resources'].pop(),
            lambda t:t.update(outputs={'unexpected':{'type':'string','value':'x'}}),lambda t:t.update(templateLink={}),
            lambda t:t['resources'][0].update(type='Microsoft.Resources/deployments'),
            lambda t:t['resources'][0].update(apiVersion='other'),lambda t:t['resources'][0].update(name='foreign'),
            lambda t:t['resources'][0]['properties'].update(defaultEncryptionScope='custom'),
            lambda t:t['resources'][0]['properties'].update(denyEncryptionScopeOverride=False),
            lambda t:t['resources'][0]['properties'].update(denyEncryptionScopeOverride=1),
            lambda t:t['resources'][0]['properties'].update(publicAccess='Blob'),
            lambda t:t['resources'][0]['properties'].update(metadata={'other':'x'}),
            lambda t:t['resources'][0]['properties'].update(unreviewed=None)]
        for i,change in enumerate(mutations):
            for view in ('change','planned'):
                with self.subTest(mutation=i,view=view):
                    p=plan();rows=p['resource_changes'] if view=='change' else p['planned_values']['root_module']['resources']
                    row=next(x for x in rows if x['address']==T.DEPLOYMENT)
                    val=row['change']['after'] if view=='change' else row['values']
                    template=json.loads(val['template_content']);change(template);val['template_content']=json.dumps(template)
                    with self.assertRaises(Exception):T.audit_plan(p,values())

    def test_unknown_template_and_extra_execution_inputs_refuse(self):
        for field,value in (('template_content',None),('template_content','null'),('deployment_mode','Complete'),
                            ('template_spec_version_id','/foreign'),('parameters_content','{"other":{}}'),('debug_level','requestContent')):
            with self.subTest(field=field,value=value):
                p=plan();row=next(x for x in p['resource_changes'] if x['address']==T.DEPLOYMENT)
                row['change']['after'][field]=value
                if value is None:row['change']['after_unknown'][field]=True
                with self.assertRaises(Exception):T.audit_plan(p,values())

    def test_dependencies_and_template_references_are_exact(self):
        for fault in ('missing','extra','duplicate','wrong-reference','unknown-reference'):
            with self.subTest(fault=fault):
                p=plan();row=next(x for x in p['configuration']['root_module']['resources'] if x['address']==T.DEPLOYMENT)
                if fault=='missing':row['depends_on'].pop()
                elif fault=='extra':row['depends_on'].append(T.RG)
                elif fault=='duplicate':row['depends_on'][-1]=row['depends_on'][0]
                elif fault=='wrong-reference':row['expressions']['template_content']['references'][0]='var.other'
                else:row['expressions']['template_content']={'constant_value':'{}'}
                with self.assertRaises(Exception):T.audit_plan(p,values())

    def test_delete_feature_and_noncreate_deployment_refuse(self):
        p=plan();p['configuration']['provider_config']['azurerm']['expressions']['features'][0]['template_deployment'][0]['delete_nested_items_during_deletion']['constant_value']=True
        with self.assertRaises(Exception):T.audit_plan(p,values())
        for actions in (['update'],['delete'],['delete','create'],['no-op']):
            p=plan();row=next(x for x in p['resource_changes'] if x['address']==T.DEPLOYMENT);row['change']['actions']=actions
            with self.assertRaises(Exception):T.audit_plan(p,values())

    def test_resolved_template_and_deployment_outputs_are_exact(self):
        for field,value in (('output_content','{"unexpected":{}}'),('parameters_content','{"other":{}}'),
                            ('template_content','{}'),('deployment_mode','Complete'),('id','/foreign')):
            with self.subTest(field=field):
                raw,rendered=states()
                a=next(x for x in raw['resources'] if x['type']=='azurerm_resource_group_template_deployment')['instances'][0]['attributes']
                b=next(x for x in rendered['values']['root_module']['resources'] if x['address']==T.DEPLOYMENT)['values']
                a[field]=value;b[field]=value
                with self.assertRaises(Exception):T.raw_and_rendered(raw,rendered,values())

    def test_complete_deployment_record_normalizes_target_order_and_case(self):
        doc=live()['deployment'];expected=T.deployment_observation(doc,values())
        doc['id']=doc['id'].upper();doc['type']=doc['type'].upper();doc['properties']['outputResources'].reverse()
        for row in doc['properties']['outputResources']:row['id']=row['id'].upper()
        self.assertEqual(T.deployment_observation(doc,values()),expected)
        self.assertEqual(len(expected['outputResources']),3)

    def test_incomplete_foreign_or_failed_deployment_refuses(self):
        for fault in ('missing','extra','duplicate','foreign','malformed','continued','nested-continuation','running','failed','identity','mode','link','rollback','params','outputs'):
            with self.subTest(fault=fault):
                doc=live()['deployment'];props=doc['properties'];targets=props['outputResources']
                if fault=='missing':targets.pop()
                elif fault=='extra':targets.append({'id':'foreign'})
                elif fault=='duplicate':targets[-1]=targets[0]
                elif fault=='foreign':targets[0]['id']+='-other'
                elif fault=='malformed':targets[0]['id']=None
                elif fault=='continued':doc['nextLink']='unconsumed'
                elif fault=='nested-continuation':props['nextLink']='unconsumed'
                elif fault=='running':props['provisioningState']='Running'
                elif fault=='failed':props['provisioningState']='Failed'
                elif fault=='identity':doc['id']+='-other'
                elif fault=='mode':props['mode']='Complete'
                elif fault=='link':props['templateLink']={'uri':'https://unselected.invalid/'}
                elif fault=='rollback':props['onErrorDeployment']={}
                elif fault=='params':props['parameters']={'unexpected':{}}
                else:props['outputs']={'unexpected':{}}
                with self.assertRaises(Exception):T.deployment_observation(doc,values())

    def test_derived_phase_budget_includes_exact_deployment_reads(self):
        descriptors=T.resource_read_arguments(values());selected=next(x for x in descriptors if x['label']=='deployment')
        self.assertEqual(selected['arguments'][4],'https://management.azure.com'+T.resource_ids(values())[T.DEPLOYMENT]+'?api-version=2020-06-01')
        counts=[len(T.phase_labels(mode,values())) for mode in ('plan','execute','reconcile')]
        self.assertEqual(counts,[8,40,38]);self.assertEqual(sum(counts),T.MAX_DIAGNOSTIC_REFERENCES)


class StateTests(unittest.TestCase):
    def test_exact_state(self):
        self.assertEqual(len(T.raw_and_rendered(*states(),values())),5)
    def test_raw_rendered_mismatch_and_foreign(self):
        raw,rendered=states();raw["resources"][1]["instances"][0]["attributes"]["name"]="other"
        with self.assertRaises(Exception):T.raw_and_rendered(raw,rendered,values())
        raw,rendered=states();raw["resources"][0]["module"]="foreign"
        with self.assertRaises(Exception):T.raw_and_rendered(raw,rendered,values())
    def test_tainted_deposed_index_and_schema(self):
        for key,val in (("status","tainted"),("deposed","x"),("index_key",0),("schema_version",99)):
            raw,rendered=states();raw["resources"][1]["instances"][0][key]=val
            with self.assertRaises(Exception):T.raw_and_rendered(raw,rendered,values())
    def test_partial_retained_without_full_ownership(self):
        raw,rendered=states();raw["resources"].pop();rendered["values"]["root_module"]["resources"].pop()
        self.assertEqual(len(T.raw_and_rendered(raw,rendered,values(),True)),4)
        with self.assertRaises(Exception):T.raw_and_rendered(raw,rendered,values())
    def test_lineage_serial_and_output(self):
        for key,val in (("lineage","bad"),("serial",-1),("serial",True),("outputs",{"secret":"value"})):
            raw,rendered=states();raw[key]=val
            with self.assertRaises(Exception):T.raw_and_rendered(raw,rendered,values())
    def test_live_ownership_strict_consumer(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as d:
            p=Path(d);p.chmod(0o700)
            for label,doc in live().items():T.write(p/("first-"+label+".json"),doc)
            out=T.observations(p,"first",values(),storage(),
                {"created_at_utc":NOW.isoformat(),"not_after_utc":(NOW+timedelta(minutes=20)).isoformat().replace("+00:00","Z")},NOW+timedelta(minutes=1))
            for n in T.NAMES:self.assertEqual(set(out[n]["owner"]),{"account_id","container_id","creation_time","location","sku","policy"})
    def test_missing_policy_generation_and_foreign_group(self):
        for label,edit in (("artifact-account",lambda x:x["properties"].pop("immutableStorageWithVersioning")),
                           ("artifact-account",lambda x:x["properties"].update(creationTime="2025-01-01T00:00:00Z")),
                           ("group",lambda x:x.update(id="foreign"))):
            with tempfile.TemporaryDirectory(dir=Path.home()) as d:
                docs=live();edit(docs[label]);p=Path(d);p.chmod(0o700)
                for k,x in docs.items():T.write(p/("first-"+k+".json"),x)
                with self.assertRaises(Exception):T.observations(p,"first",values(),storage(),
                    {"created_at_utc":NOW.isoformat(),"not_after_utc":"2026-10-10T13:00:00Z"},NOW+timedelta(minutes=1))


class MembershipTests(unittest.TestCase):
    def observe(self, docs):
        with tempfile.TemporaryDirectory(dir=Path.home()) as d:
            p=Path(d);p.chmod(0o700)
            for label,doc in docs.items():T.write(p/("first-"+label+".json"),doc)
            return T.observations(p,"first",values(),storage(),
                {"created_at_utc":NOW.isoformat(),"not_after_utc":"2026-10-10T13:00:00Z"},NOW+timedelta(minutes=1))
    def test_complete_membership_normalizes_order_and_arm_case(self):
        expected=self.observe(live()); docs=live()
        docs["members"]["value"].reverse();docs["members"]["nextLink"]=""
        for label in ("members",*[n+"-containers" for n in T.NAMES]):
            for row in docs[label]["value"]:
                for field in ("id","name","type"):row[field]=row[field].upper()
        self.assertEqual(self.observe(docs),expected)
        self.assertEqual(len(expected["members"]),3)
        for n in T.NAMES:self.assertEqual(len(expected[n]["containers"]),1)
    def test_collections_refuse_unknown_or_incomplete_membership(self):
        for label in ("members",*[n+"-containers" for n in T.NAMES]):
            for fault in ("missing","extra","duplicate","foreign","deleted","malformed-deleted","null-deleted","type","malformed-row","malformed-value",
                          "missing-value","nonterminal","malformed-next","unknown-envelope"):
                with self.subTest(label=label,fault=fault):
                    docs=live();doc=docs[label];rows=doc["value"]
                    if fault=="missing":rows.pop()
                    elif fault=="extra":rows.append(copy.deepcopy(rows[0]))
                    elif fault=="duplicate":
                        if len(rows)>1:rows[-1]=copy.deepcopy(rows[0])
                        else:rows.append(copy.deepcopy(rows[0]))
                    elif fault=="foreign":rows[0]["id"]+="-foreign"
                    elif fault=="deleted":rows[0]["properties"]={"deleted":True}
                    elif fault=="malformed-deleted":rows[0]["properties"]={"deleted":0}
                    elif fault=="null-deleted":rows[0]["properties"]={"deleted":None}
                    elif fault=="type":rows[0]["type"]="foreign"
                    elif fault=="malformed-row":rows[0]={"id":rows[0]["id"]}
                    elif fault=="malformed-value":doc["value"]={}
                    elif fault=="missing-value":del doc["value"]
                    elif fault=="nonterminal":doc["nextLink"]="https://management.azure.com/unconsumed"
                    elif fault=="malformed-next":doc["nextLink"]=False
                    else:doc["unrecognizedPagination"]="unconsumed"
                    with self.assertRaises(Exception):self.observe(docs)
    def test_fifteen_fixed_readbacks_include_deployment_and_container_collections(self):
        rows=T.resource_read_arguments(values())
        self.assertEqual(len(rows),15)
        self.assertEqual(rows[1]["label"],"members")
        self.assertIn(T.resource_ids(values())[T.RG]+"/resources?api-version=2021-04-01",rows[1]["arguments"][4])
        for n in T.NAMES:
            row=next(r for r in rows if r["label"]==n+"-containers")
            self.assertTrue(row["arguments"][4].endswith("/blobServices/default/containers?api-version=2025-08-01"))


class RepairTests(unittest.TestCase):
    def test_two_exact_nested_computed_fields(self):
        p=plan()
        for rows,key in ((p["resource_changes"],"change"),):
            for row in rows:
                if row["type"]=="azurerm_storage_account":
                    c=row[key];c["after_unknown"].update(network_rules=[{"virtual_network_subnet_ids":True}],
                        blob_properties=[{"default_service_version":True}])
                    c["after"]["network_rules"][0]["virtual_network_subnet_ids"]=None
        for item in p["planned_values"]["root_module"]["resources"]:
            if item["type"]=="azurerm_storage_account":item["values"]["network_rules"][0]["virtual_network_subnet_ids"]=None
        T.audit_plan(p,values())
        raw,rendered=states()
        for row in rendered["values"]["root_module"]["resources"]:
            if row["type"]=="azurerm_storage_account":row["values"]["blob_properties"][0]["default_service_version"]="2025-01-05"
        for row in raw["resources"]:
            if row["type"]=="azurerm_storage_account":row["instances"][0]["attributes"]["blob_properties"][0]["default_service_version"]="2025-01-05"
        T.raw_and_rendered(raw,rendered,values())
        p["resource_changes"][1]["change"]["after_unknown"]["network_rules"][0]["ip_rules"]=True
        with self.assertRaises(Exception):T.audit_plan(p,values())
    def test_nested_computed_cannot_hide_subnets(self):
        raw,rendered=states()
        for row in raw["resources"]:
            if row["type"]=="azurerm_storage_account":row["instances"][0]["attributes"]["network_rules"][0]["virtual_network_subnet_ids"]=["foreign"]
        for row in rendered["values"]["root_module"]["resources"]:
            if row["type"]=="azurerm_storage_account":row["values"]["network_rules"][0]["virtual_network_subnet_ids"]=["foreign"]
        with self.assertRaises(Exception):T.raw_and_rendered(raw,rendered,values())
    def test_copy_conserves_content_when_read_updates_atime(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as d:
            source=Path(d)/"source";target=Path(d)/"target";source.write_bytes(b"owned data");source.chmod(0o600)
            os.utime(source,ns=(1,source.stat().st_mtime_ns))
            T.copy_file(source,target)
            self.assertEqual(target.read_bytes(),b"owned data")
            self.assertNotEqual(source.stat().st_atime_ns,1)
    def phase_fixture(self,d):
        v=values();expected={"subscriptionId":SUB,"tenantId":SUB}
        T.write(d/"session.json",{"created_at_utc":NOW.isoformat(),"values":v,"snapshot":{"source":"a"*64,"request":"b"*64}})
        (d/"plan.tfplan").write_bytes(b"plan");(d/"plan.tfplan").chmod(0o600)
        bh=T.A.H.secure_plan_digest(d/"plan.tfplan")[0]
        commands=[("auth-"+n,args+["--only-show-errors","--output","json"],T.P.CLI_SHA256) for n,args in T.P.commands(expected)]
        commands += [("version",["version","-json"],T.A.TF_SHA256),
            ("init",["init","-backend=false","-lockfile=readonly","-input=false","-no-color"],T.A.TF_SHA256),
            ("plan",["plan","-input=false","-no-color","-lock-timeout=0s","-parallelism=1","-var-file=inputs.tfvars.json","-out="+str(d/"plan.tfplan")],T.A.TF_SHA256),
            ("show",["show","-json","/proc/123/fd/4"],T.A.TF_SHA256)]
        phases=[]
        for label,args,tool in commands:
            file={"init":"init.stdout","plan":"plan.stdout","show":"rendered.json"}.get(label,label+".json")
            data=b"{}";(d/file).write_bytes(data);(d/file).chmod(0o600)
            diagnostic=b"\xff\x00private diagnostic" if label=="init" else b""
            (d/(label+".stderr")).write_bytes(diagnostic);(d/(label+".stderr")).chmod(0o600)
            phases.append({"sourceSha256":"a"*64,"requestSha256":"b"*64,"executionReturned":True,
                "cleanup":"settled","failure":None,"stderrBytes":len(diagnostic),"stderrSha256":T.A.sha(diagnostic),
                "stderrComplete":True,"stderrPublished":True,"stderrCaptureOverflow":False,
                "phase":label,"completed":True,"exitCode":0,"startedAt":NOW.isoformat(),
                "endedAt":NOW.isoformat(),"arguments":args,"argumentsSha256":T.A.sha(json.dumps(args,separators=(",",":")).encode()),
                "executableSha256":tool,"stdoutBytes":len(data),"stdoutSha256":T.A.sha(data)})
        phases[-1]["binaryPlanSha256"]=bh
        return phases,expected
    def test_phase_outputs_tools_arguments_and_binary_are_bound(self):
        for mutation in ("output","tool","args","binary","time","bytes"):
            with tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
                d=Path(tmp);d.chmod(0o700);phases,expected=self.phase_fixture(d)
                if mutation=="output":(d/"auth-version.json").write_text('[]')
                elif mutation=="tool":phases[0]["executableSha256"]="0"*64
                elif mutation=="args":
                    phases[0]["arguments"]=["changed"]
                    phases[0]["argumentsSha256"]=T.A.sha(b'["changed"]')
                elif mutation=="binary":phases[-1]["binaryPlanSha256"]="0"*64
                elif mutation=="time":phases[0]["startedAt"]="2025-01-01T00:00:00Z"
                else:phases[0]["stdoutBytes"]=True
                T.write(d/"phases.json",phases)
                with self.assertRaises(Exception):T.validate_phases(d,"plan",expected,NOW)
    def test_diagnostics_and_success_claims_are_bound(self):
        mutations=[("sourceSha256","c"*64),("requestSha256","c"*64),("executionReturned",False),
            ("cleanup","unknown"),("cleanup","unconfirmed"),("failure","command"),("exitCode",None),
            ("stderrBytes",True),("stderrSha256","c"*64),("stderrComplete",False),
            ("stderrPublished",False),("stderrCaptureOverflow",True),("unexpected",True)]
        for key,value in mutations:
            with self.subTest(key=key,value=value),tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
                d=Path(tmp);d.chmod(0o700);phases,expected=self.phase_fixture(d)
                phases[0][key]=value;T.write(d/"phases.json",phases)
                with self.assertRaises(Exception):T.validate_phases(d,"plan",expected,NOW)
    def test_private_diagnostic_refuses_drift_permissions_links_and_overflow(self):
        for mutation in ("bytes","mode","link","overflow"):
            with self.subTest(mutation=mutation),tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
                d=Path(tmp);d.chmod(0o700);phases,expected=self.phase_fixture(d);p=d/"init.stderr"
                if mutation=="bytes":p.write_bytes(b"different")
                elif mutation=="mode":p.chmod(0o644)
                elif mutation=="link":
                    p.rename(d/"retained");p.symlink_to(d/"retained")
                else:
                    p.write_bytes(b"x"*(T.MAX_STDERR+1));phases[5]["stderrBytes"]=T.MAX_STDERR+1
                    phases[5]["stderrSha256"]=T.A.sha(p.read_bytes())
                T.write(d/"phases.json",phases)
                with self.assertRaises(Exception):T.validate_phases(d,"plan",expected,NOW)
    def test_storage_inventory_keeps_ordinary_and_exact_diagnostic_bounds(self):
        for mode,count in (("plan",8),("execute",40),("reconcile",38)):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
                d=Path(tmp);d.chmod(0o700)
                for i in range(96):(d/("ordinary-"+str(i))).write_bytes(b"")
                for name in T.phase_labels(mode,values()):
                    p=d/(name+".stderr");p.write_bytes(b"");p.chmod(0o600)
                self.assertEqual(len(T.storage_tree(d,mode,values())),96+count)
                (d/"unselected.stderr").write_bytes(b"")
                with self.assertRaisesRegex(Exception,"entry count"):T.storage_tree(d,mode,values())
    def test_storage_inventory_counts_diagnostic_bytes_in_existing_aggregate(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
            d=Path(tmp);d.chmod(0o700);p=d/"init.stderr";p.write_bytes(b"x");p.chmod(0o600)
            with patch.object(T.Q,"MAX_AGGREGATE",0),self.assertRaisesRegex(Exception,"aggregate"):
                T.storage_tree(d,"plan",values())
    def metadata_fixture(self,d,modes=("plan","execute","reconcile")):
        roots=set()
        for i,mode in enumerate(modes):
            root=d/(mode+str(i));root.mkdir(mode=0o700);roots.add(root)
            T.write(root/"session.json",{"mode":mode,"values":values()})
            for label in T.phase_labels(mode,values()):
                p=root/(label+".stderr");p.write_bytes(b"");p.chmod(0o600)
        evidence=T.evidence_inventory(roots,set())
        return {"evidence":evidence,"evidence_sha256":T.A.sha(T.encoded(evidence))},roots
    def test_metadata_budget_preserves_complete_inventory(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
            d=Path(tmp);d.chmod(0o700);value,roots=self.metadata_fixture(d)
            raw=T.acquisition_metadata(value,roots)
            self.assertEqual(raw,T.encoded(value));self.assertEqual(json.loads(raw),value)
            self.assertEqual(sum(row["path"].endswith(".stderr") for row in value["evidence"]["files"]),86)
            self.assertEqual(T.MAX_BINDING_BYTES,109568)
    def test_metadata_budget_refuses_ordinary_overflow_and_unselected_credit(self):
        for name in ("unexpected.stderr","work/init.stderr","apply.stderr"):
            with self.subTest(name=name),tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
                d=Path(tmp);d.chmod(0o700);value,roots=self.metadata_fixture(d,("plan",));root=next(iter(roots))
                value["evidence"]["files"].append({"path":str(root/name),"padding":"x"*65536})
                with self.assertRaisesRegex(Exception,"ordinary acquisition metadata limit"):
                    T.acquisition_metadata(value,roots)
    def test_metadata_budget_refuses_single_reference_overflow(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
            d=Path(tmp);d.chmod(0o700);value,roots=self.metadata_fixture(d,("plan",))
            row=next(row for row in value["evidence"]["files"] if row["path"].endswith(".stderr"))
            row["padding"]="x"*512
            with self.assertRaisesRegex(Exception,"reference too large"):T.acquisition_metadata(value,roots)
    def test_metadata_budget_refuses_reference_count_and_aggregate_overflow(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
            d=Path(tmp);d.chmod(0o700);value,roots=self.metadata_fixture(d,("plan","execute","reconcile","plan"))
            with self.assertRaisesRegex(Exception,"reference limit"):T.acquisition_metadata(value,roots)
        with tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
            d=Path(tmp);d.chmod(0o700);value,roots=self.metadata_fixture(d,("plan",))
            with patch.object(T,"MAX_DIAGNOSTIC_METADATA",1),self.assertRaisesRegex(Exception,"aggregate limit"):
                T.acquisition_metadata(value,roots)
    def test_metadata_budget_binds_actual_session_and_child_membership(self):
        for mutation in ("session","missing","duplicate"):
            with self.subTest(mutation=mutation),tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
                d=Path(tmp);d.chmod(0o700);value,roots=self.metadata_fixture(d,("plan",));root=next(iter(roots))
                if mutation=="session":(root/"session.json").write_bytes(b"{}")
                else:
                    row=next(row for row in value["evidence"]["directories"] if row["path"]==str(root))
                    if mutation=="missing":row["children"].remove("init.stderr")
                    else:row["children"].append("init.stderr")
                with self.assertRaises(Exception):T.acquisition_metadata(value,roots)
    def test_valid_phase_outputs(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as tmp:
            d=Path(tmp);d.chmod(0o700);phases,expected=self.phase_fixture(d);T.write(d/"phases.json",phases)
            self.assertEqual(len(T.validate_phases(d,"plan",expected,NOW)),8)


def gateway_main(context=False, assembly=False):
    import sys
    consumer=(module("recovery_assembly_gateway",ROOT/"storage-recovery-assembly.py") if assembly else
              module("recovery_context_gateway",ROOT/"storage-recovery-context.py") if context else None)
    G=consumer.Q if consumer else T
    clock=datetime.fromisoformat(os.environ["NOURISHING_TEST_CLOCK"])
    class FixedDateTime(datetime):
        @classmethod
        def now(cls,tz=None):return clock.astimezone(tz) if tz else clock.replace(tzinfo=None)
    def provider_copy(home,directory):
        target=Path(home)/"terraform/providers/registry.terraform.io/hashicorp/azurerm/4.79.0/linux_amd64"
        target.mkdir(parents=True,mode=0o700)
        for p in [target,*target.parents]:
            if p==Path(home):break
            p.chmod(0o700)
        p=target/"synthetic-provider";p.write_text("test-only");p.chmod(0o600)
        return target,{"synthetic":True}
    # Only external measurements/copying are synthetic. All evidence validators run.
    with patch.object(T,"datetime",FixedDateTime),patch.object(G.P,"profile_digest",return_value={"synthetic":True}),\
         patch.object(G.P,"tool_digest",return_value=(G.P.CLI_SHA256,1)),\
         patch.object(G.A.H,"secure_executable_digest",return_value=(G.A.TF_SHA256,1)),\
         patch.object(G.A,"provider_digest",return_value={"synthetic":True}),\
         patch.object(G.A,"prepare_provider",side_effect=provider_copy):
        sys.argv=[sys.argv[0],*sys.argv[2:]]
        if consumer:
            if assembly and os.environ.get("NOURISHING_TEST_ASSEMBLY_POST_READ"):
                with patch.object(consumer,"read_bundle",side_effect=OSError("synthetic post-publication read failure")):consumer.main()
                return
            replacement=os.environ.get("NOURISHING_TEST_CONTEXT_REPLACE")
            if replacement:
                original=consumer.context_qualification if assembly else consumer.storage_context
                changed=False
                def replace_after_real_context(*args):
                    nonlocal changed
                    result=original(*args)
                    if not changed:
                        path=Path(replacement);raw=path.read_bytes();path.rename(path.with_suffix(".retained"))
                        path.write_bytes(raw);path.chmod(0o600);changed=True
                    return result
                with patch.object(consumer,"context_qualification" if assembly else "storage_context",side_effect=replace_after_real_context):consumer.main()
            else:consumer.main()
        else:G.main()

def emit_fixture():
    global NOW
    NOW=datetime.fromisoformat(os.environ["NOURISHING_TEST_CLOCK"])
    auth={"version":{"azure-cli":"2.90.0","azure-cli-core":"2.90.0","azure-cli-telemetry":"test","extensions":{}},
        "extensions":[],"account":{"id":SUB,"tenantId":SUB,"state":"Enabled","environmentName":"AzureCloud"},
        "subscription":{"subscriptionId":SUB,"tenantId":SUB,"state":"Enabled",
            "subscriptionPolicies":{"quotaId":"AzureForStudents_2018-01-01","spendingLimit":"On"}}}
    raw,rendered=states()
    print(json.dumps({"storage":storage(),"plan":plan(),"rawState":raw,"renderedState":rendered,
                     "live":live(),"auth":auth,"source":T.source_digest(),"sub":SUB}))

if __name__=="__main__":
    import sys
    if sys.argv[1:]==["--fixture"]:emit_fixture()
    elif sys.argv[1:2] == ["--gateway"]:gateway_main()
    elif sys.argv[1:2] == ["--context-gateway"]:gateway_main(True)
    elif sys.argv[1:2] == ["--assembly-gateway"]:gateway_main(assembly=True)
    else:unittest.main()
