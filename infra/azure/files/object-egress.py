#!/usr/bin/env python3
"""Fixed Azure Object Storage network policy; installation is a host operation."""
import contextlib
import datetime
import fcntl
import hashlib
import ipaddress
import json
import os
import pathlib
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

LIMIT = 262144
TABLE = 'nourishing_object_egress'
BRIDGE = 'nourishing-obj'
NETWORK = 'nutrition-ledger-azure-beta-object-egress'
PROJECT = 'nutrition-ledger-azure-beta'
BACKEND = PROJECT + '_backend'
SUBNET = '172.31.255.0/28'
GATEWAY = '172.31.255.1'
CONFIG = pathlib.Path('/etc/nutrition-tracker')
COORDINATES = CONFIG / 'object-storage-coordinates.json'
HOSTS = pathlib.Path('/run/nutrition-tracker/object-storage-hosts.env')
RANGES = pathlib.Path('/opt/nutrition-tracker/object-storage-public-ranges.lock.json')
RANGE_SHA256 = '44124af92774cb3766b001a706425b4582cfefa660b815efafcd35c2b1ed81ed'
LOCK = pathlib.Path('/run/nutrition-tracker/object-egress.lock')
CLIENT_SERVICES = {PROJECT + '-api': 'api', PROJECT + '-worker-1': 'worker',
                   PROJECT + '-object-storage-live-canary': 'object-storage-live-canary',
                   PROJECT + '-erasure-restore-attestation': 'erasure-restore-attestation'}
CLIENT_NAMES = set(CLIENT_SERVICES)
# The Docker template deliberately excludes Env, mounts and credentials.
CONTAINER_PROJECTION = ('{"Id":{{json .Id}},"Name":{{json .Name}},'
    '"Project":{{json (index .Config.Labels "com.docker.compose.project")}},'
    '"Service":{{json (index .Config.Labels "com.docker.compose.service")}},'
    '"Networks":{{json .NetworkSettings.Networks}},'
    '"NetworkMode":{{json .HostConfig.NetworkMode}},"Privileged":{{json .HostConfig.Privileged}},'
    '"CapAdd":{{json .HostConfig.CapAdd}},"CapDrop":{{json .HostConfig.CapDrop}},'
    '"DeviceCount":{{len .HostConfig.Devices}},"DeviceRequestCount":{{len .HostConfig.DeviceRequests}}}')


class EgressError(Exception):
    pass


def require(condition, message='Object egress validation failed'):
    if not condition:
        raise EgressError(message)


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key')
        result[key] = value
    return result


def parse_json(data):
    try:
        return json.loads(data, object_pairs_hook=unique,
                          parse_constant=lambda _: require(False))
    except (ValueError, UnicodeError, RecursionError):
        raise EgressError('Invalid bounded JSON') from None


def safe_parents(path):
    for parent in reversed(path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                not info.st_mode & 0o022, 'Unsafe policy parent directory')


def read_file(path, mode):
    safe_parents(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
                stat.S_IMODE(info.st_mode) == mode and info.st_nlink == 1 and
                info.st_size <= 65536, 'Unsafe policy file')
        data = os.read(descriptor, 65537)
        after = os.fstat(descriptor)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_nlink,
                              s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(len(data) <= 65536 and identity(info) == identity(after) == identity(path.lstat()),
                'Policy file changed during read')
        return data
    finally:
        os.close(descriptor)


def parse_env(data):
    try:
        lines = data.decode('ascii').splitlines()
    except UnicodeError:
        raise EgressError('Invalid policy environment') from None
    result = {}
    for line in lines:
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        require(separator and re.fullmatch(r'[A-Z][A-Z0-9_]*', key) and
                key not in result and value and not any(ord(c) < 32 for c in value),
                'Invalid policy environment')
        result[key] = value
    return result


def policy_inputs(now=None):
    raw_ranges = read_file(RANGES, 0o644)
    require(hashlib.sha256(raw_ranges).hexdigest() == RANGE_SHA256,
            'Public ranges differ from reviewed source')
    ranges = parse_json(raw_ranges)
    coordinates = parse_json(read_file(COORDINATES, 0o644))
    hosts = parse_env(read_file(HOSTS, 0o600))
    runtime = parse_env(read_file(CONFIG / 'runtime.env', 0o600))
    restore = parse_env(read_file(CONFIG / 'restore.env', 0o600))
    deploy = parse_env(read_file(CONFIG / 'deploy.env', 0o600))
    return validate_inputs(coordinates, ranges, hosts, runtime, restore, deploy, now)


