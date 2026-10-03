#!/usr/bin/env python3
"""Pure private session policy. Commands are described here and owned by Node."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("session_plan_policy", ROOT / "prepare-plan-input.py")
Q = importlib.util.module_from_spec(spec); spec.loader.exec_module(Q)
P, A = Q.P, Q.A
spec = importlib.util.spec_from_file_location("session_evidence_policy", ROOT / "collect-evidence.py")
E = importlib.util.module_from_spec(spec); spec.loader.exec_module(E)
require = A.require
SOURCE_FILES = ("infra/development/azure/session-policy.py", "scripts/azure-development-session.mjs")
COMMON = {"schema_version", "source_sha256", "operation_name", "not_after_utc"}
RECONCILIATION_MODES = ("reconcile", "reconcile-partial")
FIELDS = {"execute": COMMON | {"plan_request", "plan_result", "plan_result_sha256"},
          "reconcile": COMMON | {"execute_request", "execute_directory", "execute_session_sha256", "execute_intent_sha256"},
          "prepare-dispose": COMMON | {"ownership_result", "ownership_result_sha256"},
          "dispose": COMMON | {"disposal_result", "disposal_result_sha256"}}
FIELDS["reconcile-partial"] = FIELDS["reconcile"]
MAX_JSON = 20 * 1024 * 1024
OUTPUTS = {"session.json": MAX_JSON, "mutation-intent.json": 65536, "result.json": MAX_JSON,
           "phases.json": MAX_JSON, "version.json": 65536, "rendered.json": MAX_JSON,
           "state.json": MAX_JSON, "final-state.json": MAX_JSON, "apply.stdout": MAX_JSON,
           "destroy.tfplan": Q.MAX_FILE, "evidence-request.json": 65536, "init.stdout": MAX_JSON, "prepare-dispose.stdout": MAX_JSON,
           **{"auth-" + n + ".json": 65536 for n in ("version", "extensions", "account", "subscription")}}
UUID = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)

def source_digest():
    entries = []
    for name in SOURCE_FILES:
        path = A.REPO / name; P.safe_path(path)
        entries.append([name, A.sha(path.read_bytes()), stat.S_IMODE(path.stat().st_mode)])
    return A.sha(json.dumps([Q.source_digest(), A.native_source_digest(), entries], separators=(",", ":")).encode())

def private(path):
    P.safe_path(path); return A.private_json(path)

def reference(path, digest):
    require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest), "reviewed digest required")
    value, actual = private(path); require(actual == digest, "reviewed private reference changed")
    return value

def private_bytes(path):
    # Bind every protected non-JSON output and Terraform state through its held descriptor.
    P.safe_path(path)
    expected = A.H._secure_regular_file(path, "private session output", path.suffix, MAX_JSON)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns)
        before = os.fstat(fd)
        require(identity(before) == identity(expected), "state replaced while opening")
        raw = os.read(fd, MAX_JSON + 1)
        require(identity(os.fstat(fd)) == identity(before) and len(raw) == before.st_size,
                "state changed during read")
        return raw
    finally: os.close(fd)

def raw_state(path):
    require(path.suffix==".tfstate", "Terraform state suffix required")
    raw=private_bytes(path);value,digest=A.strict_json(raw),A.sha(raw)
    require(value.get("version") == 4 and value.get("terraform_version") == "1.5.7"
            and type(value.get("serial")) is int and value["serial"] >= 0
            and isinstance(value.get("lineage"), str) and re.fullmatch(UUID, value["lineage"]),
            "qualified state lineage and serial required")
    require(isinstance(value.get("resources"), list), "state resources missing")
    return value, digest

def plan_inputs(path, result_path, result_hash):
    result = reference(result_path, result_hash)
    require(result.get("completed") is True and result.get("resource_count") == 11
            and result.get("source_sha256") == Q.source_digest(), "retained successful plan receipt required")
    phases, phases_hash = private(result_path.parent / "phases.json")
    require(phases_hash == result.get("phases_sha256") and phases == result.get("phases")
            and isinstance(phases, list) and len(phases) == 10, "retained plan phases changed")
    require(all(p.get("completed") is True and type(p.get("exitCode")) is int and p["exitCode"] == 0 for p in phases),
            "incomplete original plan")
    recorded = A.receipt_utc(phases[-1].get("endedAt"), "original plan completion")
    request, expected, documents, hashes, values, snapshot = Q.load_request(path, recorded)
    require(result_path == path.parent / request["operation_name"] / "result.json"
            and snapshot == result.get("input_sha256"), "original plan input custody changed")
    binary = result_path.parent / "plan.tfplan"
    digest, size = A.H.secure_plan_digest(binary)
    require(digest == result.get("binary_plan_sha256") and size == result.get("binary_plan_bytes"), "retained plan changed")
    return {"request": request, "expected": expected, "documents": documents, "hashes": hashes,
            "values": values, "snapshot": snapshot, "binary": str(binary), "result": result,
            "plan_request": str(path), "plan_result": str(result_path), "plan_result_sha256": result_hash}

def reconciliation_origin(request, now):
    """Retained admission consistency plus current custody, never original apply success."""
    path, directory = Path(request['execute_request']), Path(request['execute_directory'])
    P.safe_path(directory); A.H._require_private_directory(directory, 'original execution')
    intent_value = reference(directory/'mutation-intent.json', request['execute_intent_sha256'])
    recorded = A.receipt_utc(intent_value.get('createdAt'), 'original mutation intent time')
    require(recorded <= now, 'original intent is in the future')
    state, _, original, _, _ = verify('execute', path, directory, request['execute_session_sha256'], recorded)
    validate_intent('execute', directory, state, original, None, None, recorded)
    audit('execute', path, directory, request['execute_session_sha256'], recorded)
    require(not (directory/'work/errored.tfstate').exists(), 'emergency state requires separate recovery')
    raw, state_hash = raw_state(directory/'work/terraform.tfstate')
    require(raw['resources'], 'complete original state required')
    info = directory.stat()
    original['reconciliation'] = {'execute_request': str(path), 'execute_directory': str(directory),
        'execute_session_sha256': request['execute_session_sha256'],
        'execute_intent_sha256': request['execute_intent_sha256'], 'intent_time': recorded.isoformat(),
        'directory_identity': [info.st_dev, info.st_ino], 'retained_files': Q.tree(directory),
        'state_path': str(directory/'work/terraform.tfstate'), 'state_sha256': state_hash,
        'lineage': raw['lineage'], 'serial': raw['serial']}
    return original

def load_request(mode, path, now):
    require(mode in FIELDS, "fixed session mode required")
    request, digest = private(path)
    require(isinstance(request, dict) and set(request) == FIELDS[mode]
            and type(request["schema_version"]) is int and request["schema_version"] == 1, "exact session request required")
    require(request["source_sha256"] == source_digest(), "reviewed session source changed")
    require(isinstance(request["operation_name"], str) and re.fullmatch(r"nourishing-session-[0-9a-f]{12}", request["operation_name"]),
            "new private session name required")
    horizon = A.utc(request["not_after_utc"], "session deadline")
    require(now < horizon <= now + timedelta(minutes=20), "session horizon outside finite bound")
    ownership = disposal = None
    if mode == "execute":
        original = plan_inputs(Path(request["plan_request"]), Path(request["plan_result"]), request["plan_result_sha256"])
    elif mode in RECONCILIATION_MODES:
        original = reconciliation_origin(request, now)
        old = Path(request["execute_directory"])
        new = path.parent/request["operation_name"]
        require(old != new and old not in new.parents and new not in old.parents and old not in path.parents,
                "reconciliation must preserve the separate original directory")
    else:
        if mode == "dispose":
            disposal = reference(Path(request["disposal_result"]), request["disposal_result_sha256"])
            require(disposal.get("completed") is True and disposal.get("mode") == "prepare-dispose"
                    and disposal.get("source_sha256") == source_digest(), "reviewed disposal preparation required")
            require(now - timedelta(minutes=15) <= A.receipt_utc(disposal.get("completedAt"), "disposal plan completion") <= now,
                    "reviewed disposal plan expired")
            ownership_path, ownership_hash = disposal["ownership_result"], disposal["ownership_result_sha256"]
        else:
            ownership_path, ownership_hash = request["ownership_result"], request["ownership_result_sha256"]
        ownership = reference(Path(ownership_path), ownership_hash)
        require(ownership.get("completed") is True and ownership.get("mode") in ("execute", *RECONCILIATION_MODES)
                and ownership.get("source_sha256") == source_digest(), "completed owned session required")
        if ownership["mode"] in RECONCILIATION_MODES:
            require(ownership.get("reconciled") is True and ownership.get("original_execution_outcome") == "unconfirmed"
                    and ownership.get("external_quiescence_verified") is False, "distinct reconciled ownership required")
        original = plan_inputs(Path(ownership["plan_request"]), Path(ownership["plan_result"]), ownership["plan_result_sha256"])
        state, state_hash = raw_state(Path(ownership["state_path"]))
        require(state_hash == ownership["state_sha256"] and state["lineage"] == ownership["lineage"]
                and state["serial"] == ownership["serial"], "owned state changed or lost")
        if disposal:
            prepared, prepared_hash = raw_state(Path(disposal["state_path"]))
            require(prepared_hash == disposal["state_sha256"] and prepared == state, "reviewed deletion state differs")
            digest_plan, _ = A.H.secure_plan_digest(Path(disposal["binary_plan_path"]))
            require(digest_plan == disposal["binary_plan_sha256"], "reviewed deletion binary changed")
    if ownership and ownership['mode']=='reconcile-partial':
        require(ownership.get('ownership_scope')=='partial' and isinstance(ownership.get('state_addresses'),list)
                and ownership['state_addresses']==sorted(set(ownership['state_addresses'])), 'explicit partial ownership required')
        partial_addresses(set(ownership['state_addresses']))
        if disposal: require(disposal.get('ownership_scope')=='partial' and disposal.get('state_addresses')==ownership['state_addresses'], 'deletion subset differs')
    snapshot = {"source": request["source_sha256"], "request": digest, "plan": original["plan_result_sha256"],
                "inputs": original["snapshot"]}
    if mode in RECONCILIATION_MODES: snapshot["reconciliation"] = original["reconciliation"]
    if ownership: snapshot["ownership"] = ownership_hash
    if disposal: snapshot["disposal"] = request["disposal_result_sha256"]
    return request, original, ownership, disposal, snapshot

def prepare(mode, path, now):
    request, original, ownership, disposal, snapshot = load_request(mode, path, now)
    directory = path.parent / request["operation_name"]; directory.mkdir(mode=0o700)
    for name in ("work", "home", "tmp", "data"): (directory / name).mkdir(mode=0o700)
    mirror, _ = A.prepare_provider(directory, Path(original["request"]["provider_directory"]))
    for parent in [mirror, *mirror.parents]:
        if parent == directory: break
        parent.chmod(0o700)
    for name in Q.TF_FILES:
        data = (ROOT / name).read_bytes()
        fd = os.open(directory / "work" / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as out: out.write(data)
    Q.write_json(directory / "work/inputs.tfvars.json", original["values"])
    if ownership or mode in RECONCILIATION_MODES:
        state_path = Path(original["reconciliation"]["state_path"] if mode in RECONCILIATION_MODES else
                          disposal["state_path"] if disposal else ownership["state_path"])
        data = private_bytes(state_path)
        fd = os.open(directory / "work/terraform.tfstate", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as out: out.write(data)
    config = 'provider_installation {\n filesystem_mirror {\n  path = '+json.dumps(str(directory/'terraform/providers'))+'\n  include = ["registry.terraform.io/hashicorp/azurerm"]\n }\n}\n'
    fd = os.open(directory/'terraform.rc', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out: out.write(config)
    if mode == "execute":
        # The existing collector retains its original schema and directly owned commands.
        Q.write_json(directory/'evidence-request.json', {
            "schema_version": 1, "source_sha256": A.native_source_digest(),
            "identity_file": original["request"]["identity_file"], "profile_directory": original["request"]["profile_directory"],
            "operation_name": "nourishing-evidence-"+request["operation_name"].rsplit('-',1)[1],
            "not_after_utc": min(A.utc(request["not_after_utc"], "deadline"), now+timedelta(minutes=12)).isoformat().replace('+00:00','Z'),
            "shutdown_deadline_utc": original["values"]["shutdown_deadline_utc"]})
    baseline = Q.tree(directory); info = directory.stat()
    state = {"mode": mode, "request": str(path), "snapshot": snapshot, "baseline": baseline,
             "directory_identity": [info.st_dev, info.st_ino], "mirror": str(mirror), "createdAt": now.isoformat()}
    Q.write_json(directory/'session.json', state)
    require(load_request(mode, path, now)[-1] == snapshot, "session inputs changed while preparing")
    return {"directory": str(directory), "state_sha256": A.sha((directory/'session.json').read_bytes()),
            "terraform": {"path": original["request"]["terraform"], "sha256": A.TF_SHA256},
            "azure": {"path": "/usr/bin/az", "sha256": P.CLI_SHA256}, "auth_commands": P.commands(original["expected"]),
            "profile_directory": original["request"]["profile_directory"], "subscription_id": original["expected"]["subscriptionId"],
            "tenant_id": original["expected"]["tenantId"], "binary_plan_path": disposal["binary_plan_path"] if disposal else original["binary"],
            "binary_plan_sha256": disposal["binary_plan_sha256"] if disposal else original["result"]["binary_plan_sha256"]}

def verify(mode, path, directory, state_hash, now):
    P.safe_path(directory); A.H._require_private_directory(directory, "owned session")
    state = reference(directory/'session.json', state_hash)
    request, original, ownership, disposal, snapshot = load_request(mode, path, now)
    info = directory.stat()
    require(state['mode'] == mode and state['request'] == str(path) and state['snapshot'] == snapshot
            and state['directory_identity'] == [info.st_dev, info.st_ino]
            and directory == path.parent/request['operation_name'], "session ownership or inputs changed")
    # The provider/source baseline is immutable; only the local state is expected to change.
    current = Q.tree(directory)
    for name, value in state['baseline'].items():
        if mode in RECONCILIATION_MODES or name != 'work/terraform.tfstate': require(current.get(name) == value, "fixed session input changed")
    link = 'data/providers/registry.terraform.io/hashicorp/azurerm/4.79.0/linux_amd64'
    parents = {str(p) for p in Path(link).parents if str(p) != '.'}
    evidence_name = 'nourishing-evidence-'+request['operation_name'].rsplit('-',1)[1]
    allowed_state = {'work/terraform.tfstate', 'work/terraform.tfstate.backup', 'work/errored.tfstate'}
    for name, entry in current.items():
        if name in allowed_state:
            require(entry['type']=='file' and entry['mode']==0o600 and entry['size']<=MAX_JSON, "unsafe mutable state")
            continue
        if name in state['baseline'] or name == 'session.json': continue
        if mode == 'execute' and (name == evidence_name or name.startswith(evidence_name+'/')): continue
        if name == link: require(entry == {'type':'link','target':state['mirror']}, "provider link changed")
        elif name in parents: require(entry == {'type':'directory'}, "unexpected provider directory")
        else:
            maximum = MAX_JSON if name in allowed_state or re.fullmatch(r'(?:before|after)-[a-z-]+\.json', name) else OUTPUTS.get(name)
            require(maximum is not None and entry['type'] == 'file' and entry['mode'] == 0o600
                    and entry['size'] <= maximum, "unexpected or oversized private session output")
    if (directory/evidence_name).exists(): E.tree(directory/evidence_name)
    return state, request, original, ownership, disposal

def authenticate(mode, path, directory, digest, now):
    _, _, original, _, _ = verify(mode,path,directory,digest,now)
    for label, _ in P.commands(original['expected']):
        value,_ = private(directory/('auth-'+label+'.json')); P.validate_response(label,value,original['expected'])

def ids(values):
    base='/subscriptions/'+values['subscription_id']+'/resourceGroups/'+values['name_prefix']+'-rg'
    prefix=values['name_prefix']
    return {'group':base, 'vnet':base+'/providers/Microsoft.Network/virtualNetworks/'+prefix+'-vnet',
            'subnet':base+'/providers/Microsoft.Network/virtualNetworks/'+prefix+'-vnet/subnets/'+prefix+'-subnet',
            'nsg':base+'/providers/Microsoft.Network/networkSecurityGroups/'+prefix+'-nsg',
            'pip':base+'/providers/Microsoft.Network/publicIPAddresses/'+prefix+'-pip',
            'nic':base+'/providers/Microsoft.Network/networkInterfaces/'+prefix+'-nic',
            'vm':base+'/providers/Microsoft.Compute/virtualMachines/'+prefix+'-vm',
            'os':base+'/providers/Microsoft.Compute/disks/'+prefix+'-os',
            'data':base+'/providers/Microsoft.Compute/disks/'+prefix+'-data',
            'schedule':base+'/providers/Microsoft.DevTestLab/schedules/shutdown-computevm-'+prefix+'-vm'}

STATE_LABELS = {
    'azurerm_resource_group.development':'group', 'azurerm_virtual_network.development':'vnet',
    'azurerm_subnet.development':'subnet', 'azurerm_network_security_group.development':'nsg',
    'azurerm_public_ip.development':'pip', 'azurerm_network_interface.development':'nic',
    'azurerm_linux_virtual_machine.development':'vm', 'azurerm_managed_disk.data':'data',
    'azurerm_dev_test_global_vm_shutdown_schedule.development':'schedule'}
ASSOCIATION = 'azurerm_subnet_network_security_group_association.development'
ATTACHMENT = 'azurerm_virtual_machine_data_disk_attachment.data'
GROUP = 'azurerm_resource_group.development'
VM = 'azurerm_linux_virtual_machine.development'

def partial_addresses(addresses):
    require(isinstance(addresses,(set,frozenset)) and GROUP in addresses and addresses < A.EXPECTED,
            'nonempty proper owned subset containing resource group required')
    dependencies=[(a,t.rsplit('.',1)[0]) for a,_,t in A.REFERENCES]
    dependencies += [('azurerm_subnet.development','azurerm_virtual_network.development')]
    require(all(a not in addresses or target in addresses for a,target in dependencies), 'orphaned partial-state relationship')
    return addresses

def partial_mode(mode,ownership):
    return mode=='reconcile-partial' or ownership is not None and ownership['mode']=='reconcile-partial'

def subset_ids(values,addresses):
    names={STATE_LABELS[a] for a in addresses if a in STATE_LABELS}
    if VM in addresses:names.add('os')
    return {k:v for k,v in ids(values).items() if k in names}

def read_commands(values, stage, addresses=None):
    owned=ids(values); sub=values['subscription_id']
    if addresses is not None:owned=subset_ids(values,partial_addresses(addresses))
    rows=[('groups','/subscriptions/'+sub+'/resourcegroups','2021-04-01')]
    if stage == 'resources':
        rows=[(key,value,'2021-04-01' if key=='group' else '2018-09-15' if key=='schedule' else
               '2026-03-01' if key=='vm' else '2026-03-02' if key in ('os','data') else '2025-09-01') for key,value in owned.items()]
        rows += [('members',owned['group']+'/resources','2021-04-01')]
        if 'vm' in owned:rows.append(('extensions',owned['vm']+'/extensions','2026-03-01'))
    return [{'label':label,'arguments':['rest','--method','get','--url','https://management.azure.com'+path+'?api-version='+version,
            '--subscription',sub,'--only-show-errors','--output','json']} for label,path,version in rows]

def resource_reads(mode,directory,original,ownership):
    addresses=None
    if partial_mode(mode,ownership):
        _,_,_,resources=retained_graph(directory,original['values'],partial=True)
        addresses=set(resources)
        if ownership:require(sorted(addresses)==ownership['state_addresses'],'owned subset changed')
    return read_commands(original['values'],'resources',addresses)

def documents(directory,prefix,values,stage,addresses=None):
    return {row['label']:private(directory/(prefix+'-'+row['label']+'.json'))[0] for row in read_commands(values,stage,addresses)}

def absent(document,values):
    require(isinstance(document,dict) and document.get('nextLink') in (None,'') and isinstance(document.get('value'),list), "complete resource-group inventory required")
    require(all(isinstance(v,dict) and isinstance(v.get('id'),str) for v in document['value']), "malformed group inventory")
    require(ids(values)['group'].lower() not in {v['id'].lower() for v in document['value']}, "target resource group exists")

def arm_id(value,expected):
    require(isinstance(value,str) and value.lower()==expected.lower(), "resource relationship or identity differs")

def neutral(value): return value in (None, [], {}, False, '')

def live_graph(doc,values,addresses=None):
    selected=A.EXPECTED if addresses is None else partial_addresses(addresses)
    owned=ids(values) if addresses is None else subset_ids(values,selected)
    generations={}
    for key,expected in owned.items():
        item=doc[key]; require(isinstance(item,dict), "resource response missing")
        arm_id(item.get('id'),expected)
        props=item.get('properties',{})
        require(props.get('provisioningState')=='Succeeded', "resource is not terminal and successful")
        if key not in ('subnet',): require(item.get('location','').lower().replace(' ','')==A.LOCATION, "resource location changed")
        generation = props.get('vmId') if key=='vm' else props.get('uniqueId') if key in ('os','data') else props.get('uniqueIdentifier') if key=='schedule' else props.get('resourceGuid') if key in ('vnet','nsg','nic','pip') else None
        if key not in ('group','subnet'):
            require(isinstance(generation,str) and re.fullmatch(UUID,generation), "stable generation identity missing")
            generations[key]=generation.lower()
    members=doc['members']; require(isinstance(members.get('value'),list) and members.get('nextLink') in (None,''), "complete group membership required")
    actual=[v.get('id','').lower() for v in members['value']]
    expected={v.lower() for k,v in owned.items() if k not in ('group','subnet')}
    require(len(actual)==len(set(actual)) and set(actual)==expected, "foreign or missing group resource")
    if 'vm' in owned:
        require(doc['extensions'].get('value')==[] and doc['extensions'].get('nextLink') in (None,''), "unexpected VM extension")
        vm=doc['vm']['properties']; require(vm.get('hardwareProfile',{}).get('vmSize')==A.SKU, "VM size changed")
        require(vm.get('platformFaultDomain') is None and vm.get('virtualMachineScaleSet') is None, "live VM fault domain or scale set differs")
        budget=vm.get('extensionsTimeBudget')
        require(budget is None or type(budget) is str and budget=='PT1H30M', "live VM extensions time budget differs")
        events=vm.get('scheduledEventsProfile')
        require(events is None or isinstance(events,dict) and set(events)<={'terminateNotificationProfile'}, "unreviewed scheduled events profile")
        termination=events.get('terminateNotificationProfile') if events is not None else None
        require(termination is None or isinstance(termination,dict)
                and set(termination)<={'enable','notBeforeTimeout'} and termination.get('enable') is False
                and termination.get('notBeforeTimeout') in (None,'PT5M'), "live termination notification differs")
        nics=vm.get('networkProfile',{}).get('networkInterfaces'); require(isinstance(nics,list) and len(nics)==1, "exact VM NIC required");arm_id(nics[0].get('id'),owned['nic'])
        storage=vm.get('storageProfile',{}); os_disk=storage.get('osDisk',{});arm_id(os_disk.get('managedDisk',{}).get('id'),owned['os'])
        disks=storage.get('dataDisks');require(isinstance(disks,list), 'VM data disks missing')
        if ATTACHMENT in selected:
            require(len(disks)==1 and disks[0].get('lun')==0 and (addresses is None or type(disks[0]['lun']) is int), 'exact VM data disk required');arm_id(disks[0].get('managedDisk',{}).get('id'),owned['data'])
        else:require(disks==[], 'unrecorded VM data disk')
    for key in ('os','data'):
        if key not in owned:continue
        disk=doc[key]; props=disk['properties']
        if key=='os' or ATTACHMENT in selected:arm_id(disk.get('managedBy'),owned['vm'])
        else:require(disk.get('managedBy') in (None,''), 'unrecorded data-disk owner')
        require(disk.get('managedByExtended') in (None,[]) and props.get('diskSizeGB')==64
                and disk.get('sku',{}).get('name')=='StandardSSD_LRS' and props.get('maxShares') in (None,1), "disk ownership or shape differs")
    if 'subnet' in owned:
        subnet=doc['subnet']['properties']
        if ASSOCIATION in selected:arm_id(subnet.get('networkSecurityGroup',{}).get('id'),owned['nsg'])
        else:require(subnet.get('networkSecurityGroup') is None, 'unrecorded subnet NSG')
        require(subnet.get('addressPrefix')=='10.43.1.0/24' or subnet.get('addressPrefixes')==['10.43.1.0/24'], "subnet differs")
        for key in ('delegations','privateEndpoints','serviceAssociationLinks','resourceNavigationLinks','serviceEndpoints','serviceEndpointPolicies'):
            require(neutral(subnet.get(key)), "foreign subnet relationship")
    if 'vnet' in owned:
        vnet=doc['vnet']['properties'];require(vnet.get('addressSpace',{}).get('addressPrefixes')==['10.43.0.0/16'] and neutral(vnet.get('virtualNetworkPeerings')), "VNet differs")
        require(isinstance(vnet.get('subnets'),list), 'subnet membership missing')
        if 'subnet' in owned:
            require(len(vnet['subnets'])==1, 'exact subnet membership required');arm_id(vnet['subnets'][0].get('id'),owned['subnet'])
        else:require(vnet['subnets']==[], 'unrecorded subnet')
    if 'nic' in owned:
        nic=doc['nic']['properties']
        if 'vm' in owned:arm_id(nic.get('virtualMachine',{}).get('id'),owned['vm'])
        else:require(nic.get('virtualMachine') is None, 'unrecorded NIC owner')
        require(nic.get('enableIPForwarding') is False and nic.get('enableAcceleratedNetworking') is False, "NIC policy differs")
        configs=nic.get('ipConfigurations'); require(isinstance(configs,list) and len(configs)==1 and configs[0].get('name')=='primary', "NIC configurations differ")
        ip=configs[0]['properties'];arm_id(ip.get('subnet',{}).get('id'),owned['subnet']);arm_id(ip.get('publicIPAddress',{}).get('id'),owned['pip'])
        require(ip.get('gatewayLoadBalancer') is None, "live NIC gateway not admitted")
        for key in ('applicationGatewayBackendAddressPools','loadBalancerBackendAddressPools','loadBalancerInboundNatRules','applicationSecurityGroups'):
            require(neutral(ip.get(key)), "foreign NIC relationship")
        require([x.get('id','').lower() for x in subnet.get('ipConfigurations',[])]==[configs[0]['id'].lower()], "foreign subnet attachment")
    if 'pip' in owned:
        if 'nic' in owned:arm_id(doc['pip']['properties'].get('ipConfiguration',{}).get('id'),configs[0]['id'])
        else:require(doc['pip']['properties'].get('ipConfiguration') is None, 'unrecorded public IP attachment')
        idle=doc['pip']['properties'].get('idleTimeoutInMinutes')
        require(type(idle) is int and idle==4, "live public IP idle timeout must be integer 4")
        require(doc['pip'].get('sku',{}).get('name')=='Standard' and doc['pip']['properties'].get('publicIPAllocationMethod')=='Static'
                and doc['pip']['properties'].get('publicIPAddressVersion')=='IPv4', "public IP differs")
    if 'nsg' in owned:
        nsg=doc['nsg']['properties'];require(neutral(nsg.get('networkInterfaces')) and [x.get('id','').lower() for x in nsg.get('subnets',[])]==([owned['subnet'].lower()] if ASSOCIATION in selected else []), "foreign NSG attachment")
        rules=A.unique(nsg.get('securityRules'),'name','NSG rules');expected_rules=A.expected_values(values)['azurerm_network_security_group.development']['security_rule']
        require(set(rules)=={r['name'] for r in expected_rules}, "NSG rule set differs")
        fields={'priority':'priority','direction':'direction','access':'access','protocol':'protocol','source_port_range':'sourcePortRange',
                'destination_port_range':'destinationPortRange','source_address_prefix':'sourceAddressPrefix','destination_address_prefix':'destinationAddressPrefix'}
        for expected in expected_rules:
            rule=rules[expected['name']]['properties'];require(rule.get('provisioningState')=='Succeeded', "NSG rule pending")
            require(all(rule.get(arm)==expected[key] for key,arm in fields.items()), "NSG rule policy differs")
            for key in ('sourcePortRanges','destinationPortRanges','sourceAddressPrefixes','destinationAddressPrefixes','sourceApplicationSecurityGroups','destinationApplicationSecurityGroups'):
                require(neutral(rule.get(key)), "unreviewed NSG plural rule")
    if 'schedule' in owned:
        schedule=doc['schedule']['properties'];arm_id(schedule.get('targetResourceId'),owned['vm'])
        require(schedule.get('status')=='Enabled' and schedule.get('taskType')=='ComputeVmShutdownTask'
                and schedule.get('timeZoneId')=='UTC' and schedule.get('dailyRecurrence',{}).get('time')==A.utc(values['shutdown_deadline_utc'],'shutdown').strftime('%H%M'), "shutdown contract differs")
        notifications=schedule.get('notificationSettings',{})
        require(notifications.get('status')=='Disabled' and neutral(notifications.get('webhookUrl')) and neutral(notifications.get('emailRecipient')), "shutdown notification differs")
    if 'subnet' in owned and 'nic' not in owned:require(doc['subnet']['properties'].get('ipConfigurations',[])==[], 'unrecorded subnet NIC')
    return {'ids':owned,'generations':generations,'readback_sha256':A.sha(canonical(doc).encode())}

def state_graph(document, values, partial=False):
    require(document.get('format_version')=='1.0' and document.get('terraform_version')=='1.5.7', "qualified state renderer required")
    root=document.get('values',{}).get('root_module',{})
    require(not root.get('child_modules'), "nested state module rejected")
    resources=A.unique(root.get('resources'),'address','state resources')
    if partial:partial_addresses(set(resources))
    else:require(set(resources)==A.EXPECTED, 'exact owned state graph required')
    owned=ids(values); labels=STATE_LABELS
    expected=A.expected_values(values)
    for address,item in resources.items():
        require(item.get('mode')=='managed' and item.get('provider_name')==A.PROVIDER and item.get('schema_version')==A.SCHEMAS[address]
                and item.get('type')==address.split('.')[0] and item.get('name')==address.split('.')[1], "state provider/address differs")
        actual=item.get('values');require(isinstance(actual,dict) and isinstance(actual.get('id'),str), "state values missing")
        if address in labels: arm_id(actual['id'],owned[labels[address]])
        if partial:
            require(type(item.get('schema_version')) is int, 'integer partial-state schema required')
            if address==ASSOCIATION:arm_id(actual['id'],owned['subnet'])
            if address==ATTACHMENT:arm_id(actual['id'],owned['vm']+'/dataDisks/'+values['name_prefix']+'-data')
        A.known_provider_defaults(address,actual)
        if address=='azurerm_linux_virtual_machine.development': A.termination_notification(actual.get('termination_notification'))
        if address=='azurerm_network_interface.development':
            configs=actual.get('ip_configuration')
            require(isinstance(configs,list) and len(configs)==1 and isinstance(configs[0],dict)
                    and type(configs[0].get('gateway_load_balancer_frontend_ip_configuration_id')) is str
                    and configs[0]['gateway_load_balancer_frontend_ip_configuration_id']=='', "resolved NIC gateway must be empty")
        sanitized=json.loads(canonical(actual))
        for path in A.UNKNOWN_RULES[address][1]:
            configured=expected[address]
            for key in path:
                if isinstance(configured,dict): configured=configured.get(key)
                elif isinstance(configured,list) and isinstance(key,int) and key<len(configured): configured=configured[key]
                else: configured=None;break
            if configured is not None: continue
            parent=sanitized
            for key in path[:-1]:
                if not isinstance(parent,(dict,list)) or isinstance(parent,dict) and key not in parent or isinstance(parent,list) and key>=len(parent): parent=None;break
                parent=parent[key]
            if isinstance(parent,dict) and path[-1] in parent:parent[path[-1]]=None
            elif isinstance(parent,list) and isinstance(path[-1],int) and path[-1]<len(parent):parent[path[-1]]=None
        A.match(sanitized,expected[address],address)
    def value(address,*keys):
        result=resources[address]['values']
        for key in keys:result=result[key]
        return result
    for address,path,target in A.REFERENCES:
        if address not in resources:continue
        actual=value(address,*path)
        if isinstance(actual,list):require(len(actual)==1,"one relationship required");actual=actual[0]
        arm_id(actual,resources[target.rsplit('.',1)[0]]['values']['id'])
    if VM in resources:arm_id(value(VM,'os_disk',0,'id'),owned['os'])
    return resources

def retained_graph(directory,value,partial=False):
    raw,digest=raw_state(directory/'work/terraform.tfstate')
    document,_=private(directory/'state.json');resources=state_graph(document,value,partial)
    # Both representations must describe the same state, including every managed instance.
    raw_resources={r.get('type','')+'.'+r.get('name',''):r for r in raw['resources']}
    require(len(raw_resources)==len(raw['resources']) and set(raw_resources)==set(resources), "raw state graph differs")
    for address,item in raw_resources.items():
        require(item.get('mode')=='managed' and item.get('provider')=='provider["'+A.PROVIDER+'"]'
                and not item.get('module') and isinstance(item.get('instances'),list)
                and len(item['instances'])==1 and not item['instances'][0].get('deposed'), "ambiguous state instance")
        require(canonical(item['instances'][0].get('attributes'))==canonical(resources[address]['values']), "rendered state attributes differ")
        if partial:
            instance=item['instances'][0]
            require(instance.get('status') is None and instance.get('deposed') is None and 'index_key' not in instance
                    and type(instance.get('schema_version')) is int and instance['schema_version']==resources[address]['schema_version'], 'ambiguous partial instance')
    return raw,digest,document,resources

def current_ownership(directory, prefix, original, partial=False):
    value=original['values'];raw,digest,document,resources=retained_graph(directory,value,partial)
    rendered_hash=private(directory/'state.json')[1]
    addresses=set(resources) if partial else None
    live=documents(directory,prefix,value,'resources',addresses);binding=live_graph(live,value,addresses)
    for address,field,key in [('azurerm_linux_virtual_machine.development','virtual_machine_id','vm'),
                              ('azurerm_virtual_network.development','guid','vnet')]:
        if address not in resources:continue
        generation=resources[address]['values'].get(field)
        require(isinstance(generation,str) and re.fullmatch(UUID,generation)
                and generation.lower()==binding['generations'][key], 'retained state and live generation differ')
    if partial:binding.update(ownership_scope='partial',state_addresses=sorted(resources))
    return {**binding,'state_path':str(directory/'work/terraform.tfstate'),'state_sha256':digest,
            'lineage':raw['lineage'],'serial':raw['serial'],'state_rendered_sha256':rendered_hash},document

def same_owned(actual, expected):
    require(actual.get('ownership_scope')==expected.get('ownership_scope') and actual.get('state_addresses')==expected.get('state_addresses')
            and actual['ids']==expected['ids'] and actual['generations']==expected['generations']
            and actual['readback_sha256']==expected['readback_sha256'] and actual['lineage']==expected['lineage']
            and actual['serial']==expected['serial'] and actual['state_sha256']==expected['state_sha256'],
            "owned state, resource generation or readback changed")

def audit_destroy(document, state, original, now, partial=False):
    require(document.get('format_version')=='1.2' and document.get('terraform_version')=='1.5.7', "qualified deletion plan renderer required")
    require(now-timedelta(minutes=15)<=A.utc(document.get('timestamp'),'deletion plan time')<=now, "deletion plan expired")
    require(document.get('resource_drift') in (None,[]) and document.get('deferred_changes') in (None,[]), "deletion drift or deferred work")
    require(canonical(document.get('prior_state',{}).get('values'))==canonical(state['values']), "deletion plan prior state differs")
    resources=state_graph(state,original['values'],partial);changes=A.unique(document.get('resource_changes'),'address','deletion changes')
    require(set(changes)==set(resources), "exact deletion graph required")
    for address,item in changes.items():
        change=item.get('change',{})
        require(item.get('mode')=='managed' and item.get('type')==resources[address]['type']
                and item.get('name')==resources[address]['name'] and item.get('provider_name')==A.PROVIDER
                and change.get('actions')==['delete'] and change.get('after') is None
                and canonical(change.get('before'))==canonical(resources[address]['values'])
                and change.get('replace_paths') in (None,[]) and change.get('importing') is None, "unreviewed deletion action")
    planned=document.get('planned_values',{}).get('root_module',{})
    require(not planned.get('resources') and not planned.get('child_modules'), "deletion plan leaves resources")
    A.H._audit_provider_configuration(document.get('configuration',{}))
    configured=document.get('configuration',{}).get('root_module',{})
    require(not configured.get('module_calls'), "unreviewed deletion module")
    for item in configured.get('resources',[]):
        require(not any(item.get(key) for key in ('provisioners','connection','count_expression','for_each_expression')), "unreviewed deletion configuration")

def fresh_evidence(directory, request, original, now):
    evidence_dir=directory/('nourishing-evidence-'+request['operation_name'].rsplit('-',1)[1])
    index,_=private(evidence_dir/'index.json')
    require(index.get('completed') is True and index.get('source_sha256')==A.native_source_digest(), "fresh maintained collector result required")
    docs,hashes={},{}
    for kind in A.EVIDENCE_KINDS:docs[kind],hashes[kind]=private(evidence_dir/(kind+'.json'))
    require(hashes==index.get('evidence_sha256'), "fresh family changed")
    return A.evidence_values(docs,hashes,original['expected']['subscriptionId'],A.utc(original['values']['shutdown_deadline_utc'],'shutdown'),now)

def audit(mode,path,directory,digest,now):
    _,request,original,ownership,disposal=verify(mode,path,directory,digest,now)
    version,_=private(directory/'version.json');require(version.get('terraform_version')=='1.5.7' and version.get('platform')=='linux_amd64', "Terraform identity differs")
    if mode=='execute':
        document,rendered_hash=private(directory/'rendered.json')
        require(rendered_hash==original['result']['rendered_sha256'], "retained binary rendered differently")
        A.audit_plan(document,original['documents'],original['hashes'],now)
        fresh_evidence(directory,request,original,now)
        absent(documents(directory,'before',original['values'],'groups')['groups'],original['values'])
    else:
        authenticate(mode,path,directory,digest,now)
        current,state=current_ownership(directory,'before',original,partial_mode(mode,ownership))
        if mode in RECONCILIATION_MODES:
            retained=original['reconciliation']
            require(all(current[key]==retained[key] for key in ('state_sha256','lineage','serial')), 'original state copy changed')
            document,rendered_hash=private(directory/'rendered.json')
            require(rendered_hash==original['result']['rendered_sha256'], 'original binary rendered differently')
            A.audit_plan(document,original['documents'],original['hashes'],A.receipt_utc(retained['intent_time'],'historical intent time'))
        else:same_owned(current,ownership)
        if mode=='dispose':
            require(current['state_sha256']==disposal['state_sha256'], "reviewed disposal state changed")
            document,rendered_hash=private(directory/'rendered.json');require(rendered_hash==disposal['rendered_sha256'], "reviewed deletion rendering changed")
            audit_destroy(document,state,original,now,partial_mode(mode,ownership))
    return original

def intent(mode,path,directory,digest,now):
    require(mode in ('execute','dispose'), "only apply modes create mutation intent")
    original=audit(mode,path,directory,digest,now)
    state,request,_,ownership,disposal=verify(mode,path,directory,digest,now)
    binary=Path(disposal['binary_plan_path']) if disposal else Path(original['binary'])
    binary_hash,_=A.H.secure_plan_digest(binary)
    value={'mode':mode,'createdAt':now.isoformat(),'outcome':'unknown-until-reconciled',
           'source_sha256':source_digest(),'request_sha256':state['snapshot']['request'],
           'binary_plan_sha256':binary_hash,'owned_state_sha256':ownership['state_sha256'] if ownership else None,
           'limits':'Local process settlement is not remote cancellation. Readbacks do not make provider deletion conditional.'}
    A.publish_result(directory/'mutation-intent.json',value)
    return {'published':True,'sha256':A.private_json(directory/'mutation-intent.json')[1]}

def validate_intent(mode, directory, state, original, ownership, disposal, now):
    value, digest = private(directory/'mutation-intent.json')
    created = A.receipt_utc(value.get('createdAt'), 'mutation intent time')
    binary = Path(disposal['binary_plan_path']) if disposal else Path(original['binary'])
    binary_hash, _ = A.H.secure_plan_digest(binary)
    expected = {'mode':mode,'createdAt':value['createdAt'],'outcome':'unknown-until-reconciled',
                'source_sha256':source_digest(),'request_sha256':state['snapshot']['request'],
                'binary_plan_sha256':binary_hash,'owned_state_sha256':ownership['state_sha256'] if ownership else None,
                'limits':'Local process settlement is not remote cancellation. Readbacks do not make provider deletion conditional.'}
    require(value == expected and A.receipt_utc(state['createdAt'],'session start') <= created <= now,
            'mutation intent identity or content changed')
    return digest, created

def completion_phases(mode, directory, state, original, ownership, disposal, phases, now):
    """Bind the fixed direct-child sequence to its retained outputs and original binary."""
    require(isinstance(phases,list) and all(isinstance(p,dict) for p in phases), 'phase records missing')
    plan_phase = 'show-dispose' if mode=='prepare-dispose' else 'show'
    shows = [p for p in phases if p.get('phase')==plan_phase]
    require(len(shows)==1, 'one retained binary rendering required')
    arguments = shows[0].get('arguments')
    require(isinstance(arguments,list) and len(arguments)==3 and arguments[:2]==['show','-json']
            and isinstance(arguments[2],str) and re.fullmatch(r'/proc/[1-9][0-9]*/fd/[0-9]+',arguments[2]),
            'held binary descriptor arguments required')
    descriptor = arguments[2]
    binary = directory/'destroy.tfplan' if mode=='prepare-dispose' else Path(disposal['binary_plan_path']) if disposal else Path(original['binary'])
    binary_hash, _ = A.H.secure_plan_digest(binary)
    rows=[]
    if mode!='execute':
        rows += [('auth-'+label,P.CLI_SHA256,[*args,'--only-show-errors','--output','json'],'auth-'+label+'.json') for label,args in P.commands(original['expected'])]
    rows += [('version',A.TF_SHA256,['version','-json'],'version.json'),
             ('init',A.TF_SHA256,['init','-backend=false','-lockfile=readonly','-input=false','-no-color'],'init.stdout')]
    addresses=None
    if partial_mode(mode,ownership):
        rendered_state=private(directory/'state.json')[0]
        addresses=set(state_graph(rendered_state,original['values'],partial=True))
        if ownership:require(sorted(addresses)==ownership['state_addresses'], 'completion subset differs')
    if mode!='execute':
        rows.append(('state',A.TF_SHA256,['show','-json',str(directory/'work/terraform.tfstate')],'state.json'))
        rows += [('before-'+r['label'],P.CLI_SHA256,r['arguments'],'before-'+r['label']+'.json') for r in read_commands(original['values'],'resources',addresses)]
    if mode in RECONCILIATION_MODES:
        rows.append(('show',A.TF_SHA256,['show','-json',descriptor],'rendered.json'))
    elif mode=='prepare-dispose':
        rows += [('prepare-dispose',A.TF_SHA256,['plan','-destroy','-input=false','-no-color','-lock-timeout=0s','-parallelism=1','-var-file=inputs.tfvars.json','-out='+str(binary)],'prepare-dispose.stdout'),
                 ('show-dispose',A.TF_SHA256,['show','-json',descriptor],'rendered.json')]
    else:
        rows.append(('show',A.TF_SHA256,['show','-json',descriptor],'rendered.json'))
        if mode=='execute': rows += [('before-'+r['label'],P.CLI_SHA256,r['arguments'],'before-'+r['label']+'.json') for r in read_commands(original['values'],'groups')]
        rows += [('apply',A.TF_SHA256,['apply','-input=false','-no-color','-lock-timeout=0s','-parallelism=1',descriptor],'apply.stdout'),
                 ('state-after',A.TF_SHA256,['show','-json',str(directory/'work/terraform.tfstate')],'state.json' if mode=='execute' else 'final-state.json')]
        rows += [('after-'+r['label'],P.CLI_SHA256,r['arguments'],'after-'+r['label']+'.json') for r in read_commands(original['values'],'resources' if mode=='execute' else 'groups')]
    require([p.get('phase') for p in phases]==[r[0] for r in rows], 'fixed ordered phase sequence differs')
    last=A.receipt_utc(state['createdAt'],'session start'); intent_hash=intent_time=None
    if mode in ('execute','dispose'):intent_hash,intent_time=validate_intent(mode,directory,state,original,ownership,disposal,now)
    else:require(not (directory/'mutation-intent.json').exists(), 'unexpected mutation intent during read-only mode')
    for phase,(label,executable,args,output) in zip(phases,rows):
        keys={'phase','completed','exitCode','startedAt','endedAt','executableSha256','arguments','argumentsSha256','stdoutBytes','stdoutSha256'}
        if label in ('show','show-dispose','apply'):keys.add('binaryPlanSha256')
        require(set(phase)==keys and phase['completed'] is True and type(phase['exitCode']) is int and phase['exitCode']==0,
                'incomplete or malformed direct child record')
        start=A.receipt_utc(phase['startedAt'],'phase start');end=A.receipt_utc(phase['endedAt'],'phase end')
        require(last<=start<=end<=now, 'phase sequence time differs');last=end
        require(phase['executableSha256']==executable and phase['arguments']==args
                and phase['argumentsSha256']==A.sha(json.dumps(args,ensure_ascii=False,separators=(',',':')).encode()),
                'direct child tool or arguments changed')
        raw=private_bytes(directory/output)
        require(type(phase['stdoutBytes']) is int and phase['stdoutBytes']==len(raw)
                and phase['stdoutSha256']==A.sha(raw), 'retained output differs from observed child bytes')
        if label in ('show','show-dispose','apply'):require(phase['binaryPlanSha256']==binary_hash, 'rendered/applied binary differs')
        if label=='apply':require(intent_time<=start, 'apply preceded durable intent')
    return intent_hash


def finish(mode,path,directory,digest,now):
    state,request,original,ownership,disposal=verify(mode,path,directory,digest,now)
    phases,phases_hash=private(directory/'phases.json')
    intent_hash=completion_phases(mode,directory,state,original,ownership,disposal,phases,now)
    result={'completed':True,'mode':mode,'source_sha256':source_digest(),'completedAt':now.isoformat(),
            'input_sha256':state['snapshot'],'phases_sha256':phases_hash,'mutation_intent_sha256':intent_hash,
            'plan_request':original['plan_request'],'plan_result':original['plan_result'],
            'plan_result_sha256':original['plan_result_sha256'],
            'scope':'Empty-host session policy and observed resource lifecycle only; no runtime or release acceptance.'}
    if mode=='execute':
        audit(mode,path,directory,digest,now)
        current,_=current_ownership(directory,'after',original);result.update(current)
    elif mode in RECONCILIATION_MODES:
        audit(mode,path,directory,digest,now)
        current,_=current_ownership(directory,'before',original,partial_mode(mode,ownership))
        result.update(current,reconciled=True,original_execution_outcome='unconfirmed',external_quiescence_verified=False,
            historical_admission_scope='Retained policy consistency at the recorded intent time; no original observation chronology or apply-success attestation.',
            scope='Current complete-state ownership only. Original local settlement and exclusive use are external preconditions; no original apply success or shutdown observation.')
        if mode=='reconcile-partial':result['scope']='Current terminal partial-state ownership only; no complete deployment, original apply success or shutdown protection. Local settlement and exclusive use remain external preconditions.'
    elif mode=='prepare-dispose':
        authenticate(mode,path,directory,digest,now)
        current,current_state=current_ownership(directory,'before',original,partial_mode(mode,ownership));same_owned(current,ownership)
        document,rendered_hash=private(directory/'rendered.json');audit_destroy(document,current_state,original,now,partial_mode(mode,ownership))
        binary=directory/'destroy.tfplan';binary_hash,_=A.H.secure_plan_digest(binary)
        result.update(current,ownership_result=request['ownership_result'],ownership_result_sha256=request['ownership_result_sha256'],
                      binary_plan_path=str(binary),binary_plan_sha256=binary_hash,rendered_sha256=rendered_hash,
                      scope='Saved deletion plan prepared for separate review; no deletion attempted.')
    else:
        authenticate(mode,path,directory,digest,now)
        final,final_hash=raw_state(directory/'work/terraform.tfstate')
        require(final['lineage']==ownership['lineage'] and final['serial']>ownership['serial'] and final['resources']==[], "deletion state incomplete")
        rendered,_=private(directory/'final-state.json')
        require(rendered.get('format_version')=='1.0' and not rendered.get('values',{}).get('root_module',{}).get('resources') and not rendered.get('values',{}).get('root_module',{}).get('child_modules'), "remaining rendered resource")
        absent(documents(directory,'after',original['values'],'groups')['groups'],original['values'])
        result.update(disposed=True,state_path=str(directory/'work/terraform.tfstate'),state_sha256=final_hash,
                      lineage=final['lineage'],serial=final['serial'],ownership_result=disposal['ownership_result'],
                      ownership_result_sha256=disposal['ownership_result_sha256'])
    verify(mode,path,directory,digest,now)
    A.publish_result(directory/'result.json',result)
    return {'completed':True,'result_sha256':A.private_json(directory/'result.json')[1]}

def main(argv=None):
    os.umask(0o077);args=sys.argv[1:] if argv is None else argv
    try:
        require(len(args) in (3,5), "fixed pure session arguments required")
        stage,mode,name=args[:3];path=Path(name);now=datetime.now(timezone.utc)
        if stage=='prepare':require(len(args)==3,"fixed prepare arguments required");value=prepare(mode,path,now)
        else:
            require(len(args)==5,"fixed operation arguments required")
            params=(mode,path,Path(args[3]),args[4],now)
            if stage=='verify':verify(*params);value={'verified':True}
            elif stage=='authenticate':authenticate(*params);value={'authenticated':True}
            elif stage in ('groups','resources'):
                _,_,original,ownership,_=verify(*params)
                value=resource_reads(mode,Path(args[3]),original,ownership) if stage=='resources' else read_commands(original['values'],stage)
            elif stage=='audit':audit(*params);value={'accepted':True}
            elif stage=='intent':value=intent(*params)
            elif stage=='finish':value=finish(*params)
            else:raise A.Error('unknown session stage')
        print(json.dumps(value,separators=(',',':')));return 0
    except Exception:
        print('Session policy rejected. Private state and partial or published artifacts may remain; remote outcome is not established.',file=sys.stderr)
        return 1

if __name__=='__main__':raise SystemExit(main())
