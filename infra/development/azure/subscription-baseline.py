#!/usr/bin/env python3
"""Pure subscription baseline preparation and retained-result validation; no child execution."""
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('baseline_auth', ROOT / 'auth-preflight.py')
P = importlib.util.module_from_spec(spec); spec.loader.exec_module(P)
A = P.A
require = A.require
FIELDS = {'schema_version', 'source_sha256', 'identity_file', 'profile_directory', 'operation_name', 'not_after_utc'}
AUTH = ('version', 'extensions', 'account', 'subscription')
MAX_AUTH = 131072
MAX_QUERY = 1048576
MAX_AGGREGATE = 4194304
BODY = {'type': 'Usage', 'timeframe': 'MonthToDate', 'dataset': {
    'granularity': 'None', 'aggregation': {'totalCost': {'name': 'PreTaxCost', 'function': 'Sum'}},
    'grouping': [{'name': 'ResourceGroup', 'type': 'Dimension'}]}}
RESOURCE_QUERY = '{resources:value[].{id:id,name:name,type:type,location:location,sku:sku,plan:plan,managedBy:managedBy},nextLink:nextLink}'
COST_QUERY = '{columns:properties.columns,rows:properties.rows,nextLink:properties.nextLink}'
OUTPUTS = {'session.json': 16384, 'cost-query.json': 16384, 'phases.json': 65536, 'index.json': 16384,
           **{'auth-' + name + '.json': MAX_AUTH for name in AUTH},
           'read-resources.json': MAX_QUERY, 'read-cost.json': MAX_QUERY}
SCOPE = 'Unsigned subscription-only resource and month-to-date usage observations; no ownership, credit, spending cap, allocation or runtime acceptance.'

def source_digest():
    A.native_source_digest()
    names = A.NATIVE_SOURCES + ['infra/development/azure/subscription-baseline.py', 'scripts/azure-development-baseline.mjs']
    entries = []
    for name in names:
        path = A.REPO / name
        P.safe_path(path)
        info = path.stat()
        require(stat.S_ISREG(info.st_mode), 'regular baseline source required')
        entries.append([name, A.sha(path.read_bytes()), stat.S_IMODE(info.st_mode)])
    return A.sha(json.dumps(entries, separators=(',', ':')).encode())

def encoded(value):
    return (json.dumps(value, sort_keys=True) + '\n').encode()

def write_json(path, value):
    raw = encoded(value)
    require(len(raw) <= OUTPUTS[path.name], 'baseline file exceeds bound')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())

def load_request(path, now):
    P.safe_path(path)
    value, digest = A.private_json(path)
    require(isinstance(value, dict) and set(value) == FIELDS and type(value['schema_version']) is int
            and value['schema_version'] == 1, 'exact baseline request required')
    require(isinstance(value['operation_name'], str) and re.fullmatch(r'nourishing-baseline-[0-9a-f]{12}', value['operation_name']), 'new baseline operation required')
    require(value['source_sha256'] == source_digest(), 'reviewed baseline source changed')
    horizon = A.utc(value['not_after_utc'], 'baseline deadline')
    require(now < horizon <= now + timedelta(minutes=15), 'baseline deadline outside finite bound')
    expected, identity = P.identity(Path(value['identity_file']))
    snapshot = {'source': value['source_sha256'], 'request': digest, 'identity': identity,
                'profile': P.profile_digest(Path(value['profile_directory'])), 'azure': P.tool_digest(Path('/usr/bin/az'))[0]}
    return value, expected, snapshot

def tree(directory):
    result = {}; total = 0
    entries = list(directory.iterdir())
    require(len(entries) <= len(OUTPUTS) + 3, 'baseline entry count exceeds bound')
    for path in entries:
        info = path.lstat()
        require(info.st_uid == os.getuid(), 'baseline entry owner differs')
        if path.name in ('home', 'tmp', 'work'):
            require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700 and not list(path.iterdir()), 'unexpected baseline scratch content')
            result[path.name] = {'directory': True}; continue
        require(path.name in OUTPUTS and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= OUTPUTS[path.name], 'unsafe baseline file')
        total += info.st_size
        require(total <= MAX_AGGREGATE, 'baseline aggregate exceeds bound')
        _, digest = A.private_json(path)
        result[path.name] = {'bytes': info.st_size, 'sha256': digest}
    return result

def prepare(path, now):
    request, expected, snapshot = load_request(path, now)
    directory = path.parent / request['operation_name']; directory.mkdir(mode=0o700)
    for name in ('home', 'tmp', 'work'): (directory / name).mkdir(mode=0o700)
    info = directory.stat()
    write_json(directory / 'cost-query.json', BODY)
    write_json(directory / 'session.json', {'snapshot': snapshot, 'request': str(path),
        'createdAt': now.isoformat().replace('+00:00', 'Z'), 'directory_identity': [info.st_dev, info.st_ino]})
    require(load_request(path, now)[2] == snapshot, 'baseline changed during preparation')
    return {'directory': str(directory), 'state_sha256': A.sha((directory / 'session.json').read_bytes()),
            'azure': {'path': '/usr/bin/az', 'sha256': P.CLI_SHA256}, 'auth_commands': P.commands(expected),
            'profile_directory': request['profile_directory']}