def validate_inputs(c, ranges, hosts, runtime, restore, deploy, now=None):
    keys = {'schemaVersion', 'endpoint', 'compatHost', 'nativeHost', 'region', 'namespace',
            'exportBucket', 'ledgerBucket', 'restoreUserOcid', 'tenancyOcid', 'bridgeCidr',
            'objectStoragePublicCidrs'}
    require(isinstance(c, dict) and set(c) == keys and type(c['schemaVersion']) is int and
            c['schemaVersion'] == 3, 'Unexpected coordinate schema')
    require(c['region'] == 'us-ashburn-1' and c['bridgeCidr'] == SUBNET)
    require(isinstance(c['namespace'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', c['namespace']))
    compat = c['namespace'] + '.compat.objectstorage.us-ashburn-1.oci.customer-oci.com'
    native = 'objectstorage.us-ashburn-1.oraclecloud.com'
    require(c['compatHost'] == compat and c['nativeHost'] == native and
            c['endpoint'] == 'https://' + compat)
    for key, pattern in (('restoreUserOcid', r'ocid1\.user\.oc1\.[A-Za-z0-9.]+'),
                         ('tenancyOcid', r'ocid1\.tenancy\.oc1\.[A-Za-z0-9.]+'),
                         ('exportBucket', r'[A-Za-z0-9_.-]{1,256}'),
                         ('ledgerBucket', r'[A-Za-z0-9_.-]{1,256}')):
        require(isinstance(c[key], str) and re.fullmatch(pattern, c[key]))
    require(c['exportBucket'] != c['ledgerBucket'])
    require(isinstance(ranges, dict) and isinstance(ranges.get('review'), dict))
    review = ranges['review']
    require(review.get('region') == 'us-ashburn-1' and review.get('requiredTag') == 'OBJECT_STORAGE'
            and type(review.get('expectedCidrCount')) is int and review['expectedCidrCount'] == 2)
    try:
        reviewed = datetime.datetime.fromisoformat(review['reviewedAt'].replace('Z', '+00:00'))
        now = now or datetime.datetime.now(datetime.timezone.utc)
        require(reviewed.tzinfo is not None and datetime.timedelta(0) <= now - reviewed <=
                datetime.timedelta(hours=168), 'Public-range review is stale or future-dated')
        values = c['objectStoragePublicCidrs']
        require(isinstance(values, list) and len(values) == 2 and
                all(isinstance(v, str) for v in values) and values == sorted(set(values)) and
                ranges.get('objectStoragePublicCidrs') == values)
        networks = [ipaddress.IPv4Network(v, strict=True) for v in values]
        require(all(n.is_global for n in networks) and not networks[0].overlaps(networks[1]))
        require(set(hosts) == {'OCI_COMPAT_HOST', 'OCI_COMPAT_IPV4', 'OCI_NATIVE_HOST', 'OCI_NATIVE_IPV4'})
        require(hosts['OCI_COMPAT_HOST'] == compat and hosts['OCI_NATIVE_HOST'] == native)
        endpoints = []
        for key in ('OCI_COMPAT_IPV4', 'OCI_NATIVE_IPV4'):
            address = ipaddress.IPv4Address(hosts[key])
            require(str(address) == hosts[key] and address.is_global and any(address in n for n in networks))
            endpoints.append(str(address))
    except (ValueError, TypeError, KeyError, AttributeError):
        raise EgressError('Invalid reviewed endpoint inputs') from None
    for envkey, key in (('EXPORT_ARTIFACT_ENDPOINT', 'endpoint'), ('EXPORT_ARTIFACT_BUCKET', 'exportBucket'),
                        ('ERASURE_REPLAY_LEDGER_ENDPOINT', 'endpoint'), ('ERASURE_REPLAY_LEDGER_BUCKET', 'ledgerBucket')):
        require(runtime.get(envkey) == c[key], 'Runtime storage identity differs')
    for envkey, key in (('ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE', 'namespace'),
                        ('ERASURE_REPLAY_LEDGER_RESTORE_OCI_USER_OCID', 'restoreUserOcid'),
                        ('ERASURE_REPLAY_LEDGER_RESTORE_OCI_TENANCY_OCID', 'tenancyOcid')):
        require(restore.get(envkey) == c[key], 'Restore storage identity differs')
    require(isinstance(runtime.get('SERVICE_VERSION'), str) and
            re.fullmatch('[0-9a-f]{40}', runtime['SERVICE_VERSION']), 'Invalid source identity')
    target = deploy.get('DEPLOYMENT_TARGET')
    require(target in ('staging', 'production') and deploy.get('API_FQDN') ==
            {'staging': 'staging-api.nourishing.app', 'production': 'api.nourishing.app'}[target],
            'Invalid deployment identity')
    binding = {'coordinates': c, 'hosts': hosts, 'source': runtime['SERVICE_VERSION'], 'target': target}
    digest = hashlib.sha256(json.dumps(binding, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return sorted(set(endpoints)), digest


def match(left, right):
    return {'match': {'op': '==', 'left': left, 'right': right}}


def meta(key, value):
    return match({'meta': {'key': key}}, value)


def payload(protocol, field, value):
    return match({'payload': {'protocol': protocol, 'field': field}}, value)


def rules(endpoints=None, binding='quarantine'):
    prefix = {'prefix': {'addr': '172.31.255.0', 'len': 28}}
    source = meta('iifname', BRIDGE)
    destination = meta('oifname', BRIDGE)
    result = [('input', [source, {'drop': None}])]
    if endpoints is not None:
        result.append(('forward', [source, destination, {'drop': None}]))
        for address in endpoints:
            common = [meta('nfproto', 'ipv4'), meta('l4proto', 'tcp')]
            result.append(('forward', [source] + common + [payload('ip', 'saddr', prefix),
                          payload('ip', 'daddr', address), payload('tcp', 'dport', 443), {'accept': None}]))
        result.append(('forward', [source, {'drop': None}]))
        for address in endpoints:
            result.append(('forward', [destination, meta('nfproto', 'ipv4'), meta('l4proto', 'tcp'),
                          payload('ip', 'saddr', address), payload('ip', 'daddr', prefix),
                          payload('tcp', 'sport', 443), match({'ct': {'key': 'state'}}, 'established'),
                          {'accept': None}]))
    else:
        result.append(('forward', [source, {'drop': None}]))
    result.append(('forward', [destination, {'drop': None}]))
    return [{'family': 'inet', 'table': TABLE, 'chain': chain,
             'expr': expression[:-1] + [{'counter': {'packets': 0, 'bytes': 0}}, expression[-1]],
             'comment': 'nourishing-v1:' + binding} for chain, expression in result]


def chains():
    return [{'family': 'inet', 'table': TABLE, 'name': name, 'type': 'filter',
             'hook': name, 'prio': -10, 'policy': 'accept'} for name in ('input', 'forward')]


def batch(endpoints=None, binding='quarantine'):
    table = {'family': 'inet', 'name': TABLE}
    # add is idempotent; delete removes unexpected chains, sets and flowtables.
    # The complete replacement is submitted in one kernel transaction.
    commands = [{'add': {'table': table}}, {'delete': {'table': table}}, {'add': {'table': table}}]
    commands += [{'add': {'chain': chain}} for chain in chains()]
    commands += [{'add': {'rule': rule}} for rule in rules(endpoints, binding)]
    return json.dumps({'nftables': commands}, separators=(',', ':')).encode()


def verify_rules(document, endpoints=None, binding='quarantine'):
    require(isinstance(document, dict) and set(document) == {'nftables'} and
            isinstance(document['nftables'], list), 'Invalid nft JSON')
    actual = []
    metadata_seen = False
    for item in document['nftables']:
        require(isinstance(item, dict) and len(item) == 1, 'Invalid nft object')
        kind, value = next(iter(item.items()))
        if kind == 'metainfo':
            require(not actual and not metadata_seen and isinstance(value, dict), 'Invalid nft metadata')
            metadata_seen = True
            continue
        require(kind in ('table', 'chain', 'rule') and isinstance(value, dict), 'Unexpected nft object')
        require('handle' not in value or (type(value['handle']) is int and value['handle'] > 0),
                'Invalid nft handle')
        normalized = {key: val for key, val in value.items() if key != 'handle'}
        if kind == 'rule':
            require(isinstance(value.get('expr'), list), 'Invalid nft expressions')
            expressions = []
            for expression in value['expr']:
                if isinstance(expression, dict) and 'counter' in expression:
                    counter = expression['counter']
                    require(set(expression) == {'counter'} and isinstance(counter, dict) and
                            set(counter) == {'packets', 'bytes'} and all(type(n) is int and
                            0 <= n < 2 ** 64 for n in counter.values()), 'Invalid nft counter')
                    expressions.append({'counter': {'packets': 0, 'bytes': 0}})
                else:
                    expressions.append(expression)
            normalized['expr'] = expressions
        actual.append({kind: normalized})
    expected = [{'table': {'family': 'inet', 'name': TABLE}}]
    for chain in chains():
        expected.append({'chain': chain})
        expected += [{'rule': rule} for rule in rules(endpoints, binding) if rule['chain'] == chain['name']]
    require(json.dumps(actual, sort_keys=True) == json.dumps(expected, sort_keys=True),
            'Live Object Storage rules differ from the exact policy')


def verify_network(document):
    require(isinstance(document, list) and len(document) == 2 and all(isinstance(n, dict) for n in document),
            'Invalid Docker network response')
    require({n.get('Name') for n in document} == {NETWORK, BACKEND}, 'Unexpected Docker networks')
    network = next(n for n in document if n['Name'] == NETWORK)
    backend = next(n for n in document if n['Name'] == BACKEND)
    require(backend.get('Driver') == 'bridge' and backend.get('Scope') == 'local' and
            backend.get('Internal') is True and backend.get('EnableIPv6') is False and
            backend.get('Ingress') is False and isinstance(backend.get('Id'), str) and
            re.fullmatch('[0-9a-f]{64}', backend['Id']), 'Backend is not the private reviewed network')
    backend_labels = backend.get('Labels')
    require(isinstance(backend_labels, dict) and backend_labels.get('com.docker.compose.project') == PROJECT and
            backend_labels.get('com.docker.compose.network') == 'backend', 'Foreign backend network identity')
    required = {'Name': NETWORK, 'Driver': 'bridge', 'Scope': 'local', 'Internal': False,
                'EnableIPv6': False, 'Attachable': False, 'Ingress': False,
                'Options': {'com.docker.network.bridge.name': BRIDGE,
                            'com.docker.network.bridge.enable_icc': 'false'}}
    require(all(type(network.get(k)) is type(v) and network[k] == v for k, v in required.items()),
            'Docker network differs from the reviewed bridge')
    require(isinstance(network.get('Id'), str) and re.fullmatch('[0-9a-f]{64}', network['Id']))
    labels = network.get('Labels')
    require(isinstance(labels, dict) and labels.get('com.docker.compose.project') == PROJECT and
            labels.get('com.docker.compose.network') == 'object_egress', 'Foreign network identity')
    require(network.get('IPAM') == {'Driver': 'default', 'Options': None,
            'Config': [{'Subnet': SUBNET, 'Gateway': GATEWAY}]}, 'Unexpected bridge address allocation')
    containers = network.get('Containers')
    require(isinstance(containers, dict) and len(containers) <= 4, 'Unexpected bridge clients')
    names = set()
    for identity, container in containers.items():
        require(isinstance(identity, str) and re.fullmatch('[0-9a-f]{64}', identity) and isinstance(container, dict))
        require(isinstance(container.get('Name'), str) and container['Name'] in CLIENT_NAMES and
                container.get('IPv6Address') == '', 'Unexpected bridge client identity')
        require(container['Name'] not in names and isinstance(container.get('EndpointID'), str) and
                re.fullmatch('[0-9a-f]{64}', container['EndpointID']), 'Duplicate client or invalid endpoint')
        names.add(container['Name'])
        try:
            address = ipaddress.IPv4Interface(container['IPv4Address'])
            require(str(address) == container['IPv4Address'] and str(address.network) == SUBNET and
                    address.ip not in (address.network.network_address, address.network.broadcast_address,
                                       ipaddress.IPv4Address(GATEWAY)))
        except (ValueError, KeyError, TypeError):
            raise EgressError('Invalid bridge client address') from None
    return network, backend


def verify_clients(data, network, backend):
    lines = data.splitlines()
    clients = network['Containers']
    require(len(lines) == len(clients) <= 4, 'Unexpected container projection count')
    seen = set()
    for line in lines:
        c = parse_json(line)
        keys = {'Id', 'Name', 'Project', 'Service', 'Networks', 'NetworkMode', 'Privileged',
                'CapAdd', 'CapDrop', 'DeviceCount', 'DeviceRequestCount'}
        require(isinstance(c, dict) and set(c) == keys and isinstance(c['Id'], str) and
                c['Id'] in clients and c['Id'] not in seen, 'Unexpected container identity')
        seen.add(c['Id']); expected = clients[c['Id']]
        service = CLIENT_SERVICES[expected['Name']]
        require(c['Name'] == '/' + expected['Name'] and c['Project'] == PROJECT and c['Service'] == service,
                'Container differs from the reviewed project/service identity')
        expected_networks = {NETWORK} if service == 'object-storage-live-canary' else {NETWORK, BACKEND}
        require(isinstance(c['Networks'], dict) and set(c['Networks']) == expected_networks and
                isinstance(c['NetworkMode'], str) and c['NetworkMode'] in expected_networks,
                'Container has an unreviewed network attachment')
        require(c['Privileged'] is False and c['CapAdd'] in (None, []) and c['CapDrop'] == ['ALL'] and
                type(c['DeviceCount']) is int and c['DeviceCount'] == 0 and
                type(c['DeviceRequestCount']) is int and c['DeviceRequestCount'] == 0,
                'Container has an unreviewed privilege or device')
        for name in expected_networks:
            attachment = c['Networks'][name]
            require(isinstance(attachment, dict) and attachment.get('NetworkID') ==
                    (network if name == NETWORK else backend)['Id'] and
                    attachment.get('GlobalIPv6Address') == '', 'Container network binding differs')
        obj = c['Networks'][NETWORK]
        address = ipaddress.IPv4Interface(expected['IPv4Address'])
        require(obj.get('EndpointID') == expected['EndpointID'] and obj.get('IPAddress') == str(address.ip) and
                type(obj.get('IPPrefixLen')) is int and obj['IPPrefixLen'] == 28,
                'Container endpoint differs from the inspected bridge')


def live_network():
    network, backend = verify_network(parse_json(bounded_child(
        ['/usr/bin/docker', 'network', 'inspect', NETWORK, BACKEND])))
    identities = sorted(network['Containers'])
    if identities:
        projection = bounded_child(['/usr/bin/docker', 'container', 'inspect', '--format',
                                    CONTAINER_PROJECTION] + identities)
        verify_clients(projection, network, backend)


def verify_bridge(document):
    require(isinstance(document, list) and len(document) == 1 and isinstance(document[0], dict),
            'Invalid host bridge response')
    link = document[0]
    require(link.get('ifname') == BRIDGE and type(link.get('ifindex')) is int and link['ifindex'] > 0 and
            link.get('link_type') == 'ether' and isinstance(link.get('linkinfo'), dict) and
            link['linkinfo'].get('info_kind') == 'bridge', 'Host interface is not the fixed bridge')
    addresses = link.get('addr_info')
    require(isinstance(addresses, list) and len(addresses) == 1 and isinstance(addresses[0], dict))
    address = addresses[0]
    require(address.get('family') == 'inet' and address.get('local') == GATEWAY and
            type(address.get('prefixlen')) is int and address['prefixlen'] == 28 and
            address.get('scope') == 'global', 'Host bridge addressing differs')


@contextlib.contextmanager
def locked():
    safe_parents(LOCK)
    descriptor = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
                stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1, 'Unsafe egress lock')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise EgressError('Object egress operation already active') from None
        yield
    finally:
        os.close(descriptor)


def bounded_child(argv, data=b'', timeout=8, cap=LIMIT):
    """Fixed callers only; stdin carries the fixed nft policy. Bound output, wall time and reap."""
    # Defer Python cancellation until the child and its pipes are reconciled.
    # Unlike pthread_sigmask, this does not leak blocked signals into the child.
    signals = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)
    previous = {number: signal.getsignal(number) for number in signals}
    deferred = []
    process = None
    def defer(number, frame):
        if not deferred and previous[number] != signal.SIG_IGN:
            deferred.append((number, frame))
    def resume():
        for number, handler in previous.items():
            signal.signal(number, handler)
        if deferred:
            number, frame = deferred[0]
            handler = previous[number]
            if callable(handler):
                handler(number, frame)
            raise EgressError('Object egress probe cancelled')
    for number in signals:
        signal.signal(number, defer)
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, start_new_session=True,
                                   env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        require(not deferred, 'Object egress probe cancelled')
        output = bytearray()
        deadline = time.monotonic() + timeout
        offset = 0
        with selectors.DefaultSelector() as selector:
            for pipe in (process.stdin, process.stdout):
                os.set_blocking(pipe.fileno(), False)
            if data:
                selector.register(process.stdin, selectors.EVENT_WRITE)
            else:
                process.stdin.close()
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                require(not deferred, 'Object egress probe cancelled')
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'Object egress probe timed out')
                for key, _ in selector.select(min(remaining, .2)):
                    if key.fileobj is process.stdin:
                        try:
                            offset += os.write(process.stdin.fileno(), data[offset:offset + 4096])
                        except BrokenPipeError:
                            offset = len(data)
                        if offset == len(data):
                            selector.unregister(process.stdin)
                            process.stdin.close()
                    else:
                        chunk = os.read(process.stdout.fileno(), min(4096, cap + 1 - len(output)))
                        if not chunk:
                            selector.unregister(process.stdout)
                        output.extend(chunk)
                        require(len(output) <= cap, 'Object egress probe output exceeded limit')
            require(not deferred, 'Object egress probe cancelled')
            require(process.wait(timeout=max(.01, deadline - time.monotonic())) == 0,
                    'Object egress probe failed')
            return bytes(output)
    except (subprocess.TimeoutExpired, OSError):
        raise EgressError('Object egress probe failed') from None
    finally:
        try:
            if process is not None:
                # Also terminate descendants after a successful leader exit.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=2)
                for pipe in (process.stdin, process.stdout):
                    if not pipe.closed:
                        pipe.close()
        finally:
            resume()

@contextlib.contextmanager
def termination_scope():
    signals = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)
    previous = {number: signal.getsignal(number) for number in signals}
    def cancel(_number, _frame):
        # Repeated cancellation must not interrupt child kill/reap or lock release.
        for number in signals:
            signal.signal(number, signal.SIG_IGN)
        raise EgressError('Object egress operation cancelled')
    try:
        for number in signals:
            signal.signal(number, cancel)
        yield
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)

