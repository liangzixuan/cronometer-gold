#!/usr/bin/env python3
"""Local synthetic policy tests. Never invokes nft, Docker, ip or systemd."""
import contextlib
import copy
import datetime
import importlib.util
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

PATH = pathlib.Path(__file__).resolve().parents[1] / 'object-egress.py'
SPEC = importlib.util.spec_from_file_location('azure_object_egress', PATH)
egress = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(egress)
NOW = datetime.datetime(2026, 9, 29, tzinfo=datetime.timezone.utc)


def inputs():
    compat = 'synthetic.compat.objectstorage.us-ashburn-1.oci.customer-oci.com'
    c = {'schemaVersion': 3, 'namespace': 'synthetic', 'region': 'us-ashburn-1',
         'bridgeCidr': '172.31.255.0/28', 'compatHost': compat,
         'nativeHost': 'objectstorage.us-ashburn-1.oraclecloud.com', 'endpoint': 'https://' + compat,
         'exportBucket': 'exports', 'ledgerBucket': 'ledger', 'restoreUserOcid': 'ocid1.user.oc1..synthetic',
         'tenancyOcid': 'ocid1.tenancy.oc1..synthetic',
         'objectStoragePublicCidrs': ['134.70.24.0/21', '134.70.32.0/22']}
    ranges = {'review': {'reviewedAt': '2026-09-28T00:00:00Z', 'region': 'us-ashburn-1',
                         'requiredTag': 'OBJECT_STORAGE', 'expectedCidrCount': 2},
              'objectStoragePublicCidrs': list(c['objectStoragePublicCidrs'])}
    hosts = {'OCI_COMPAT_HOST': compat, 'OCI_NATIVE_HOST': c['nativeHost'],
             'OCI_COMPAT_IPV4': '134.70.24.2', 'OCI_NATIVE_IPV4': '134.70.32.3'}
    runtime = {'SERVICE_VERSION': 'a' * 40, 'EXPORT_ARTIFACT_ENDPOINT': c['endpoint'],
               'EXPORT_ARTIFACT_BUCKET': 'exports', 'ERASURE_REPLAY_LEDGER_ENDPOINT': c['endpoint'],
               'ERASURE_REPLAY_LEDGER_BUCKET': 'ledger'}
    restore = {'ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE': 'synthetic',
               'ERASURE_REPLAY_LEDGER_RESTORE_OCI_USER_OCID': c['restoreUserOcid'],
               'ERASURE_REPLAY_LEDGER_RESTORE_OCI_TENANCY_OCID': c['tenancyOcid']}
    deploy = {'DEPLOYMENT_TARGET': 'staging', 'API_FQDN': 'staging-api.nourishing.app'}
    return c, ranges, hosts, runtime, restore, deploy


def network():
    return [{'Name': 'nutrition-ledger-azure-beta-object-egress', 'Driver': 'bridge', 'Scope': 'local',
             'Id': 'c' * 64, 'Internal': False, 'EnableIPv6': False, 'Attachable': False, 'Ingress': False,
             'Options': {'com.docker.network.bridge.name': 'nourishing-obj',
                         'com.docker.network.bridge.enable_icc': 'false'},
             'IPAM': {'Driver': 'default', 'Options': None,
                      'Config': [{'Subnet': '172.31.255.0/28', 'Gateway': '172.31.255.1'}]},
             'Labels': {'com.docker.compose.project': 'nutrition-ledger-azure-beta',
                        'com.docker.compose.network': 'object_egress'}, 'Containers': {}},
            {'Name': 'nutrition-ledger-azure-beta_backend', 'Driver': 'bridge', 'Scope': 'local',
             'Id': 'd' * 64, 'Internal': True, 'EnableIPv6': False, 'Ingress': False,
             'Labels': {'com.docker.compose.project': 'nutrition-ledger-azure-beta',
                        'com.docker.compose.network': 'backend'}}]


