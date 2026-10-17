import copy
import json
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("storage_policy",Path(__file__).with_name("storage-policy.py"))
T=importlib.util.module_from_spec(spec);spec.loader.exec_module(T)
SUB="11111111-1111-4111-8111-111111111111"
NOW=datetime(2026,10,9,12,tzinfo=timezone.utc)
def fixture(name="artifact"):
    account="nourishing"+name
    aid=f"/subscriptions/{SUB}/resourceGroups/nourishing/providers/Microsoft.Storage/storageAccounts/{account}"
    cid=aid+"/blobServices/default/containers/nourishing-development-"+name
    ap={"supportsHttpsTrafficOnly":True,"minimumTlsVersion":"TLS1_2","allowSharedKeyAccess":False,
        "allowBlobPublicAccess":False,"publicNetworkAccess":"Enabled",
        "networkAcls":{"defaultAction":"Deny","bypass":"None","ipRules":[],"ipv6Rules":[],"virtualNetworkRules":[],"resourceAccessRules":[]},
        "encryption":{"keySource":"Microsoft.Storage","services":{"blob":{"enabled":True}}},
        "immutableStorageWithVersioning":{"enabled":False}}
    sv={"isVersioningEnabled":name!="artifact","deleteRetentionPolicy":{"enabled":False},
        "containerDeleteRetentionPolicy":{"enabled":False},"restorePolicy":{"enabled":False},
        "changeFeed":{"enabled":False},"automaticSnapshotPolicyEnabled":False}
    co={"publicAccess":"None","hasLegalHold":False,"hasImmutabilityPolicy":False,"immutableStorageWithVersioning":{"enabled":False},
        "defaultEncryptionScope":"$account-encryption-key","denyEncryptionScopeOverride":True,"legalHold":None,"immutabilityPolicy":None}
    owner={"account_id":aid,"container_id":cid,"creation_time":"2026-10-09T10:00:00Z","location":"centralus",
           "sku":{"name":"Standard_LRS","tier":"Standard"},"policy":{"account":copy.deepcopy(ap),"service":copy.deepcopy(sv),"container":copy.deepcopy(co)}}
    ap.update({"provisioningState":"Succeeded","creationTime":owner["creation_time"],"primaryEndpoints":{"blob":f"https://{account}.blob.core.windows.net/"}})
    accountdoc={"id":aid,"name":account,"kind":"StorageV2","location":"centralus","sku":owner["sku"],"properties":ap}
    service={"id":aid+"/blobServices/default","properties":sv}
    container={"id":cid,"etag":'"one"',"properties":co}
    dest={"container_url":f"https://{account}.blob.core.windows.net/nourishing-development-{name}","ownership_sha256":"a"*64}
    return accountdoc,service,container,owner,dest

class Policy(unittest.TestCase):
    def test_three_destinations(self):
        for name in T.NAMES:
            f=fixture(name);out=T.normalize(*f)
            self.assertEqual(out["container_id"],f[3]["container_id"])
    def test_generation_equivalent_utc(self):
        f=fixture();f[0]["properties"]["creationTime"]="2026-10-09T10:00:00+00:00"
        T.normalize(*f)
    def test_generation_absent_null_malformed(self):
        for value in (None,"","today","2026-10-09","2026-10-09T10:00:00-05:00",42):
            f=fixture();f[3]["creation_time"]=value;f[0]["properties"]["creationTime"]=value
            with self.assertRaises(Exception):T.normalize(*f)
        f=fixture();del f[0]["properties"]["creationTime"]
        with self.assertRaises(Exception):T.normalize(*f)
    def test_owner_join_and_schema(self):
        for field,value in (("account_id",fixture("backup")[3]["account_id"]),("container_id","wrong"),("location",None),("sku",{"name":"Standard_LRS"})):
            f=fixture();f[3][field]=value
            with self.assertRaises(Exception):T.normalize(*f)
    def test_shared_key_and_tls_unknown_reject(self):
        for field,value in (("allowSharedKeyAccess",True),("allowSharedKeyAccess",None),("minimumTlsVersion","TLS1_0"),("allowBlobPublicAccess",True)):
            f=fixture();f[0]["properties"][field]=value;f[3]["policy"]["account"][field]=value
            with self.assertRaises(Exception):T.normalize(*f)
    def test_absent_policy_is_not_disabled(self):
        for fields,index in ((T.ACCOUNT_FIELDS,0),(T.SERVICE_FIELDS,1),(T.CONTAINER_FIELDS,2)):
            for field in fields:
                f=fixture();del f[index]["properties"][field]
                with self.assertRaises(Exception):T.normalize(*f)
    def test_export_retained_settings_reject(self):
        for field in ("deleteRetentionPolicy","containerDeleteRetentionPolicy","restorePolicy","changeFeed"):
            f=fixture();f[1]["properties"][field]["enabled"]=True;f[3]["policy"]["service"][field]["enabled"]=True
            with self.assertRaises(Exception):T.normalize(*f)
    def test_retained_versioning_required(self):
        f=fixture("backup");f[1]["properties"]["isVersioningEnabled"]=False;f[3]["policy"]["service"]["isVersioningEnabled"]=False
        with self.assertRaises(Exception):T.normalize(*f)
    def test_exact_independently_bound_policy(self):
        f=fixture();f[0]["properties"]["networkAcls"]["ipRules"]=[{"value":"1.2.3.4","action":"Allow"}]
        with self.assertRaises(Exception):T.normalize(*f)
    def test_bypass_and_encryption_reject(self):
        for branch,key,value in (("networkAcls","bypass","AzureServices"),("encryption","keySource","Microsoft.Keyvault")):
            f=fixture();f[0]["properties"][branch][key]=value;f[3]["policy"]["account"][branch][key]=value
            with self.assertRaises(Exception):T.normalize(*f)
    def test_disabled_immutability_cannot_hide_policy(self):
        f=fixture();f[0]["properties"]["immutableStorageWithVersioning"]["immutabilityPolicy"]={"state":"Locked"}
        f[3]["policy"]["account"]=copy.deepcopy({k:f[0]["properties"][k] for k in T.ACCOUNT_FIELDS})
        with self.assertRaises(Exception):T.normalize(*f)
    def test_wire_container_policy_nesting(self):
        f=fixture("backup");co=f[2]["properties"];co["hasImmutabilityPolicy"]=True
        co["immutabilityPolicy"]={"etag":'"policy"',"properties":{"state":"Locked","immutabilityPeriodSinceCreationInDays":7,"allowProtectedAppendWrites":False,"allowProtectedAppendWritesAll":False}}
        f[3]["policy"]["container"]=copy.deepcopy(co);T.normalize(*f)
        co["immutabilityPolicy"]=co["immutabilityPolicy"]["properties"];f[3]["policy"]["container"]=copy.deepcopy(co)
        with self.assertRaises(Exception):T.normalize(*f)
    def test_generation_and_etag_changes(self):
        for field,value in (("creationTime","2026-10-09T10:01:00Z"),("provisioningState","Updating")):
            f=fixture();f[0]["properties"][field]=value
            with self.assertRaises(Exception):T.normalize(*f)
        f=fixture();del f[2]["etag"]
        with self.assertRaises(Exception):T.normalize(*f)


if __name__=="__main__":unittest.main()