def live_rules():
    return parse_json(bounded_child(['/usr/sbin/nft', '-j', 'list', 'table', 'inet', TABLE]))


def verify():
    endpoints, binding = policy_inputs()
    live_network()
    verify_bridge(parse_json(bounded_child(['/usr/sbin/ip', '-j', '-d', 'address', 'show', 'dev', BRIDGE])))
    verify_rules(live_rules(), endpoints, binding)


def quarantine():
    bounded_child(['/usr/sbin/nft', '-j', '-f', '-'], batch())
    verify_rules(live_rules())


def contain_failure(primary):
    # An already-failing operation gets one bounded containment attempt. A first
    # or repeated cancellation cannot interrupt it. Then the original failure
    # propagates; nft failure means quarantine was not verified.
    signals = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)
    previous = {number: signal.getsignal(number) for number in signals}
    try:
        for number in signals:
            signal.signal(number, signal.SIG_IGN)
        try:
            quarantine()
        except BaseException:
            raise EgressError('Object egress containment failed; quarantine not verified') from primary
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def operate(action):
    with locked():
        if action == 'quarantine':
            quarantine()
            return
        if action == 'verify':
            verify()
            return
        if action == 'watchdog':
            try:
                verify()
            except BaseException as primary:
                contain_failure(primary)
                raise EgressError('Object egress drift quarantined; host review required') from primary
            return
        require(action == 'install', 'Unknown object egress action')
        # Attempt initial quarantine and one bounded containment on any failure.
        try:
            quarantine()
            endpoints, binding = policy_inputs()
            live_network()
            verify_bridge(parse_json(bounded_child(['/usr/sbin/ip', '-j', '-d', 'address', 'show', 'dev', BRIDGE])))
            bounded_child(['/usr/sbin/nft', '-j', '-f', '-'], batch(endpoints, binding))
            verify()
        except BaseException as primary:
            contain_failure(primary)
            raise


def main(argv):
    if len(argv) != 1 or argv[0] not in ('install', 'quarantine', 'verify', 'watchdog') or os.geteuid() != 0:
        print('Object egress requires root and one fixed action', file=sys.stderr)
        return 2
    try:
        with termination_scope():
            operate(argv[0])
        print('Object egress operation completed; live deployment qualification remains required')
        return 0
    except Exception:
        print('Object egress operation failed; preserve quarantine and inspect host evidence', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