def verify(path, directory, state_hash, now):
    P.safe_path(directory); A.H._require_private_directory(directory, 'baseline operation')
    state, actual = A.private_json(directory / 'session.json')
    require(actual == state_hash, 'baseline session binding changed')
    request, expected, snapshot = load_request(path, now); info = directory.stat()
    require(directory == path.parent / request['operation_name'] and state['request'] == str(path)
            and state['directory_identity'] == [info.st_dev, info.st_ino] and state['snapshot'] == snapshot, 'baseline directory or input changed')
    tree(directory)
    require((directory / 'cost-query.json').read_bytes() == encoded(BODY), 'fixed cost body changed')
    return state, request, expected

def authenticate(path, directory, state_hash, now):
    _, _, expected = verify(path, directory, state_hash, now)
    for label, _ in P.commands(expected):
        value, _ = A.private_json(directory / ('auth-' + label + '.json'))
        P.validate_response(label, value, expected)

def requests(path, directory, state_hash, now):
    authenticate(path, directory, state_hash, now)
    _, _, expected = verify(path, directory, state_hash, now)
    base = 'https://management.azure.com/subscriptions/' + expected['subscriptionId']
    suffix = ['--subscription', expected['subscriptionId'], '--only-show-errors', '--output', 'json']
    return [
        {'label': 'resources', 'arguments': ['rest', '--method', 'get', '--url', base + '/resources?api-version=2021-04-01&%24top=200', '--query', RESOURCE_QUERY] + suffix},
        {'label': 'cost', 'arguments': ['rest', '--method', 'post', '--url', base + '/providers/Microsoft.CostManagement/query?api-version=2025-03-01', '--headers', 'Content-Type=application/json', '--body', '@' + str(directory / 'cost-query.json'), '--query', COST_QUERY] + suffix},
    ]

def text(value, label, *, empty=False, maximum=2048):
    require(isinstance(value, str) and (empty or bool(value)) and len(value) <= maximum
            and all(ord(c) >= 32 and ord(c) != 127 for c in value), label + ' malformed')
    return value

def observations(resources, costs, subscription):
    require(isinstance(resources, dict) and set(resources) == {'resources', 'nextLink'}
            and resources['nextLink'] is None and isinstance(resources['resources'], list)
            and len(resources['resources']) <= 200, 'resource inventory incomplete')
    identifiers = set()
    for row in resources['resources']:
        require(isinstance(row, dict) and set(row) == {'id', 'name', 'type', 'location', 'sku', 'plan', 'managedBy'}, 'resource row malformed')
        identifier = text(row['id'], 'resource identifier')
        parts = identifier.split('/')
        require(len(parts) >= 9 and parts[0] == '' and parts[1].lower() == 'subscriptions'
                and parts[2].lower() == subscription and parts[3].lower() == 'resourcegroups'
                and parts[5].lower() == 'providers' and all(parts[1:])
                and identifier.lower() not in identifiers, 'resource scope or identifier differs')
        identifiers.add(identifier.lower())
        text(row['name'], 'resource name'); text(row['type'], 'resource type')
        text(row['location'], 'resource location', empty=True, maximum=256)
        for name in ('sku', 'plan'): require(row[name] is None or isinstance(row[name], dict), 'resource metadata malformed')
        if row['managedBy'] is not None: text(row['managedBy'], 'managedBy')
    require(isinstance(costs, dict) and set(costs) == {'columns', 'rows', 'nextLink'} and costs['nextLink'] is None
            and isinstance(costs['columns'], list) and len(costs['columns']) == 3
            and isinstance(costs['rows'], list) and len(costs['rows']) <= 200, 'cost response incomplete')
    columns = {}
    for position, column in enumerate(costs['columns']):
        require(isinstance(column, dict) and set(column) == {'name', 'type'} and isinstance(column['name'], str)
                and column['name'] not in columns, 'cost columns malformed')
        columns[column['name']] = (position, column['type'])
    require({name: kind for name, (_, kind) in columns.items()} == {'PreTaxCost': 'Number', 'ResourceGroup': 'String', 'Currency': 'String'}, 'cost schema differs')
    groups = set(); currencies = set()
    for row in costs['rows']:
        require(isinstance(row, list) and len(row) == 3, 'cost row malformed')
        amount, group, currency = (row[columns[name][0]] for name in ('PreTaxCost', 'ResourceGroup', 'Currency'))
        require(type(amount) in (int, float) and math.isfinite(amount), 'cost amount malformed')
        if group is not None: text(group, 'cost resource group', empty=True, maximum=90)
        require(isinstance(currency, str) and re.fullmatch(r'[A-Z]{3}', currency), 'cost currency malformed')
        key = ((group or '').lower(), currency)
        require(key not in groups, 'duplicate grouped cost row'); groups.add(key); currencies.add(currency)
    return {'resourceCount': len(identifiers), 'costRowCount': len(costs['rows']), 'costColumns': costs['columns'],
            'currencies': sorted(currencies), 'emptyCostRows': not costs['rows']}

