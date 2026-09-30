#!/usr/bin/env python3
"""Local, recoverable Azure credential publication. Never starts a service."""

from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid

CONFIG = Path('/etc/nutrition-tracker')
PROJECT = 'nutrition-ledger-azure-beta'
LIMIT = 65536
ROLES = {
    'api.env': {'EXPORT_ARTIFACT_READ_ACCESS_KEY_ID': ('exportReader', 'accessKeyId'),
                'EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY': ('exportReader', 'secretAccessKey')},
    'worker.env': {'EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID': ('exportWriter', 'accessKeyId'),
                   'EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY': ('exportWriter', 'secretAccessKey'),
                   'ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID': ('ledgerWriter', 'accessKeyId'),
                   'ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY': ('ledgerWriter', 'secretAccessKey')},
    'restore.env': {'ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID': ('ledgerRestore', 'accessKeyId'),
                    'ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY': ('ledgerRestore', 'secretAccessKey'),
                    'ERASURE_REPLAY_LEDGER_RESTORE_OCI_KEY_FINGERPRINT': ('restoreApi', 'fingerprint')},
}
TARGETS = tuple(ROLES) + ('oci/restore-private-key.pem',)
PHASES = {'preparing', 'publishing', 'installed', 'rolling_back', 'rolled_back'}
TERMINAL = {'installed', 'rolled_back'}


class CredentialError(Exception):
    """Only fixed, non-secret descriptions leave this module."""


def require(condition, message):
    if not condition:
        raise CredentialError(message)


def decode_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate JSON field')
            result[key] = value
        return result
    try:
        require(len(raw) <= LIMIT, 'Input exceeds size limit')
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(CredentialError('Invalid JSON constant')))
    except (ValueError, UnicodeError, RecursionError, TypeError):
        raise CredentialError('Invalid JSON document') from None


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def bounded_child(argv, data=b'', timeout=15, cap=LIMIT):
    """Fixed callers only; stdin carries keys. Bound output, wall time and reap."""
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
            raise CredentialError('Credential probe cancelled')
    for number in signals:
        signal.signal(number, defer)
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, start_new_session=True,
                                   env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        require(not deferred, 'Credential probe cancelled')
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
                require(not deferred, 'Credential probe cancelled')
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'Credential probe timed out')
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
                        require(len(output) <= cap, 'Credential probe output exceeded limit')
            require(not deferred, 'Credential probe cancelled')
            require(process.wait(timeout=max(.01, deadline - time.monotonic())) == 0,
                    'Credential probe failed')
            return bytes(output)
    except (subprocess.TimeoutExpired, OSError):
        raise CredentialError('Credential probe failed') from None
    finally:
        try:
            if process is not None:
                # Also terminate descendants after a successful leader exit.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=5)
                for pipe in (process.stdin, process.stdout):
                    if not pipe.closed:
                        pipe.close()
        finally:
            resume()


def der_item(raw, at=0):
    require(at + 2 <= len(raw), 'Invalid RSA public key')
    tag, size = raw[at], raw[at + 1]
    start = at + 2
    if size & 128:
        count = size & 127
        require(1 <= count <= 4 and start + count <= len(raw), 'Invalid RSA public key')
        require(raw[start] != 0, 'Invalid RSA public key')
        size = int.from_bytes(raw[start:start + count], 'big')
        require(size >= 128, 'Invalid RSA public key')
        start += count
    require(start + size <= len(raw), 'Invalid RSA public key')
    return tag, raw[start:start + size], start + size