def client_fixture(service='api'):
    names = {'api': 'nutrition-ledger-azure-beta-api', 'worker': 'nutrition-ledger-azure-beta-worker-1',
             'object-storage-live-canary': 'nutrition-ledger-azure-beta-object-storage-live-canary',
             'erasure-restore-attestation': 'nutrition-ledger-azure-beta-erasure-restore-attestation'}
    document = network()
    document[0]['Containers'] = {'a' * 64: {'Name': names[service], 'IPv6Address': '',
        'IPv4Address': '172.31.255.2/28', 'EndpointID': 'e' * 64}}
    c = {'Id': 'a' * 64, 'Name': '/' + names[service], 'Project': 'nutrition-ledger-azure-beta',
         'Service': service, 'NetworkMode': 'nutrition-ledger-azure-beta-object-egress',
         'Privileged': False, 'CapAdd': None, 'CapDrop': ['ALL'], 'DeviceCount': 0, 'DeviceRequestCount': 0,
         'Networks': {'nutrition-ledger-azure-beta-object-egress': {'NetworkID': 'c' * 64,
            'EndpointID': 'e' * 64, 'IPAddress': '172.31.255.2', 'IPPrefixLen': 28, 'GlobalIPv6Address': ''}}}
    if service != 'object-storage-live-canary':
        c['Networks']['nutrition-ledger-azure-beta_backend'] = {'NetworkID': 'd' * 64, 'GlobalIPv6Address': ''}
    return document, c


def bridge():
    return [{'ifname': 'nourishing-obj', 'ifindex': 42, 'link_type': 'ether',
             'linkinfo': {'info_kind': 'bridge'}, 'addr_info': [
                 {'family': 'inet', 'local': '172.31.255.1', 'prefixlen': 28, 'scope': 'global'}]}]


def observed(endpoints=None, binding='quarantine'):
    # Synthetic nft listing assembled from submitted object declarations. It tests
    # controller sequencing; independent packet expectations below test policy.
    commands = json.loads(egress.batch(endpoints, binding))['nftables']
    result = [{'metainfo': {'version': 'synthetic', 'json_schema_version': 1}}]
    result.append({'table': {'family': 'inet', 'name': 'nourishing_object_egress', 'handle': 1}})
    for entry in commands:
        if 'chain' not in entry.get('add', {}):
            continue
        chain = copy.deepcopy(entry['add']['chain'])
        chain['handle'] = 2
        result.append({'chain': chain})
        for rule in commands:
            body = rule.get('add', {}).get('rule')
            if body and body['chain'] == chain['name']:
                body = copy.deepcopy(body)
                body['handle'] = 3
                result.append({'rule': body})
    return {'nftables': result}


def verdict(document, chain, packet):
    # Small independent evaluator for the emitted equality/prefix subset. This
    # does not execute kernel hooks, conntrack or Docker bridge forwarding.
    import ipaddress
    for entry in document['nftables']:
        rule = entry.get('add', {}).get('rule')
        if not rule or rule['chain'] != chain:
            continue
        matches = True
        for expression in rule['expr']:
            if 'counter' in expression:
                continue
            if 'match' not in expression:
                if matches:
                    return next(iter(expression))
                break
            match = expression['match']
            assert match['op'] == '=='
            kind, lhs = next(iter(match['left'].items()))
            key = lhs['key'] if kind in ('meta', 'ct') else lhs['field']
            actual = packet.get(key)
            expected = match['right']
            if isinstance(expected, dict) and 'prefix' in expected:
                prefix = expected['prefix']
                matches = matches and actual is not None and ipaddress.ip_address(actual) in ipaddress.ip_network(
                    prefix['addr'] + '/' + str(prefix['len']))
            else:
                matches = matches and actual == expected
    return 'accept'


