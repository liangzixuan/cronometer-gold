"""Synthetic complete subscription baseline and retained-consumer tests. No provider requests."""
from datetime import datetime, timezone
import configparser
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('baseline', Path(__file__).with_name('subscription-baseline.py'))
Q = importlib.util.module_from_spec(spec); spec.loader.exec_module(Q)
SUB = '11111111-2222-3333-4444-555555555555'
TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
NOW = datetime(2026, 10, 18, 8, tzinfo=timezone.utc)

def make_fixture(root, source, now):
    root.chmod(0o700)
    profile = root / 'profile'; profile.mkdir(mode=0o700)
    config = configparser.ConfigParser(); config.read_dict(Q.P.SETTINGS)
    with (profile / 'config').open('w') as stream: config.write(stream)
    (profile / 'config').chmod(0o600)
    (profile / 'clouds.config').write_text('[AzureCloud]\nsubscription = ' + SUB + '\n')
    (profile / 'clouds.config').chmod(0o600)
    def put(name, value):
        path = root / name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream: json.dump(value, stream); stream.write('\n')
    expected = {'subscriptionId': SUB, 'tenantId': TENANT}
    put('identity.json', expected)
    put('request.json', {'schema_version': 1, 'source_sha256': source,
        'identity_file': str(root / 'identity.json'), 'profile_directory': str(profile),
        'operation_name': 'nourishing-baseline-0123456789ab', 'not_after_utc': '2026-10-18T08:12:00Z'})
    values = {
        'auth-version': {'azure-cli': '2.90.0', 'azure-cli-core': '2.90.0', 'azure-cli-telemetry': '1', 'extensions': {}},
        'auth-extensions': [],
        'auth-account': {'id': SUB, 'tenantId': TENANT, 'state': 'Enabled', 'environmentName': 'AzureCloud'},
        'auth-subscription': dict(expected, state='Enabled', subscriptionPolicies={'quotaId': 'AzureForStudents_2018-01-01', 'spendingLimit': 'On'}),
        'read-resources': {'resources': [{'id': '/subscriptions/' + SUB + '/resourceGroups/synthetic/providers/Microsoft.Compute/disks/one',
            'name': 'one', 'type': 'Microsoft.Compute/disks', 'location': 'centralus', 'sku': {'name': 'Standard_LRS'}, 'plan': None, 'managedBy': None}], 'nextLink': None},
        'read-cost': {'columns': [{'name': 'PreTaxCost', 'type': 'Number'}, {'name': 'ResourceGroup', 'type': 'String'}, {'name': 'Currency', 'type': 'String'}],
                      'rows': [[1.25, 'synthetic', 'USD']], 'nextLink': None},
    }
    put('synthetic.json', values)
    return values