def validate_key(pem, fingerprint):
    require(isinstance(pem, str) and len(pem) <= 16384, 'Invalid private key')
    match = re.fullmatch(r'-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----\n([A-Za-z0-9+/=\n]+)\n-----END \1-----\n', pem)
    require(match is not None, 'Expected one unencrypted PEM private key')
    try:
        private_der = base64.b64decode(match[2].replace('\n', ''), validate=True)
    except ValueError:
        raise CredentialError('Invalid private key encoding') from None
    tag, _, end = der_item(private_der)
    require(tag == 0x30 and end == len(private_der), 'Expected exactly one private key DER object')
    bounded_child(['/usr/bin/openssl', 'pkey', '-check', '-noout'], pem.encode(), cap=1024)
    raw = bounded_child(['/usr/bin/openssl', 'pkey', '-pubout', '-outform', 'DER'], pem.encode(), cap=16384)
    tag, sequence, end = der_item(raw)
    require(tag == 0x30 and end == len(raw), 'Invalid RSA public key')
    tag, algorithm, offset = der_item(sequence)
    # rsaEncryption OID + NULL parameters, as produced by openssl pkey.
    require(tag == 0x30 and algorithm == bytes.fromhex('06092a864886f70d0101010500'),
            'Restore signing key must use RSA')
    tag, bits, end = der_item(sequence, offset)
    require(tag == 3 and end == len(sequence) and bits[:1] == b'\0', 'Invalid RSA public key')
    tag, rsa, end = der_item(bits[1:])
    require(tag == 0x30 and end == len(bits) - 1, 'Invalid RSA public key')
    tag, modulus, offset = der_item(rsa)
    require(tag == 2 and modulus and int.from_bytes(modulus, 'big').bit_length() >= 2048,
            'Restore signing RSA key must be at least 2048 bits')
    tag, exponent, end = der_item(rsa, offset)
    require(tag == 2 and end == len(rsa) and int.from_bytes(exponent, 'big') >= 3, 'Invalid RSA public key')
    actual = ':'.join(f'{byte:02x}' for byte in hashlib.md5(raw, usedforsecurity=False).digest())
    require(fingerprint == actual, 'Restore signing fingerprint mismatch')


def validate_bundle(raw):
    value = decode_json(raw)
    expected = {'schemaVersion', 'deploymentTarget', 'sourceCommit', 'restoreApi',
                'exportReader', 'exportWriter', 'ledgerWriter', 'ledgerRestore'}
    require(isinstance(value, dict) and set(value) == expected, 'Invalid credential bundle schema')
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1, 'Invalid credential schema version')
    require(value['deploymentTarget'] in ('staging', 'production'), 'Invalid deployment target')
    require(isinstance(value['sourceCommit'], str) and re.fullmatch('[0-9a-f]{40}', value['sourceCommit']), 'Invalid source commit')
    for role in ('exportReader', 'exportWriter', 'ledgerWriter', 'ledgerRestore'):
        fields = value[role]
        require(isinstance(fields, dict) and set(fields) == {'accessKeyId', 'secretAccessKey'}, 'Invalid role schema')
        for name, minimum in (('accessKeyId', 16), ('secretAccessKey', 32)):
            item = fields[name]
            require(isinstance(item, str) and minimum <= len(item) <= 256 and
                    re.fullmatch(r'[A-Za-z0-9+/=._:-]+', item), 'Unsafe credential characters or length')
    for name in ('accessKeyId', 'secretAccessKey'):
        require(len({value[role][name] for role in ('exportReader', 'exportWriter', 'ledgerWriter', 'ledgerRestore')}) == 4,
                'Object Storage roles must have distinct credentials')
    restore = value['restoreApi']
    require(isinstance(restore, dict) and set(restore) == {'privateKeyPem', 'fingerprint'}, 'Invalid restore key schema')
    require(isinstance(restore['fingerprint'], str) and re.fullmatch(r'(?:[0-9a-f]{2}:){15}[0-9a-f]{2}', restore['fingerprint']), 'Invalid fingerprint')
    validate_key(restore['privateKeyPem'], restore['fingerprint'])
    return value


def assert_stopped():
    raw = bounded_child(['/usr/bin/docker', 'container', 'ls', '--all', '--no-trunc',
                         '--filter', f'label=com.docker.compose.project={PROJECT}', '--format', '{{json .}}'])
    rows = raw.splitlines()
    require(len(rows) <= 128, 'Too many project containers')
    seen = set()
    for row in rows:
        item = decode_json(row)
        require(isinstance(item, dict), 'Invalid project container response')
        identity = item.get('ID')
        require(isinstance(identity, str) and re.fullmatch('[0-9a-f]{64}', identity) and identity not in seen, 'Invalid project container identity')
        seen.add(identity)
        labels = item.get('Labels')
        require(isinstance(labels, str) and f'com.docker.compose.project={PROJECT}' in labels.split(','), 'Unbound project container')
        require(item.get('State') in ('exited', 'created'), 'The entire Azure Compose project must be stopped')