def retained_value(path, directory, state_hash, now):
    state, request, expected = verify(path, directory, state_hash, now)
    descriptors = requests(path, directory, state_hash, now)
    commands = [{'label': 'auth-' + label, 'arguments': args + ['--only-show-errors', '--output', 'json']} for label, args in P.commands(expected)]
    commands += [{'label': 'read-' + item['label'], 'arguments': item['arguments']} for item in descriptors]
    phases, phases_hash = A.private_json(directory / 'phases.json')
    require(isinstance(phases, list) and len(phases) == 6, 'six baseline phases required')
    previous = A.receipt_utc(state['createdAt'], 'baseline creation')
    for phase, command in zip(phases, commands):
        require(isinstance(phase, dict) and set(phase) == {'label', 'arguments', 'executableSha256', 'startedAt', 'endedAt', 'completed', 'exitCode', 'stdoutBytes', 'stdoutSha256', 'stderrBytes', 'stderrSha256'}
                and phase['label'] == command['label'] and phase['arguments'] == command['arguments']
                and phase['executableSha256'] == P.CLI_SHA256 and phase['completed'] is True
                and type(phase['exitCode']) is int and phase['exitCode'] == 0, 'baseline phase differs')
        start = A.receipt_utc(phase['startedAt'], 'phase start'); end = A.receipt_utc(phase['endedAt'], 'phase end')
        require(previous <= start <= end <= now and end - start <= timedelta(seconds=60), 'baseline phase time differs')
        previous = end
        raw = (directory / (phase['label'] + '.json')).read_bytes()
        require(type(phase['stdoutBytes']) is int and phase['stdoutBytes'] == len(raw) and phase['stdoutSha256'] == A.sha(raw), 'baseline stdout changed')
        require(type(phase['stderrBytes']) is int and 0 <= phase['stderrBytes'] <= 65536
                and isinstance(phase['stderrSha256'], str) and re.fullmatch(r'[a-f0-9]{64}', phase['stderrSha256']), 'baseline diagnostics malformed')
    resources, _ = A.private_json(directory / 'read-resources.json'); costs, _ = A.private_json(directory / 'read-cost.json')
    summary = observations(resources, costs, expected['subscriptionId'])
    inventory = tree(directory); inventory.pop('index.json', None)
    return {'completed': True, 'schemaVersion': 1, 'scope': SCOPE, 'source_sha256': request['source_sha256'],
            'input_sha256': state['snapshot'], 'observedThroughUtc': phases[-1]['endedAt'], 'phases_sha256': phases_hash,
            'observations': summary, 'retained_evidence': inventory}

def finish(path, directory, state_hash, now):
    result = retained_value(path, directory, state_hash, now)
    A.publish_result(directory / 'index.json', result)
    digest = A.private_json(directory / 'index.json')[1]
    verify_result(path, directory, state_hash, now, digest)
    return {'completed': True, 'index_sha256': digest}

def verify_result(path, directory, state_hash, now, expected_hash):
    value, digest = A.private_json(directory / 'index.json')
    require(digest == expected_hash and value == retained_value(path, directory, state_hash, now), 'retained baseline result changed')
    return {'completed': True, 'index_sha256': digest, 'observations': value['observations'], 'scope': SCOPE}

def main(argv=None):
    os.umask(0o077)
    args = sys.argv[1:] if argv is None else argv
    try:
        require(len(args) in (2, 4, 5), 'fixed baseline helper arguments required')
        mode, name = args[:2]; path = Path(name); now = datetime.now(timezone.utc)
        if mode == 'prepare':
            require(len(args) == 2, 'fixed prepare arguments required'); value = prepare(path, now)
        else:
            require(len(args) == (5 if mode == 'verify-result' else 4), 'fixed baseline stage arguments required')
            params = (path, Path(args[2]), args[3], now)
            if mode == 'verify': verify(*params); value = {'verified': True}
            elif mode == 'authenticate': authenticate(*params); value = {'authenticated': True}
            elif mode == 'requests': value = requests(*params)
            elif mode == 'finish': value = finish(*params)
            elif mode == 'verify-result': value = verify_result(*params, args[4])
            else: raise A.Error('unknown baseline stage')
        print(json.dumps(value, separators=(',', ':'))); return 0
    except Exception:
        print('Subscription baseline rejected; private partial or published evidence may remain. No acceptance established.', file=sys.stderr)
        return 1

if __name__ == '__main__': raise SystemExit(main())