class Baseline(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='nourishing-baseline-policy-', dir=Path.home()))
        self.values = make_fixture(self.root, Q.source_digest(), NOW)
        self.request = self.root / 'request.json'
        self.mock = patch.object(Q.P, 'tool_digest', return_value=(Q.P.CLI_SHA256, 100))
        self.mock.start(); self.addCleanup(self.mock.stop)

    def prepared(self):
        self.session = Q.prepare(self.request, NOW)
        self.directory = Path(self.session['directory'])
        self.params = (self.request, self.directory, self.session['state_sha256'], NOW)
        return self.params

    def captured(self, change=None):
        self.prepared()
        values = copy.deepcopy(self.values)
        if change: change(values)
        for name in Q.AUTH: Q.write_json(self.directory / ('auth-' + name + '.json'), values['auth-' + name])
        descriptors = Q.requests(*self.params)
        commands = [('auth-' + label, args + ['--only-show-errors', '--output', 'json']) for label, args in self.session['auth_commands']]
        for item in descriptors:
            label = 'read-' + item['label']; Q.write_json(self.directory / (label + '.json'), values[label]); commands.append((label, item['arguments']))
        phases = []
        for label, arguments in commands:
            raw = (self.directory / (label + '.json')).read_bytes()
            phases.append({'label': label, 'arguments': arguments, 'executableSha256': Q.P.CLI_SHA256,
                'startedAt': NOW.isoformat(), 'endedAt': NOW.isoformat(), 'completed': True, 'exitCode': 0,
                'stdoutBytes': len(raw), 'stdoutSha256': Q.A.sha(raw), 'stderrBytes': 0, 'stderrSha256': Q.A.sha(b'')})
        Q.write_json(self.directory / 'phases.json', phases)
        return self.params

    def test_complete_capture_and_retained_consumer(self):
        result = Q.finish(*self.captured())
        readback = Q.verify_result(*self.params, result['index_sha256'])
        self.assertTrue(readback['completed'])
        self.assertEqual(readback['observations']['resourceCount'], 1)
        self.assertEqual(readback['observations']['costRowCount'], 1)
        self.assertEqual(readback['observations']['currencies'], ['USD'])
        self.assertTrue((self.directory / 'cost-query.json').exists())

    def test_explicit_empty_rows_do_not_claim_zero_cost(self):
        result = Q.finish(*self.captured(lambda values: values['read-cost'].update(rows=[])))
        value = Q.verify_result(*self.params, result['index_sha256'])
        self.assertTrue(value['observations']['emptyCostRows'])
        self.assertEqual(value['observations']['currencies'], [])
        self.assertNotIn('totalCost', value['observations'])

    def test_reordered_columns_and_signed_cost_observations(self):
        resources = self.values['read-resources']; costs = self.values['read-cost']
        costs['columns'] = [costs['columns'][2], costs['columns'][1], costs['columns'][0]]
        costs['rows'] = [['USD', None, -1.25], ['EUR', '', 2]]
        self.assertEqual(Q.observations(resources, costs, SUB)['currencies'], ['EUR', 'USD'])

    def test_incomplete_or_malformed_observations(self):
        cases = [
            lambda r,c: r.update(nextLink='https://management.azure.com/next'),
            lambda r,c: r.update(resources=None),
            lambda r,c: r['resources'].extend(r['resources'] * 200),
            lambda r,c: r['resources'].append(copy.deepcopy(r['resources'][0])),
            lambda r,c: r['resources'][0].update(id=r['resources'][0]['id'].replace(SUB, TENANT)),
            lambda r,c: r['resources'][0].update(id='https://management.azure.com/subscriptions/' + SUB),
            lambda r,c: c.update(nextLink='https://management.azure.com/next'),
            lambda r,c: c.update(rows=None),
            lambda r,c: c.update(columns=[]),
            lambda r,c: c['columns'][1].update(name='PreTaxCost'),
            lambda r,c: c['columns'][0].update(type='String'),
            lambda r,c: c['rows'].append([1, 'synthetic', 'USD']),
            lambda r,c: c['rows'][0].__setitem__(0, True),
            lambda r,c: c['rows'][0].__setitem__(0, float('inf')),
            lambda r,c: c['rows'][0].__setitem__(2, 'usd'),
            lambda r,c: c['rows'][0].append('extra'),
            lambda r,c: c['rows'].extend(c['rows'] * 200),
        ]
        for number, change in enumerate(cases):
            with self.subTest(case=number):
                resources = copy.deepcopy(self.values['read-resources']); costs = copy.deepcopy(self.values['read-cost'])
                change(resources, costs)
                with self.assertRaises((Q.A.Error, TypeError)): Q.observations(resources, costs, SUB)
        with self.assertRaises(Q.A.Error): Q.observations(self.values['read-resources'], None, SUB)

    def test_authentication_failure_stops_before_descriptors(self):
        self.prepared()
        for name in Q.AUTH: Q.write_json(self.directory / ('auth-' + name + '.json'), {} if name == 'account' else self.values['auth-' + name])
        with self.assertRaises(Q.A.Error): Q.requests(*self.params)
        self.assertFalse((self.directory / 'index.json').exists())

    def test_changed_body_and_original_directory_rejected(self):
        self.prepared()
        original = self.directory.with_name(self.directory.name + '-original')
        self.directory.rename(original); shutil.copytree(original, self.directory)
        with self.assertRaises(Q.A.Error): Q.verify(*self.params)
        self.assertTrue((original / 'session.json').exists())

    def test_changed_fixed_body_rejected(self):
        self.prepared(); (self.directory / 'cost-query.json').write_text('{}\n')
        with self.assertRaises(Q.A.Error): Q.verify(*self.params)

    def test_changed_retained_response_or_index_rejected(self):
        result = Q.finish(*self.captured())
        response = self.directory / 'read-cost.json'
        response.rename(self.root / 'original-read-cost.json')
        response.write_text('{}\n'); response.chmod(0o600)
        with self.assertRaises(Q.A.Error): Q.verify_result(*self.params, result['index_sha256'])

    def test_false_completed_phase_rejected(self):
        self.captured()
        path = self.directory / 'phases.json'
        phases = json.loads(path.read_text()); phases[-1]['completed'] = False
        path.write_text(json.dumps(phases) + '\n')
        with self.assertRaises(Q.A.Error): Q.finish(*self.params)
        self.assertFalse((self.directory / 'index.json').exists())

    def test_request_expiry_extra_field_and_scope_are_fixed(self):
        value = json.loads(self.request.read_text())
        for change in [lambda v:v.update(url='https://example.invalid'), lambda v:v.update(operation_name='../escape'), lambda v:v.update(not_after_utc='2026-10-18T07:59:59Z')]:
            candidate = copy.deepcopy(value); change(candidate)
            self.request.write_text(json.dumps(candidate) + '\n')
            with self.assertRaises(Q.A.Error): Q.prepare(self.request, NOW)

if __name__ == '__main__': unittest.main(testRunner=unittest.TextTestRunner(stream=sys.stdout, verbosity=2))