def env_values(raw):
    try:
        text = raw.decode('utf-8')
    except UnicodeError:
        raise CredentialError('Invalid environment encoding') from None
    values = {}
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        require(separator and re.fullmatch('[A-Z][A-Z0-9_]*', key) and key not in values,
                'Invalid environment structure')
        values[key] = value
    return values


class Transaction:
    """Paths/owner overrides are for imported synthetic tests; CLI has no overrides."""

    def __init__(self, config=CONFIG, owner=0, key_owner=1000, stopped=assert_stopped, fault=lambda _: None):
        self.config = Path(config)
        self.owner = owner
        self.key_owner = key_owner
        self.stopped = stopped
        self.fault = fault
        self.root = self.config / 'credential-transactions'

    def directories(self, path):
        chain = list(path.parents)[::-1] + [path]
        for directory in chain:
            info = directory.lstat()
            allowed = {0, self.owner} if directory not in (self.config, self.config / 'oci', self.root) else {self.owner}
            require(stat.S_ISDIR(info.st_mode) and info.st_uid in allowed and info.st_gid in allowed and
                    not info.st_mode & 0o022, 'Unsafe credential parent directory')

    def fsync_directory(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def identity(self, path, mode=0o600, owner=None, absent=False):
        self.directories(path.parent)
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            require(absent, 'Required credential file is absent')
            return None, None
        try:
            info = os.fstat(fd)
            expected_owner = self.owner if owner is None else owner
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == mode and
                    info.st_uid == expected_owner and info.st_gid == expected_owner and info.st_size <= LIMIT,
                    'Unsafe credential file')
            raw = bytearray()
            while len(raw) <= LIMIT:
                chunk = os.read(fd, min(8192, LIMIT + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
            after = os.fstat(fd)
            stable = lambda item: (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid,
                                   item.st_nlink, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
            require(len(raw) <= LIMIT and stable(info) == stable(after) == stable(path.lstat()), 'Credential file changed during read')
            return {'sha256': hashlib.sha256(raw).hexdigest(), 'dev': info.st_dev, 'ino': info.st_ino,
                    'mode': mode, 'uid': info.st_uid, 'gid': info.st_gid}, bytes(raw)
        finally:
            os.close(fd)

    def target_identity(self, name):
        key = name == TARGETS[-1]
        return self.identity(self.config / name, 0o400 if key else 0o600,
                             self.key_owner if key else self.owner, absent=key)

    def write_new(self, path, raw, mode=0o600, owner=None):
        self.directories(path.parent)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            chosen = self.owner if owner is None else owner
            os.fchown(fd, chosen, chosen)
            os.fchmod(fd, mode)
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(raw)
                stream.flush()
            os.fsync(fd)
        finally:
            os.close(fd)
        self.fsync_directory(path.parent)

    def write_json(self, path, value):
        temporary = path.with_name(path.name + '.next-' + uuid.uuid4().hex)
        self.write_new(temporary, json_bytes(value))
        os.replace(temporary, path)
        self.fsync_directory(path.parent)

    @contextlib.contextmanager
    def lock(self):
        self.directories(self.config)
        path = self.config / '.credential-transaction.lock'
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600 and
                    info.st_uid == self.owner and info.st_gid == self.owner, 'Unsafe credential lock')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise CredentialError('Another credential transaction or preflight is active') from None
            require(path.lstat() == os.fstat(fd), 'Credential lock was replaced')
            os.fsync(fd)
            self.fsync_directory(self.config)
            yield
        finally:
            os.close(fd)

    def private_directory(self, path):
        self.directories(path)
        info = path.lstat()
        require(stat.S_IMODE(info.st_mode) == 0o700, 'Unsafe transaction directory')

    def load_json(self, path):
        _, raw = self.identity(path)
        result = decode_json(raw)
        require(isinstance(result, dict), 'Invalid transaction metadata')
        return result

    def scan(self):
        if not self.root.exists():
            require(not self.root.is_symlink(), 'Unsafe transaction directory')
            return None
        self.private_directory(self.root)
        pointer = self.load_json(self.root / 'current.json')
        require(set(pointer) == {'transaction'} and isinstance(pointer['transaction'], str) and
                re.fullmatch('[0-9a-f]{32}', pointer['transaction']), 'Invalid transaction pointer')
        current = None
        for directory in self.root.iterdir():
            if directory.name == 'current.json':
                continue
            require(re.fullmatch('[0-9a-f]{32}', directory.name), 'Incomplete transaction metadata; manual review required')
            self.private_directory(directory)
            journal = self.load_json(directory / 'journal.json')
            self.validate_journal(journal, directory.name)
            if directory.name == pointer['transaction']:
                current = (directory, journal)
            else:
                require(journal['phase'] in TERMINAL, 'An unselected transaction is pending; manual review required')
        require(current is not None, 'Transaction pointer has no journal')
        return current

    def validate_journal(self, journal, transaction):
        require(set(journal) == {'schemaVersion', 'transaction', 'phase', 'binding', 'parents', 'files'} and
                type(journal['schemaVersion']) is int and journal['schemaVersion'] == 1 and
                journal['transaction'] == transaction and isinstance(journal['phase'], str) and journal['phase'] in PHASES,
                'Invalid transaction journal')
        require(isinstance(journal['files'], dict) and set(journal['files']) == set(TARGETS), 'Invalid journal targets')
        require(isinstance(journal['binding'], dict) and set(journal['binding']) ==
                {'deploy.env', 'runtime.env', 'restoreIdentity', 'target', 'source'}, 'Invalid journal binding')
        require(isinstance(journal['parents'], dict) and set(journal['parents']) == {'config', 'oci'}, 'Invalid journal parents')
        for name, entry in journal['files'].items():
            require(isinstance(entry, dict) and set(entry) == {'old', 'new', 'rollback', 'backupSha256'}, 'Invalid journal file record')
            for identity in (entry['old'], entry['new'], entry['rollback']):
                if identity is None:
                    continue
                require(isinstance(identity, dict) and set(identity) == {'sha256', 'dev', 'ino', 'mode', 'uid', 'gid'} and
                        isinstance(identity['sha256'], str) and re.fullmatch('[0-9a-f]{64}', identity['sha256']) and
                        all(type(identity[key]) is int and identity[key] >= 0 for key in ('dev', 'ino', 'mode', 'uid', 'gid')),
                        'Invalid journal file identity')
            require(entry['old'] is not None or name == TARGETS[-1], 'Invalid absent environment record')
            require(entry['backupSha256'] == (entry['old']['sha256'] if entry['old'] else None), 'Invalid backup record')
            if journal['phase'] not in ('preparing', 'rolled_back'):
                require(entry['new'] is not None, 'Missing publication identity')

    def parent_binding(self):
        result = {}
        for name, path in (('config', self.config), ('oci', self.config / 'oci')):
            self.directories(path)
            info = path.lstat()
            result[name] = [info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)]
        require(result['oci'][-1] == 0o700, 'Offline key directory must be mode 0700')
        return result

    def binding(self):
        deploy_id, deploy_raw = self.identity(self.config / 'deploy.env')
        runtime_id, runtime_raw = self.identity(self.config / 'runtime.env')
        _, restore_raw = self.identity(self.config / 'restore.env')
        deploy, runtime, restore = map(env_values, (deploy_raw, runtime_raw, restore_raw))
        target = deploy.get('DEPLOYMENT_TARGET')
        require(target in ('staging', 'production') and deploy.get('API_FQDN') ==
                {'staging': 'staging-api.nourishing.app', 'production': 'api.nourishing.app'}[target], 'Deployment target binding failed')
        require(deploy.get('AZURE_OCI_CREDENTIAL_INSTALL_ADMISSION') == 'BLOCKED_NOT_IMPLEMENTED', 'Credential admission must remain blocked')
        source = runtime.get('SERVICE_VERSION', '')
        require(re.fullmatch('[0-9a-f]{40}', source), 'Invalid configured source commit')
        identity = {key: restore.get(key) for key in ('ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE',
                    'ERASURE_REPLAY_LEDGER_RESTORE_OCI_TENANCY_OCID', 'ERASURE_REPLAY_LEDGER_RESTORE_OCI_USER_OCID',
                    'ERASURE_REPLAY_LEDGER_RESTORE_OCI_PRIVATE_KEY_FILE', 'ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER')}
        require(isinstance(identity['ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE'], str) and
                re.fullmatch('[a-z0-9]{1,63}', identity['ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE']), 'Invalid restore namespace')
        for kind in ('TENANCY', 'USER'):
            require(isinstance(identity[f'ERASURE_REPLAY_LEDGER_RESTORE_OCI_{kind}_OCID'], str) and
                    re.fullmatch(r'ocid1\.' + kind.lower() + r'\.oc1\.\.[a-z0-9]{16,}', identity[f'ERASURE_REPLAY_LEDGER_RESTORE_OCI_{kind}_OCID']), 'Invalid restore principal identity')
        require(identity['ERASURE_REPLAY_LEDGER_RESTORE_OCI_PRIVATE_KEY_FILE'] == '/run/oci/restore-private-key.pem' and
                identity['ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER'] == 'oci_native', 'Invalid offline restore contract')
        return {'deploy.env': deploy_id, 'runtime.env': runtime_id, 'restoreIdentity': identity,
                'target': target, 'source': source}, target, source

    def assert_bound(self, journal):
        require(journal['parents'] == self.parent_binding() and journal['binding'] == self.binding()[0], 'Transaction host/source identity changed')

    def admission(self, new_install=False):
        current = self.scan()
        if current:
            _, journal = current
            require(journal['phase'] in TERMINAL, 'Unfinished credential transaction blocks deployment')
            if new_install:
                current_binding = self.binding()[0]
                require(journal['parents'] == self.parent_binding() and
                        all(journal['binding'][key] == current_binding[key] for key in ('target', 'restoreIdentity')),
                        'Prior transaction target or restore principal changed')
            else:
                self.assert_bound(journal)
            for name, entry in journal['files'].items():
                expected = entry['new'] if journal['phase'] == 'installed' else entry['rollback'] or entry['old']
                require(self.target_identity(name)[0] == expected, 'Credential transaction target changed')

    def install(self, bundle):
        with self.lock():
            self.admission(new_install=True)
            binding, target, source = self.binding()
            require(bundle['deploymentTarget'] == target and bundle['sourceCommit'] == source, 'Bundle target/source mismatch')
            parents = self.parent_binding()
            originals, records, replacements = {}, {}, {}
            for name in TARGETS:
                identity, raw = self.target_identity(name)
                originals[name] = raw
                records[name] = {'old': identity, 'new': None, 'rollback': None,
                                 'backupSha256': identity['sha256'] if identity else None}
                if name in ROLES:
                    values = env_values(raw)
                    require(set(ROLES[name]).issubset(values), 'Missing role environment fields')
                    lines = raw.decode().splitlines(keepends=True)
                    for index, line in enumerate(lines):
                        key = line.partition('=')[0]
                        if key in ROLES[name]:
                            role, field = ROLES[name][key]
                            lines[index] = key + '=' + bundle[role][field] + '\n'
                    replacements[name] = ''.join(lines).encode()
                else:
                    replacements[name] = bundle['restoreApi']['privateKeyPem'].encode()
            self.stopped()
            if not self.root.exists():
                self.root.mkdir(mode=0o700)
                self.fsync_directory(self.config)
            self.private_directory(self.root)
            transaction = uuid.uuid4().hex
            directory = self.root / transaction
            directory.mkdir(mode=0o700)
            self.fsync_directory(self.root)
            journal = {'schemaVersion': 1, 'transaction': transaction, 'phase': 'preparing',
                       'binding': binding, 'parents': parents, 'files': records}
            self.write_json(directory / 'journal.json', journal)
            self.write_json(self.root / 'current.json', {'transaction': transaction})
            self.fault('preparing')
            for index, name in enumerate(TARGETS):
                if originals[name] is not None:
                    self.write_new(directory / f'old-{index}', originals[name])
                key = name == TARGETS[-1]
                self.write_new(directory / f'new-{index}', replacements[name], 0o400 if key else 0o600,
                               self.key_owner if key else self.owner)
                records[name]['new'] = self.identity(directory / f'new-{index}', 0o400 if key else 0o600,
                                                    self.key_owner if key else self.owner)[0]
                self.fault(f'staged-{index}')
            journal['phase'] = 'publishing'
            self.write_json(directory / 'journal.json', journal)
            self.assert_bound(journal)
            for name, entry in records.items():
                require(self.target_identity(name)[0] == entry['old'], 'Credential changed before publication')
            self.stopped()
            self.fault('publishing')
            self.assert_bound(journal)
            for name, entry in records.items():
                require(self.target_identity(name)[0] == entry['old'], 'Credential changed before publication')
            for index, name in enumerate(TARGETS):
                require(self.target_identity(name)[0] == records[name]['old'], 'Credential changed during publication')
                os.replace(directory / f'new-{index}', self.config / name)
                self.fsync_directory((self.config / name).parent)
                self.fsync_directory(directory)
                self.fault(f'published-{index}')
                require(self.target_identity(name)[0] == records[name]['new'], 'Credential publication verification failed')
            self.assert_bound(journal)
            self.stopped()
            for name, entry in records.items():
                require(self.target_identity(name)[0] == entry['new'], 'Credential changed before completion')
            journal['phase'] = 'installed'
            self.write_json(directory / 'journal.json', journal)
            self.fault('installed')
            return {'schemaVersion': 1, 'transaction': transaction, 'result': 'installed-locally', 'hostQualified': False}

    def recover(self):
        with self.lock():
            current = self.scan()
            require(current is not None, 'No credential transaction to recover')
            directory, journal = current
            self.assert_bound(journal)
            phase = journal['phase']
            originals = {}
            for index, name in enumerate(TARGETS):
                entry = journal['files'][name]
                actual = self.target_identity(name)[0]
                allowed = [entry['old']]
                if phase != 'preparing':
                    allowed += [entry['new'], entry['rollback']]
                if entry['old'] is not None:
                    allowed = [identity for identity in allowed if identity is not None]
                require(actual in allowed, 'Foreign credential change blocks recovery')
                if phase not in ('preparing', 'rolled_back') and entry['old']:
                    _, raw = self.identity(directory / f'old-{index}')
                    require(hashlib.sha256(raw).hexdigest() == entry['backupSha256'], 'Rollback copy changed')
                    originals[name] = raw
            self.stopped()
            if phase == 'rolled_back':
                self.admission()
                return {'result': 'already-rolled-back', 'hostQualified': False}
            if phase == 'preparing':
                # No publication can occur before a durable publishing journal.
                journal['phase'] = 'rolled_back'
                # Records require new identities after preparing; retain originals as
                # the unused publication identity for this prepublication rollback.
                for entry in journal['files'].values():
                    entry['new'] = entry['old']
                self.write_json(directory / 'journal.json', journal)
                return {'result': 'rolled-back-before-publication', 'hostQualified': False}
            for index, name in enumerate(TARGETS):
                entry = journal['files'][name]
                if entry['old'] is None or entry['rollback'] is not None:
                    continue
                key = name == TARGETS[-1]
                stage = directory / f'rollback-{index}'
                # An unjournaled partial rollback stage requires manual review.
                self.write_new(stage, originals[name], 0o400 if key else 0o600,
                               self.key_owner if key else self.owner)
                entry['rollback'] = self.identity(stage, 0o400 if key else 0o600,
                                                   self.key_owner if key else self.owner)[0]
                journal['phase'] = 'rolling_back'
                self.write_json(directory / 'journal.json', journal)
                self.fault(f'rollback-staged-{index}')
            journal['phase'] = 'rolling_back'
            self.write_json(directory / 'journal.json', journal)
            self.assert_bound(journal)
            self.stopped()
            self.fault('rollback-ready')
            self.assert_bound(journal)
            # Validate every target and every needed staged rollback before
            # replacing the first target, including a resumed rollback.
            for index, name in enumerate(TARGETS):
                entry = journal['files'][name]
                actual = self.target_identity(name)[0]
                permitted = [item for item in (entry['old'], entry['new'], entry['rollback'])
                             if item is not None or entry['old'] is None]
                require(actual in permitted, 'Foreign credential change blocks recovery')
                if entry['old'] and actual != entry['rollback']:
                    require(self.identity(directory / f'rollback-{index}', entry['rollback']['mode'],
                                          entry['rollback']['uid'])[0] == entry['rollback'], 'Rollback stage changed')
            for index, name in enumerate(TARGETS):
                entry = journal['files'][name]
                actual = self.target_identity(name)[0]
                permitted = [item for item in (entry['old'], entry['new'], entry['rollback'])
                             if item is not None or entry['old'] is None]
                require(actual in permitted, 'Foreign credential change during recovery')
                expected = entry['rollback'] or entry['old']
                if actual != expected:
                    if entry['old'] is None:
                        (self.config / name).unlink()
                    else:
                        stage = directory / f'rollback-{index}'
                        require(self.identity(stage, entry['rollback']['mode'], entry['rollback']['uid'])[0] == entry['rollback'], 'Rollback stage changed')
                        os.replace(stage, self.config / name)
                    self.fsync_directory((self.config / name).parent)
                    self.fsync_directory(directory)
                self.fault(f'rolled-back-{index}')
                require(self.target_identity(name)[0] == expected, 'Rollback verification failed')
            self.assert_bound(journal)
            self.stopped()
            for name, entry in journal['files'].items():
                require(self.target_identity(name)[0] == (entry['rollback'] or entry['old']),
                        'Credential changed before recovery completion')
            journal['phase'] = 'rolled_back'
            self.write_json(directory / 'journal.json', journal)
            return {'result': 'rolled-back', 'hostQualified': False}


@contextlib.contextmanager
def deployment_guard():
    transaction = Transaction()
    with transaction.lock():
        transaction.admission()
        yield


@contextlib.contextmanager
def termination_scope():
    signals = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)
    previous = {number: signal.getsignal(number) for number in signals}
    def cancel(_number, _frame):
        # Repeated cancellation must not interrupt child kill/reap or lock release.
        for number in signals:
            signal.signal(number, signal.SIG_IGN)
        raise CredentialError('Credential transaction cancelled; preserve private evidence')
    try:
        for number in signals:
            signal.signal(number, cancel)
        yield
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def main():
    require(os.geteuid() == 0, 'Credential installation requires root')
    require(sys.argv[1:] in (['install'], ['recover']), 'Usage: install-object-storage-credentials.py install|recover')
    with termination_scope():
        transaction = Transaction()
        if sys.argv[1] == 'install':
            raw = bytearray()
            deadline = time.monotonic() + 30
            while len(raw) <= LIMIT:
                remaining = deadline - time.monotonic()
                require(remaining > 0 and select.select([sys.stdin.fileno()], [], [], remaining)[0], 'Credential input timed out')
                chunk = os.read(sys.stdin.fileno(), min(8192, LIMIT + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
            bundle = validate_bundle(bytes(raw))
            result = transaction.install(bundle)
        else:
            result = transaction.recover()
        print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except CredentialError as error:
        print(f'BLOCKED: {error}', file=sys.stderr)
        raise SystemExit(1) from None
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        print('BLOCKED: credential transaction could not complete; preserve private evidence', file=sys.stderr)
        raise SystemExit(1) from None