class Inputs(unittest.TestCase):
    def test_exact_identity_binds_source_target_and_frozen_addresses(self):
        value = inputs()
        addresses, digest = egress.validate_inputs(*value, NOW)
        self.assertEqual(addresses, ['134.70.24.2', '134.70.32.3'])
        self.assertEqual(len(digest), 64)
        value[3]['SERVICE_VERSION'] = 'b' * 40
        self.assertNotEqual(digest, egress.validate_inputs(*value, NOW)[1])

    def test_malformed_coordinate_host_runtime_and_target_rejected(self):
        mutations = [(0, 'schemaVersion', True), (0, 'extra', 1), (0, 'namespace', '../bad'),
                     (0, 'bridgeCidr', '172.31.255.0/24'), (0, 'exportBucket', 'ledger'),
                     (0, 'restoreUserOcid', 'ocid1.user.oc1..bad\nvalue'),
                     (2, 'OCI_COMPAT_IPV4', '1.1.1.1'), (2, 'OCI_NATIVE_IPV4', '2001:4860::1'),
                     (2, 'OCI_COMPAT_HOST', 'attacker.example'), (2, 'EXTRA', 'x'),
                     (3, 'EXPORT_ARTIFACT_BUCKET', 'other'), (3, 'SERVICE_VERSION', 'main'),
                     (4, 'ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE', 'other'),
                     (5, 'API_FQDN', 'api.nourishing.app'), (5, 'DEPLOYMENT_TARGET', 'other')]
        for index, key, replacement in mutations:
            with self.subTest(index=index, key=key):
                value = inputs(); value[index][key] = replacement
                with self.assertRaises(egress.EgressError):
                    egress.validate_inputs(*value, NOW)

    def test_stale_future_naive_and_broadened_range_rejected(self):
        for timestamp in ('2026-09-21T23:59:59Z', '2026-09-30T00:00:00Z', '2026-09-28', 'bad'):
            value = inputs(); value[1]['review']['reviewedAt'] = timestamp
            with self.subTest(timestamp=timestamp), self.assertRaises(egress.EgressError):
                egress.validate_inputs(*value, NOW)
        value = inputs(); value[0]['objectStoragePublicCidrs'] = ['0.0.0.0/0', '134.70.32.0/22']
        value[1]['objectStoragePublicCidrs'] = value[0]['objectStoragePublicCidrs']
        with self.assertRaises(egress.EgressError): egress.validate_inputs(*value, NOW)

    def test_duplicate_and_nonfinite_json_and_duplicate_env_rejected(self):
        for data in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{', b'\xff'):
            with self.assertRaises(egress.EgressError): egress.parse_json(data)
        with self.assertRaises(egress.EgressError): egress.parse_env(b'X=a\nX=b\n')

    def test_pinned_range_file_failure_precedes_other_reads(self):
        with mock.patch.object(egress, 'read_file', return_value=b'{}') as read:
            with self.assertRaises(egress.EgressError): egress.policy_inputs(NOW)
        self.assertEqual(read.call_count, 1)


class Policy(unittest.TestCase):
    def setUp(self):
        self.addresses = ['134.70.24.2', '134.70.32.3']
        self.document = json.loads(egress.batch(self.addresses, 'a' * 64))
        self.packet = {'iifname': 'nourishing-obj', 'oifname': 'eth0', 'nfproto': 'ipv4',
                       'l4proto': 'tcp', 'saddr': '172.31.255.2', 'daddr': self.addresses[0], 'dport': 443}

    def test_single_fixed_table_replacement_no_flush_or_foreign_object(self):
        commands = self.document['nftables']
        table = {'family': 'inet', 'name': 'nourishing_object_egress'}
        self.assertEqual(commands[:3], [{'add': {'table': table}}, {'delete': {'table': table}}, {'add': {'table': table}}])
        self.assertEqual(len(commands), 13)
        for command in commands[3:]:
            self.assertEqual(set(command), {'add'})
            body = next(iter(command['add'].values()))
            self.assertEqual(body['family'], 'inet')
            self.assertEqual(body['table'], 'nourishing_object_egress')
        chains = [c['add']['chain'] for c in commands if 'chain' in c.get('add', {})]
        self.assertEqual([(c['hook'], c['prio'], c['policy']) for c in chains],
                         [('input', -10, 'accept'), ('forward', -10, 'accept')])

    def test_only_exact_endpoints_tcp443_from_valid_subnet_are_allowed(self):
        for address in self.addresses:
            packet = dict(self.packet, daddr=address)
            self.assertEqual(verdict(self.document, 'forward', packet), 'accept')
        for change in ({'daddr': '134.70.24.3'}, {'daddr': '1.1.1.1'}, {'dport': 80},
                       {'l4proto': 'udp'}, {'saddr': '10.1.1.1'}, {'nfproto': 'ipv6', 'daddr': '2001:4860::1'},
                       {'oifname': 'nourishing-obj'}):
            with self.subTest(change=change):
                self.assertEqual(verdict(self.document, 'forward', dict(self.packet, **change)), 'drop')

    def test_host_input_quarantine_and_unrelated_interfaces(self):
        self.assertEqual(verdict(self.document, 'input', self.packet), 'drop')
        quarantine = json.loads(egress.batch())
        self.assertEqual(verdict(quarantine, 'forward', self.packet), 'drop')
        self.assertEqual(verdict(quarantine, 'input', self.packet), 'drop')
        self.assertEqual(verdict(self.document, 'forward', dict(self.packet, iifname='other')), 'accept')

    def test_inbound_requires_established_exact_endpoint_tcp_reply(self):
        packet = {'iifname': 'eth0', 'oifname': 'nourishing-obj', 'nfproto': 'ipv4', 'l4proto': 'tcp',
                  'saddr': self.addresses[0], 'daddr': '172.31.255.2', 'sport': 443, 'state': 'established'}
        self.assertEqual(verdict(self.document, 'forward', packet), 'accept')
        for change in ({'state': 'new'}, {'state': 'related'}, {'sport': 80}, {'saddr': '134.70.24.3'},
                       {'nfproto': 'ipv6', 'saddr': '2001:4860::1'}, {'daddr': '10.1.1.1'}):
            self.assertEqual(verdict(self.document, 'forward', dict(packet, **change)), 'drop')

    def test_exact_listing_accepts_only_inert_handles_and_metadata(self):
        egress.verify_rules(observed(self.addresses, 'a' * 64), self.addresses, 'a' * 64)
        egress.verify_rules(observed())

    def test_rule_mutations_and_unexpected_objects_rejected(self):
        original = observed(self.addresses, 'a' * 64)
        changed = []
        value = copy.deepcopy(original); value['nftables'][3]['rule']['expr'][-1] = {'accept': None}; changed.append(value)
        value = copy.deepcopy(original); value['nftables'][2]['chain']['prio'] = 10; changed.append(value)
        value = copy.deepcopy(original); value['nftables'].pop(); changed.append(value)
        value = copy.deepcopy(original); value['nftables'].append({'set': {}}); changed.append(value)
        value = copy.deepcopy(original); value['nftables'][1]['table']['name'] = 'other'; changed.append(value)
        value = copy.deepcopy(original); value['nftables'][3]['rule']['comment'] = 'other'; changed.append(value)
        value = copy.deepcopy(original); value['nftables'][3]['rule']['handle'] = True; changed.append(value)
        value = copy.deepcopy(original); value['nftables'].insert(0, value['nftables'][0]); changed.append(value)
        for value in changed:
            with self.subTest(value=value), self.assertRaises(egress.EgressError):
                egress.verify_rules(value, self.addresses, 'a' * 64)

    def test_counters_keep_exact_location_and_only_bounded_counts_vary(self):
        original = observed(self.addresses, 'a' * 64)
        rule = next(entry['rule'] for entry in original['nftables'] if 'rule' in entry)
        self.assertEqual(rule['expr'][-2], {'counter': {'packets': 0, 'bytes': 0}})
        rule['expr'][-2] = {'counter': {'packets': 12, 'bytes': 3456}}
        egress.verify_rules(original, self.addresses, 'a' * 64)
        for replacement in ({'counter': {'packets': -1, 'bytes': 0}},
                            {'counter': {'packets': True, 'bytes': 0}},
                            {'counter': {'packets': 0, 'bytes': 2 ** 64}},
                            {'counter': {'packets': 1, 'bytes': 2, 'name': 'foreign'}},
                            {'counter': 'named'}, {'counter': None}):
            value = copy.deepcopy(original)
            next(entry['rule'] for entry in value['nftables'] if 'rule' in entry)['expr'][-2] = replacement
            with self.assertRaises(egress.EgressError): egress.verify_rules(value, self.addresses, 'a' * 64)
        for changed in ('missing', 'reordered'):
            value = copy.deepcopy(original)
            expressions = next(entry['rule'] for entry in value['nftables'] if 'rule' in entry)['expr']
            counter = expressions.pop(-2)
            if changed == 'reordered': expressions.insert(0, counter)
            with self.assertRaises(egress.EgressError): egress.verify_rules(value, self.addresses, 'a' * 64)


class Network(unittest.TestCase):
    def test_fixed_network_and_kernel_bridge(self):
        egress.verify_network(network()); egress.verify_bridge(bridge())

    def test_foreign_network_ipv6_icc_gateway_and_clients_rejected(self):
        mutations = [('Name', 'other'), ('EnableIPv6', True), ('Internal', True),
                     ('Id', 'bad'), ('Options', {}), ('Labels', {}), ('IPAM', {})]
        for key, value in mutations:
            document = network(); document[0][key] = value
            with self.subTest(key=key), self.assertRaises(egress.EgressError): egress.verify_network(document)
        document = network(); document[0]['Containers'] = {'a' * 64: {'Name': 'foreign', 'IPv6Address': '',
                                                                  'IPv4Address': '172.31.255.2/28'}}
        with self.assertRaises(egress.EgressError): egress.verify_network(document)

    def test_valid_client_rejects_ipv6_or_wrong_subnet(self):
        document = network(); document[0]['Containers'] = {'a' * 64: {
            'Name': 'nutrition-ledger-azure-beta-api', 'IPv6Address': '', 'IPv4Address': '172.31.255.2/28',
            'EndpointID': 'e' * 64}}
        egress.verify_network(document)
        for key, value in [('IPv6Address', 'fe80::1/64'), ('IPv4Address', '172.31.255.1/28'), ('IPv4Address', '10.1.1.1/24')]:
            changed = copy.deepcopy(document); changed[0]['Containers']['a' * 64][key] = value
            with self.assertRaises(egress.EgressError): egress.verify_network(changed)

    def test_exact_fixed_api_name_matches_compose_and_default_names_are_explicit(self):
        compose = (PATH.parent / 'compose.yaml').read_text()
        self.assertIn('container_name: nutrition-ledger-azure-beta-api', compose)
        self.assertEqual(egress.CLIENT_NAMES, {'nutrition-ledger-azure-beta-api',
            'nutrition-ledger-azure-beta-worker-1', 'nutrition-ledger-azure-beta-object-storage-live-canary',
            'nutrition-ledger-azure-beta-erasure-restore-attestation'})

    def test_exact_live_client_bindings_and_private_backend(self):
        for service in ('api', 'worker', 'object-storage-live-canary', 'erasure-restore-attestation'):
            document, c = client_fixture(service)
            obj, back = egress.verify_network(document)
            egress.verify_clients(json.dumps(c).encode(), obj, back)
        for key, value in [('Internal', False), ('EnableIPv6', True), ('Labels', {}), ('Driver', 'overlay')]:
            document = network(); document[1][key] = value
            with self.assertRaises(egress.EgressError): egress.verify_network(document)

    def test_foreign_attachments_privileges_or_container_identity_rejected(self):
        document, original = client_fixture()
        mutations = [('Id', 'b' * 64), ('Name', '/foreign'), ('Project', 'foreign'), ('Service', 'worker'),
                     ('NetworkMode', 'host'), ('Privileged', True), ('CapAdd', ['NET_ADMIN']),
                     ('CapDrop', []), ('DeviceCount', 1), ('DeviceRequestCount', 1)]
        for key, value in mutations:
            c = copy.deepcopy(original); c[key] = value
            with self.subTest(key=key), self.assertRaises(egress.EgressError):
                egress.verify_clients(json.dumps(c).encode(), *document)
        for extra in ('nutrition-ledger-azure-beta_edge', 'foreign-network'):
            c = copy.deepcopy(original); c['Networks'][extra] = {}
            with self.assertRaises(egress.EgressError): egress.verify_clients(json.dumps(c).encode(), *document)
        c = copy.deepcopy(original); c['Networks']['nutrition-ledger-azure-beta-object-egress']['EndpointID'] = 'f' * 64
        with self.assertRaises(egress.EgressError): egress.verify_clients(json.dumps(c).encode(), *document)
        c = copy.deepcopy(original); c['Networks']['nutrition-ledger-azure-beta_backend']['NetworkID'] = 'f' * 64
        with self.assertRaises(egress.EgressError): egress.verify_clients(json.dumps(c).encode(), *document)

    def test_live_projection_is_one_bounded_call_and_never_reads_environment_or_mounts(self):
        document, c = client_fixture()
        with mock.patch.object(egress, 'bounded_child', side_effect=[json.dumps(document).encode(),
                                                                  json.dumps(c).encode()]) as child:
            egress.live_network()
        self.assertEqual(child.call_count, 2)
        args = child.call_args.args[0]
        self.assertEqual(args[:5], ['/usr/bin/docker', 'container', 'inspect', '--format', egress.CONTAINER_PROJECTION])
        self.assertEqual(args[5:], ['a' * 64])
        for forbidden in ('.Config.Env', '.Mounts', '.HostConfig.Binds', '{{json .}}'):
            self.assertNotIn(forbidden, egress.CONTAINER_PROJECTION)
        self.assertIn('{{len .HostConfig.Devices}}', egress.CONTAINER_PROJECTION)

    def test_kernel_interface_kind_address_and_ipv6_rejected(self):
        for key, value in [('ifname', 'other'), ('linkinfo', {'info_kind': 'dummy'}), ('ifindex', True),
                           ('addr_info', []), ('addr_info', bridge()[0]['addr_info'] + [{'family': 'inet6'}])]:
            changed = bridge(); changed[0][key] = value
            with self.assertRaises(egress.EgressError): egress.verify_bridge(changed)


class Control(unittest.TestCase):
    def test_invalid_cli_and_nonroot_probe_nothing(self):
        with mock.patch.object(egress, 'operate') as operate, mock.patch.object(egress.os, 'geteuid', return_value=1000):
            with contextlib.redirect_stderr(__import__('io').StringIO()):
                self.assertEqual(egress.main(['install']), 2)
                self.assertEqual(egress.main(['other']), 2)
                self.assertEqual(egress.main([]), 2)
            operate.assert_not_called()

    def test_verify_has_only_three_fixed_readonly_probes(self):
        responses = [json.dumps(network()).encode(), json.dumps(bridge()).encode(),
                     json.dumps(observed(['134.70.24.2'], 'a' * 64)).encode()]
        with mock.patch.object(egress, 'policy_inputs', return_value=(['134.70.24.2'], 'a' * 64)), \
             mock.patch.object(egress, 'bounded_child', side_effect=responses) as child:
            egress.verify()
        self.assertEqual([c.args[0] for c in child.call_args_list], [
            ['/usr/bin/docker', 'network', 'inspect', 'nutrition-ledger-azure-beta-object-egress', 'nutrition-ledger-azure-beta_backend'],
            ['/usr/sbin/ip', '-j', '-d', 'address', 'show', 'dev', 'nourishing-obj'],
            ['/usr/sbin/nft', '-j', 'list', 'table', 'inet', 'nourishing_object_egress']])

    def test_watchdog_quarantines_drift_without_restart(self):
        with mock.patch.object(egress, 'locked', contextlib.nullcontext), \
             mock.patch.object(egress, 'verify', side_effect=egress.EgressError('drift')), \
             mock.patch.object(egress, 'quarantine') as quarantine:
            with self.assertRaises(egress.EgressError): egress.operate('watchdog')
            quarantine.assert_called_once_with()

    def test_watchdog_quarantine_failure_remains_failure(self):
        with mock.patch.object(egress, 'locked', contextlib.nullcontext), \
             mock.patch.object(egress, 'verify', side_effect=egress.EgressError('drift')), \
             mock.patch.object(egress, 'quarantine', side_effect=egress.EgressError('failed')):
            with self.assertRaises(egress.EgressError): egress.operate('watchdog')

    def test_watchdog_quarantines_malformed_and_cancelled_probe(self):
        for failure in (TypeError('synthetic'), KeyError('synthetic'), KeyboardInterrupt()):
            with mock.patch.object(egress, 'locked', contextlib.nullcontext), \
                 mock.patch.object(egress, 'verify', side_effect=failure), \
                 mock.patch.object(egress, 'quarantine') as quarantine:
                with self.assertRaises(egress.EgressError): egress.operate('watchdog')
                quarantine.assert_called_once_with()

    def test_cancellation_during_containment_finishes_bounded_attempt(self):
        real = subprocess.Popen
        children = []; completed = []
        def spawn(*args, **kwargs):
            process = real(*args, **kwargs); children.append(process)
            os.kill(os.getpid(), signal.SIGTERM)
            return process
        def synthetic_quarantine():
            self.assertEqual(egress.bounded_child([sys.executable, '-c', 'print("quarantine-probe")']),
                             b'quarantine-probe\n')
            completed.append(True)
        prior = signal.getsignal(signal.SIGTERM)
        with egress.termination_scope(), mock.patch.object(egress.subprocess, 'Popen', side_effect=spawn), \
             mock.patch.object(egress, 'quarantine', side_effect=synthetic_quarantine):
            egress.contain_failure(egress.EgressError('synthetic primary failure'))
        self.assertEqual(completed, [True]); self.assertEqual(signal.getsignal(signal.SIGTERM), prior)
        self.assertIsNotNone(children[0].poll())
        self.assertTrue(children[0].stdin.closed and children[0].stdout.closed)

    def test_install_interruption_after_publication_requarantines(self):
        for failure in (egress.EgressError('postcheck'), KeyboardInterrupt()):
            events = []
            with mock.patch.object(egress, 'locked', contextlib.nullcontext), \
                 mock.patch.object(egress, 'quarantine', side_effect=lambda: events.append('quarantine')), \
                 mock.patch.object(egress, 'policy_inputs', return_value=(['134.70.24.2'], 'a' * 64)), \
                 mock.patch.object(egress, 'live_network'), mock.patch.object(egress, 'verify_bridge'), \
                 mock.patch.object(egress, 'bounded_child', side_effect=lambda argv, *args: events.append(argv) or b'[]'), \
                 mock.patch.object(egress, 'verify', side_effect=failure):
                with self.assertRaises(type(failure)): egress.operate('install')
            self.assertEqual(events[0], 'quarantine'); self.assertEqual(events[-1], 'quarantine')
            self.assertEqual(events[-2], ['/usr/sbin/nft', '-j', '-f', '-'])

    def test_initial_install_quarantine_failure_or_cancel_gets_one_containment_attempt(self):
        for primary in (egress.EgressError('synthetic initial failure'), KeyboardInterrupt()):
            with mock.patch.object(egress, 'locked', contextlib.nullcontext), \
                 mock.patch.object(egress, 'quarantine', side_effect=[primary, None]) as quarantine, \
                 mock.patch.object(egress, 'policy_inputs') as inputs_probe, \
                 mock.patch.object(egress, 'bounded_child') as child:
                with self.assertRaises(type(primary)) as failure:
                    egress.operate('install')
                self.assertIs(failure.exception, primary)
                self.assertEqual(quarantine.call_count, 2)
                inputs_probe.assert_not_called(); child.assert_not_called()

    def test_failed_initial_and_containment_quarantine_retain_both_errors_and_redact_cli(self):
        primary = egress.EgressError('synthetic primary private context')
        containment = egress.EgressError('synthetic containment private context')
        with mock.patch.object(egress, 'locked', contextlib.nullcontext), \
             mock.patch.object(egress, 'quarantine', side_effect=[primary, containment]) as quarantine:
            with self.assertRaises(egress.EgressError) as failure:
                egress.operate('install')
            self.assertEqual(quarantine.call_count, 2)
        self.assertIs(failure.exception.__cause__, primary)
        self.assertIs(failure.exception.__context__, containment)
        self.assertIn('quarantine not verified', str(failure.exception))
        output = __import__('io').StringIO()
        with mock.patch.object(egress.os, 'geteuid', return_value=0), \
             mock.patch.object(egress, 'operate', side_effect=failure.exception), contextlib.redirect_stderr(output):
            self.assertEqual(egress.main(['install']), 1)
        self.assertNotIn('private context', output.getvalue())

    def test_install_invalid_inputs_cannot_publish_permissive_policy(self):
        with mock.patch.object(egress, 'locked', contextlib.nullcontext), \
             mock.patch.object(egress, 'quarantine') as quarantine, \
             mock.patch.object(egress, 'policy_inputs', side_effect=egress.EgressError('stale')), \
             mock.patch.object(egress, 'bounded_child') as child:
            with self.assertRaises(egress.EgressError): egress.operate('install')
            self.assertEqual(quarantine.call_count, 2); child.assert_not_called()

    def test_quarantine_needs_no_config_dns_or_docker(self):
        with mock.patch.object(egress, 'bounded_child', return_value=b'') as child, \
             mock.patch.object(egress, 'live_rules', return_value=observed()), \
             mock.patch.object(egress, 'policy_inputs', side_effect=AssertionError):
            egress.quarantine()
        self.assertEqual(child.call_count, 1)
        self.assertEqual(child.call_args.args[0], ['/usr/sbin/nft', '-j', '-f', '-'])

    def test_bounded_child_handles_success_cap_and_timeout(self):
        self.assertEqual(egress.bounded_child([sys.executable, '-c', 'print("ok")']), b'ok\n')
        for command, options in [('print("x" * 1000)', {'cap': 32}),
                                 ('import time; time.sleep(2)', {'timeout': .05})]:
            with self.assertRaises(egress.EgressError):
                egress.bounded_child([sys.executable, '-c', command], **options)

    def test_spawn_boundary_cancellation_reaps_owned_child(self):
        real = subprocess.Popen
        children = []
        def spawn(*args, **kwargs):
            process = real(*args, **kwargs); children.append(process)
            os.kill(os.getpid(), signal.SIGTERM)
            return process
        with egress.termination_scope(), mock.patch.object(egress.subprocess, 'Popen', side_effect=spawn):
            with self.assertRaises(egress.EgressError):
                egress.bounded_child([sys.executable, '-c', 'import time; time.sleep(10)'])
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        self.assertTrue(children[0].stdin.closed and children[0].stdout.closed)


class FilesAndUnits(unittest.TestCase):
    @contextlib.contextmanager
    def synthetic_root(self):
        # Ordinary CI runner: only owner identity and temporary ancestors are
        # modeled. File opens, inode/mode checks and flock are real syscalls.
        real_fstat, real_lstat = os.fstat, pathlib.Path.lstat
        def rooted(info):
            names = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
            return SimpleNamespace(**{name: getattr(info, name) for name in names}, st_uid=0, st_gid=0)
        with mock.patch.object(egress, 'safe_parents'), \
             mock.patch.object(egress.os, 'fstat', side_effect=lambda fd: rooted(real_fstat(fd))), \
             mock.patch.object(pathlib.Path, 'lstat', lambda p: rooted(real_lstat(p))):
            yield

    def test_real_file_mode_symlink_and_hardlink_guards(self):
        with tempfile.TemporaryDirectory(prefix='nourishing-egress-test-') as directory:
            root = pathlib.Path(directory); path = root / 'policy'
            path.write_bytes(b'fixed'); path.chmod(0o600)
            with self.synthetic_root():
                self.assertEqual(egress.read_file(path, 0o600), b'fixed')
                with self.assertRaises(egress.EgressError): egress.read_file(path, 0o644)
                link = root / 'symlink'; link.symlink_to(path)
                with self.assertRaises(OSError): egress.read_file(link, 0o600)
                os.link(path, root / 'hardlink')
                with self.assertRaises(egress.EgressError): egress.read_file(path, 0o600)

    def test_real_lock_serializes_and_releases_after_failure(self):
        with tempfile.TemporaryDirectory(prefix='nourishing-egress-test-') as directory, \
             mock.patch.object(egress, 'LOCK', pathlib.Path(directory) / 'lock'), self.synthetic_root():
            with self.assertRaisesRegex(RuntimeError, 'synthetic'):
                with egress.locked():
                    with self.assertRaises(egress.EgressError):
                        with egress.locked(): self.fail('concurrent writer admitted')
                    raise RuntimeError('synthetic')
            with egress.locked(): pass

    def test_units_quarantine_before_required_docker_and_watchdog_never_starts_it(self):
        root = PATH.parent
        boot = (root / 'nutrition-azure-object-egress.service').read_text()
        watch = (root / 'nutrition-azure-object-egress-watchdog.service').read_text()
        timer = (root / 'nutrition-azure-object-egress-watchdog.timer').read_text()
        for required in ('DefaultDependencies=no', 'Before=docker.service', 'RequiredBy=docker.service',
                         'object-egress.py quarantine', 'RuntimeDirectoryPreserve=yes'):
            self.assertIn(required, boot)
        self.assertIn('Requisite=nutrition-azure-object-egress.service docker.service', watch)
        self.assertNotIn('Requires=', watch)
        self.assertIn('object-egress.py watchdog', watch)
        for unit in (boot, watch):
            self.assertIn('TimeoutStartSec=75', unit)
            self.assertIn('KillMode=control-group', unit)
            self.assertNotIn('systemctl', unit)
            self.assertNotIn('ExecStop=', unit)
        self.assertIn('OnUnitActiveSec=15s', timer)


if __name__ == '__main__':
    unittest.main(verbosity=2)
