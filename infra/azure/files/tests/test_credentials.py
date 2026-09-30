#!/usr/bin/env python3
"""Real temporary-file transactions; no Docker, cloud or operational credentials."""

import copy
import base64
import contextlib
import hashlib
import importlib.util
import json
import os
import signal
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'install-object-storage-credentials.py'
spec = importlib.util.spec_from_file_location('azure_credentials', MODULE)
credentials = importlib.util.module_from_spec(spec)
spec.loader.exec_module(credentials)
SOURCE = 'a' * 40


class Interrupted(BaseException):
    pass


class CredentialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Ephemeral synthetic test material remains in memory and private files.
        cls.pem = credentials.bounded_child(['/usr/bin/openssl', 'genpkey', '-algorithm', 'RSA',
                                             '-pkeyopt', 'rsa_keygen_bits:2048'], cap=16384).decode()
        cls.der = credentials.bounded_child(['/usr/bin/openssl', 'pkey', '-pubout', '-outform', 'DER'], cls.pem.encode())
        cls.fingerprint = ':'.join(f'{byte:02x}' for byte in hashlib.md5(cls.der, usedforsecurity=False).digest())

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nourishing-credential-test-', dir=Path.home())
        self.addCleanup(self.temporary.cleanup)
        self.config = Path(self.temporary.name) / 'config'
        self.config.mkdir(mode=0o700)
        (self.config / 'oci').mkdir(mode=0o700)
        self.stopped_calls = []
        self.transaction = self.make_transaction()
        self.write('deploy.env', 'DEPLOYMENT_TARGET=staging\nAPI_FQDN=staging-api.nourishing.app\nAZURE_OCI_CREDENTIAL_INSTALL_ADMISSION=BLOCKED_NOT_IMPLEMENTED\n')
        self.write('runtime.env', f'SERVICE_VERSION={SOURCE}\nBETA_DATA_CLASSIFICATION=synthetic-only\n')
        for name, mappings in credentials.ROLES.items():
            self.write(name, '# preserved comment\nUNRELATED_VALUE={"unchanged":"literal"}\n' +
                       ''.join(f'{field}=old-{field}\n' for field in mappings))
        with (self.config / 'restore.env').open('a') as stream:
            stream.write('ERASURE_REPLAY_LEDGER_RESTORE_OCI_NAMESPACE=testnamespace\n'
                         'ERASURE_REPLAY_LEDGER_RESTORE_OCI_TENANCY_OCID=ocid1.tenancy.oc1..abcdefghijklmnop\n'
                         'ERASURE_REPLAY_LEDGER_RESTORE_OCI_USER_OCID=ocid1.user.oc1..abcdefghijklmnop\n'
                         'ERASURE_REPLAY_LEDGER_RESTORE_OCI_PRIVATE_KEY_FILE=/run/oci/restore-private-key.pem\n'
                         'ERASURE_REPLAY_LEDGER_RESTORE_VERSION_LIST_PROVIDER=oci_native\n')
        self.originals = {name: (self.config / name).read_bytes() for name in credentials.ROLES}
        self.bundle = {'schemaVersion': 1, 'deploymentTarget': 'staging', 'sourceCommit': SOURCE,
                       'restoreApi': {'privateKeyPem': self.pem, 'fingerprint': self.fingerprint}}
        for index, role in enumerate(('exportReader', 'exportWriter', 'ledgerWriter', 'ledgerRestore')):
            self.bundle[role] = {'accessKeyId': f'{index}' + 'A' * 31, 'secretAccessKey': f'{index}' + 'S' * 63}

    def make_transaction(self, fault=lambda _: None, stopped=None):
        return credentials.Transaction(self.config, os.getuid(), os.getgid(),
                                       stopped or (lambda: self.stopped_calls.append(True)), fault)

    def write(self, name, data, mode=0o600):
        path = self.config / name
        if path.exists():
            path.chmod(0o600)
        path.write_bytes(data.encode() if isinstance(data, str) else data)
        path.chmod(mode)

    def validate(self, bundle=None):
        return credentials.validate_bundle(json.dumps(bundle or self.bundle).encode())

    def installed(self):
        return self.transaction.install(self.validate())

    def crash(self, boundary):
        def stop_at(label):
            if label == boundary:
                raise Interrupted()
        with self.assertRaises(Interrupted):
            self.make_transaction(stop_at).install(self.validate())

    def assert_original(self):
        for name, original in self.originals.items():
            self.assertEqual((self.config / name).read_bytes(), original)
        self.assertFalse((self.config / credentials.TARGETS[-1]).exists())

    def test_install_real_files_and_retained_private_receipt(self):
        result = self.installed()
        self.assertFalse(result['hostQualified'])
        self.assertEqual(result['result'], 'installed-locally')
        self.assertEqual(len(self.stopped_calls), 3)
        self.transaction.admission()
        directory, journal = self.transaction.scan()
        self.assertEqual(journal['phase'], 'installed')
        self.assertEqual((self.config / credentials.TARGETS[-1]).read_text(), self.pem)
        for index, name in enumerate(credentials.ROLES):
            raw = (self.config / name).read_text()
            self.assertTrue(raw.startswith('# preserved comment\nUNRELATED_VALUE={"unchanged":"literal"}\n'))
            self.assertEqual((directory / f'old-{index}').read_bytes(), self.originals[name])
            self.assertEqual(stat.S_IMODE((self.config / name).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.config / credentials.TARGETS[-1]).stat().st_mode), 0o400)
        self.assertEqual(stat.S_IMODE((directory / 'journal.json').stat().st_mode), 0o600)
        serialized = (directory / 'journal.json').read_text()
        self.assertNotIn('PRIVATE KEY', serialized)
        self.assertNotIn(self.bundle['exportReader']['secretAccessKey'], serialized)
        self.assertFalse((self.config / 'credential-install-admitted').exists())

    def test_rotation_keeps_old_transaction_and_recovers_previous_set(self):
        first = self.installed()
        prior = {name: (self.config / name).read_bytes() for name in credentials.TARGETS}
        for role in ('exportReader', 'exportWriter', 'ledgerWriter', 'ledgerRestore'):
            self.bundle[role]['secretAccessKey'] += 'X'
        second = self.installed()
        self.assertNotEqual(first['transaction'], second['transaction'])
        self.assertTrue((self.transaction.root / first['transaction'] / 'journal.json').exists())
        self.transaction.recover()
        self.transaction.admission()
        for name, raw in prior.items():
            self.assertEqual((self.config / name).read_bytes(), raw)

    def test_new_source_requires_explicit_new_bound_transaction(self):
        self.installed()
        self.write('runtime.env', f'SERVICE_VERSION={"b" * 40}\nBETA_DATA_CLASSIFICATION=synthetic-only\n')
        with self.assertRaises(credentials.CredentialError):
            self.transaction.admission()
        with self.assertRaises(credentials.CredentialError):
            self.transaction.recover()
        self.bundle['sourceCommit'] = 'b' * 40
        self.installed()
        self.transaction.admission()

    def test_new_install_cannot_reuse_host_for_another_target(self):
        self.installed()
        self.write('deploy.env', 'DEPLOYMENT_TARGET=production\nAPI_FQDN=api.nourishing.app\nAZURE_OCI_CREDENTIAL_INSTALL_ADMISSION=BLOCKED_NOT_IMPLEMENTED\n')
        self.bundle['deploymentTarget'] = 'production'
        with self.assertRaises(credentials.CredentialError):
            self.installed()

    def test_every_install_publication_boundary_blocks_then_recovers(self):
        for boundary in ('preparing', 'staged-0', 'staged-1', 'staged-2', 'staged-3', 'publishing',
                         'published-0', 'published-1', 'published-2', 'published-3'):
            with self.subTest(boundary=boundary):
                self.tearDown()
                self.setUp()
                self.crash(boundary)
                with self.assertRaises(credentials.CredentialError):
                    self.transaction.admission()
                self.transaction.recover()
                self.assert_original()
                self.transaction.admission()
                self.assertEqual(self.transaction.recover()['result'], 'already-rolled-back')

    def test_recovery_restarts_at_every_durable_boundary(self):
        for boundary in ('rollback-staged-0', 'rollback-staged-1', 'rollback-staged-2',
                         'rolled-back-0', 'rolled-back-1', 'rolled-back-2', 'rolled-back-3'):
            with self.subTest(boundary=boundary):
                self.tearDown()
                self.setUp()
                self.installed()
                def stop_at(label):
                    if label == boundary:
                        raise Interrupted()
                with self.assertRaises(Interrupted):
                    self.make_transaction(stop_at).recover()
                with self.assertRaises(credentials.CredentialError):
                    self.transaction.admission()
                self.transaction.recover()
                self.assert_original()
                self.transaction.admission()

    def test_real_process_death_after_first_publication(self):
        # Child uses only inherited synthetic files/data and a mocked stopped probe.
        pid = os.fork()
        if pid == 0:
            def die(label):
                if label == 'published-0':
                    os._exit(73)
            self.make_transaction(die).install(self.bundle)
            os._exit(74)
        _, status = os.waitpid(pid, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 73)
        with self.assertRaises(credentials.CredentialError):
            self.transaction.admission()
        self.transaction.recover()
        self.assert_original()

    def test_foreign_edit_last_target_prevents_any_rollback(self):
        self.installed()
        self.write(credentials.TARGETS[-1], 'foreign material', 0o400)
        before = {name: (self.config / name).read_bytes() for name in credentials.TARGETS}
        with self.assertRaises(credentials.CredentialError):
            self.transaction.recover()
        self.assertEqual(before, {name: (self.config / name).read_bytes() for name in credentials.TARGETS})
        self.assertEqual(self.transaction.scan()[1]['phase'], 'installed')

    def test_foreign_edit_after_rollback_staging_preserves_all_targets(self):
        self.installed()
        before = {name: (self.config / name).read_bytes() for name in credentials.ROLES}
        def change(label):
            if label == 'rollback-ready':
                self.write(credentials.TARGETS[-1], 'foreign material', 0o400)
        with self.assertRaises(credentials.CredentialError):
            self.make_transaction(change).recover()
        self.assertEqual(before, {name: (self.config / name).read_bytes() for name in credentials.ROLES})
        self.assertEqual((self.config / credentials.TARGETS[-1]).read_text(), 'foreign material')

    def test_foreign_edit_immediately_before_install_is_not_overwritten(self):
        def change(label):
            if label == 'publishing':
                self.write('restore.env', 'FOREIGN_VALUE=retained\n')
        with self.assertRaises(credentials.CredentialError):
            self.make_transaction(change).install(self.validate())
        self.assertEqual((self.config / 'api.env').read_bytes(), self.originals['api.env'])
        self.assertEqual((self.config / 'restore.env').read_text(), 'FOREIGN_VALUE=retained\n')

    def test_later_foreign_edit_after_first_publication_is_not_overwritten(self):
        def change(label):
            if label == 'published-0':
                self.write('worker.env', 'FOREIGN_VALUE=retained\n')
        with self.assertRaises(credentials.CredentialError):
            self.make_transaction(change).install(self.validate())
        self.assertEqual((self.config / 'worker.env').read_text(), 'FOREIGN_VALUE=retained\n')
        self.assertEqual((self.config / 'restore.env').read_bytes(), self.originals['restore.env'])
        self.assertEqual(self.transaction.scan()[1]['phase'], 'publishing')

    def test_directory_fsync_failure_after_rename_then_separate_recovery(self):
        original_sync = self.transaction.fsync_directory
        failed = []
        def sync(path):
            if not failed and path == self.config and (self.config / 'api.env').read_bytes() != self.originals['api.env']:
                failed.append(True)
                raise OSError('Synthetic directory fsync failure')
            original_sync(path)
        with patch.object(self.transaction, 'fsync_directory', side_effect=sync), self.assertRaises(OSError):
            self.installed()
        self.assertTrue(failed)
        self.assertEqual(self.transaction.scan()[1]['phase'], 'publishing')
        separate = self.make_transaction()
        separate.recover()
        self.assert_original()

    def test_corrupted_later_rollback_stage_blocks_all_restoration(self):
        self.installed()
        def stop(label):
            if label == 'rollback-staged-2':
                raise Interrupted()
        with self.assertRaises(Interrupted):
            self.make_transaction(stop).recover()
        directory, _ = self.transaction.scan()
        (directory / 'rollback-2').write_bytes(b'foreign')
        before = {name: (self.config / name).read_bytes() for name in credentials.TARGETS}
        with self.assertRaises(credentials.CredentialError):
            self.transaction.recover()
        self.assertEqual(before, {name: (self.config / name).read_bytes() for name in credentials.TARGETS})

    def test_same_bytes_foreign_inode_blocks_recovery(self):
        self.installed()
        path = self.config / 'api.env'
        raw = path.read_bytes()
        replacement = self.config / 'replacement'
        replacement.write_bytes(raw)
        replacement.chmod(0o600)
        os.replace(replacement, path)
        with self.assertRaises(credentials.CredentialError):
            self.transaction.recover()

    def test_changed_backup_blocks_before_any_target_overwrite(self):
        self.installed()
        directory, _ = self.transaction.scan()
        (directory / 'old-2').write_bytes(b'foreign')
        before = {name: (self.config / name).read_bytes() for name in credentials.TARGETS}
        with self.assertRaises(credentials.CredentialError):
            self.transaction.recover()
        self.assertEqual(before, {name: (self.config / name).read_bytes() for name in credentials.TARGETS})

    def test_source_or_parent_identity_change_blocks_recovery(self):
        self.installed()
        self.write('runtime.env', f'SERVICE_VERSION={"b" * 40}\n')
        with self.assertRaises(credentials.CredentialError):
            self.transaction.recover()

    def test_parent_inode_change_blocks_recovery(self):
        self.installed()
        os.rename(self.config / 'oci', self.config / 'old-oci')
        (self.config / 'oci').mkdir(mode=0o700)
        os.rename(self.config / 'old-oci/restore-private-key.pem', self.config / credentials.TARGETS[-1])
        with self.assertRaises(credentials.CredentialError):
            self.transaction.recover()

    def test_foreign_mode_and_hardlink_and_symlink_fail_closed(self):
        path = self.config / 'api.env'
        path.chmod(0o644)
        with self.assertRaises(credentials.CredentialError):
            self.installed()
        path.chmod(0o600)
        os.link(path, self.config / 'linked')
        with self.assertRaises(credentials.CredentialError):
            self.installed()
        (self.config / 'linked').unlink()
        path.rename(self.config / 'original-api')
        path.symlink_to(self.config / 'original-api')
        with self.assertRaises((credentials.CredentialError, OSError)):
            self.installed()
        self.assertFalse(self.transaction.root.exists())

    def test_world_writable_parent_rejected(self):
        self.config.chmod(0o777)
        with self.assertRaises(credentials.CredentialError):
            self.installed()

    def test_key_directory_symlink_rejected(self):
        (self.config / 'oci').rename(self.config / 'real-oci')
        (self.config / 'oci').symlink_to(self.config / 'real-oci', target_is_directory=True)
        with self.assertRaises(credentials.CredentialError):
            self.installed()

    def test_lock_contender_cannot_begin(self):
        with self.transaction.lock():
            with self.assertRaises(credentials.CredentialError):
                with self.make_transaction().lock():
                    self.fail('Second lock acquired')
        self.assertFalse(self.transaction.root.exists())

    def test_failure_before_publication_preserves_originals(self):
        self.crash('publishing')
        self.assert_original()

    def test_unknown_stopped_state_never_creates_journal(self):
        def denied():
            raise credentials.CredentialError('Synthetic probe failed')
        with self.assertRaises(credentials.CredentialError):
            self.make_transaction(stopped=denied).install(self.bundle)
        self.assert_original()
        self.assertFalse(self.transaction.root.exists())

    def test_stopped_state_rechecked_before_publication_and_completion(self):
        for failure_call in (2, 3):
            with self.subTest(failure_call=failure_call):
                self.tearDown()
                self.setUp()
                calls = []
                def check():
                    calls.append(True)
                    if len(calls) == failure_call:
                        raise credentials.CredentialError('Synthetic running project')
                with self.assertRaises(credentials.CredentialError):
                    self.make_transaction(stopped=check).install(self.bundle)
                self.assertEqual(self.transaction.scan()[1]['phase'], 'publishing')
                with self.assertRaises(credentials.CredentialError):
                    self.transaction.admission()
                self.transaction.recover()
                self.assert_original()

    def test_malformed_journal_cannot_claim_installed(self):
        self.crash('published-0')
        directory, _ = self.transaction.scan()
        (directory / 'journal.json').write_bytes(b'{"phase":"installed"}')
        for action in (self.transaction.admission, self.transaction.recover):
            with self.assertRaises(credentials.CredentialError):
                action()
        self.assertTrue((directory / 'old-0').exists())

    def test_partial_transaction_directory_preserved_and_blocked(self):
        self.transaction.root.mkdir(mode=0o700)
        orphan = self.transaction.root / ('d' * 32)
        orphan.mkdir(mode=0o700)
        for action in (self.transaction.admission, self.transaction.recover):
            with self.assertRaises(credentials.CredentialError):
                action()
        self.assertTrue(orphan.exists())

    def test_unjournaled_recovery_stage_stops_without_overwrite(self):
        self.installed()
        directory, _ = self.transaction.scan()
        self.transaction.write_new(directory / 'rollback-0', b'unknown')
        before = (self.config / 'api.env').read_bytes()
        with self.assertRaises(FileExistsError):
            self.transaction.recover()
        self.assertEqual((self.config / 'api.env').read_bytes(), before)

    def test_wrong_bundle_target_source_or_config_origin_rejected(self):
        for key, value in (('deploymentTarget', 'production'), ('sourceCommit', 'b' * 40)):
            changed = copy.deepcopy(self.bundle)
            changed[key] = value
            with self.assertRaises(credentials.CredentialError):
                self.transaction.install(changed)
        self.write('deploy.env', 'DEPLOYMENT_TARGET=staging\nAPI_FQDN=api.nourishing.app\nAZURE_OCI_CREDENTIAL_INSTALL_ADMISSION=BLOCKED_NOT_IMPLEMENTED\n')
        with self.assertRaises(credentials.CredentialError):
            self.installed()

    def test_unsafe_input_and_repeated_roles_rejected(self):
        for value in ('$BAD', '"quoted"', "'quoted'", r'back\slash', 'white space', 'line\nline', 'short'):
            changed = copy.deepcopy(self.bundle)
            changed['exportReader']['secretAccessKey'] = 'S' * 32 + value if value != 'short' else value
            with self.subTest(value=value), self.assertRaises(credentials.CredentialError):
                self.validate(changed)
        changed = copy.deepcopy(self.bundle)
        changed['exportReader'] = changed['exportWriter']
        with self.assertRaises(credentials.CredentialError):
            self.validate(changed)

    def test_json_duplicate_unknown_oversized_and_nonobject_rejected(self):
        for raw in (b'[]', b'null', b'{"schemaVersion":1,"schemaVersion":1}', b'{' + b'A' * 65536, b'{"x":NaN}', b'{"secret":"DO_NOT_ECHO",'):
            with self.assertRaises(credentials.CredentialError) as raised:
                credentials.validate_bundle(raw)
            self.assertNotIn('DO_NOT_ECHO', str(raised.exception))
        changed = copy.deepcopy(self.bundle)
        changed['path'] = '/operator/selected'
        with self.assertRaises(credentials.CredentialError):
            self.validate(changed)

    def test_real_rsa_fingerprint_valid_and_mismatch_rejected(self):
        self.validate()
        with self.assertRaises(credentials.CredentialError):
            credentials.validate_key(self.pem, '00:' * 15 + '00')

    def test_reject_ec_and_multiple_private_keys(self):
        ec = credentials.bounded_child(['/usr/bin/openssl', 'genpkey', '-algorithm', 'EC',
                                        '-pkeyopt', 'ec_paramgen_curve:P-256'], cap=16384).decode()
        for pem in (ec, self.pem + self.pem, self.pem + 'trailing', self.pem.replace('PRIVATE KEY', 'ENCRYPTED PRIVATE KEY')):
            with self.assertRaises(credentials.CredentialError):
                credentials.validate_key(pem, self.fingerprint)

    def test_reject_inconsistent_rsa_and_embedded_trailing_der(self):
        raw = base64.b64decode(''.join(self.pem.splitlines()[1:-1]))
        inconsistent = raw[:-1] + bytes([raw[-1] ^ 1])
        for der in (inconsistent, raw + b'\x05\x00'):
            pem = '-----BEGIN PRIVATE KEY-----\n' + base64.b64encode(der).decode() + '\n-----END PRIVATE KEY-----\n'
            with self.assertRaises(credentials.CredentialError):
                credentials.validate_key(pem, self.fingerprint)

    def test_reject_weak_rsa(self):
        pem = credentials.bounded_child(['/usr/bin/openssl', 'genpkey', '-algorithm', 'RSA',
                                         '-pkeyopt', 'rsa_keygen_bits:1024'], cap=16384).decode()
        with self.assertRaises(credentials.CredentialError):
            credentials.validate_key(pem, self.fingerprint)

    def test_cli_rejects_nonroot_and_unknown_arguments_before_probes(self):
        for uid, arguments in ((1000, ['install']), (0, ['install', '/arbitrary/path']), (0, ['unknown'])):
            with patch.object(credentials.os, 'geteuid', return_value=uid), patch.object(sys, 'argv', ['helper'] + arguments), \
                    patch.object(credentials, 'Transaction') as transaction, patch.object(credentials, 'validate_bundle') as validation:
                with self.assertRaises(credentials.CredentialError):
                    credentials.main()
                transaction.assert_not_called()
                validation.assert_not_called()

    def test_preflight_pending_transaction_precedes_children_and_shares_lock(self):
        preflight_path = MODULE.with_name('deployment-preflight.py')
        spec = importlib.util.spec_from_file_location('credential_preflight_test', preflight_path)
        preflight = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(preflight)
        self.assertEqual(preflight.CREDENTIAL_INSTALLER_SHA256, hashlib.sha256(MODULE.read_bytes()).hexdigest())
        @contextlib.contextmanager
        def real_guard():
            with self.transaction.lock():
                self.transaction.admission()
                yield
        self.crash('published-0')
        with patch.object(preflight, 'credential_transaction_guard', real_guard), \
                patch.object(preflight, '_run_preflight_locked') as children:
            with self.assertRaises(credentials.CredentialError):
                preflight.run_preflight('full', None)
            children.assert_not_called()
        self.transaction.recover()
        def check_locked(*_):
            with self.assertRaises(credentials.CredentialError):
                with self.make_transaction().lock():
                    self.fail('Preflight released the transaction lock early')
        with patch.object(preflight, 'credential_transaction_guard', real_guard), \
                patch.object(preflight, '_run_preflight_locked', side_effect=check_locked) as children:
            preflight.run_preflight('full', None)
            children.assert_called_once()
        with self.assertRaises(SystemExit):
            preflight.reject_unimplemented_integrations({key: 'BLOCKED_NOT_IMPLEMENTED' for key in
                ('AZURE_OCI_EGRESS_ADMISSION', 'AZURE_OCI_CREDENTIAL_INSTALL_ADMISSION',
                 'AZURE_OCI_USAGE_ADMISSION', 'AZURE_OFF_HOST_BACKUP_ADMISSION')})

    def test_bounded_child_timeout_and_output_cap(self):
        with self.assertRaises(credentials.CredentialError):
            credentials.bounded_child([sys.executable, '-c', 'import time; time.sleep(10)'], timeout=.1)
        with self.assertRaises(credentials.CredentialError):
            credentials.bounded_child([sys.executable, '-c', 'print("x"*10000)'], cap=128)

    def test_cancellation_reaps_owned_child_and_restores_handlers(self):
        children = []
        original_popen = subprocess.Popen
        previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
        previous_alarm = signal.signal(signal.SIGALRM, lambda *_: os.kill(os.getpid(), signal.SIGTERM))
        def spawn(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            children.append(process)
            signal.setitimer(signal.ITIMER_REAL, .05)
            return process
        try:
            with patch.object(credentials.subprocess, 'Popen', side_effect=spawn), self.assertRaises(credentials.CredentialError):
                with credentials.termination_scope():
                    try:
                        credentials.bounded_child([sys.executable, '-c', 'import time; time.sleep(10)'])
                    except credentials.CredentialError:
                        # A second cancellation during unwinding is ignored.
                        os.kill(os.getpid(), signal.SIGTERM)
                        raise
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_alarm)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].returncode)
        self.assertEqual(previous, {number: signal.getsignal(number) for number in previous})

    def test_spawn_boundary_cancellation_defers_until_child_is_owned(self):
        original_popen = subprocess.Popen
        previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, [])
        for number in previous:
            children = []
            def spawn(*args, **kwargs):
                self.assertNotIn('preexec_fn', kwargs)
                self.assertEqual(signal.pthread_sigmask(signal.SIG_BLOCK, []), previous_mask)
                process = original_popen(*args, **kwargs)
                children.append(process)
                # Exact gap: OS child exists, but bounded_child has no handle yet.
                os.kill(os.getpid(), number)
                self.assertIsNone(process.poll())
                return process
            with self.subTest(signal=number), patch.object(credentials.subprocess, 'Popen', side_effect=spawn), \
                    self.assertRaises(credentials.CredentialError):
                with credentials.termination_scope():
                    credentials.bounded_child([sys.executable, '-c', 'import time; time.sleep(10)'])
            self.assertEqual(len(children), 1)
            self.assertIsNotNone(children[0].returncode)
            self.assertEqual(previous, {item: signal.getsignal(item) for item in previous})
            self.assertEqual(signal.pthread_sigmask(signal.SIG_BLOCK, []), previous_mask)

    def test_spawn_failure_restores_original_signal_handlers(self):
        previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
        with patch.object(credentials.subprocess, 'Popen', side_effect=OSError('Synthetic spawn failure')), \
                self.assertRaises(credentials.CredentialError):
            credentials.bounded_child(['/fixed/synthetic/probe'])
        self.assertEqual(previous, {item: signal.getsignal(item) for item in previous})

    def test_first_cancellation_during_cleanup_finishes_child_reaping(self):
        original_popen, original_killpg = subprocess.Popen, os.killpg
        previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
        children, delivered = [], []
        def spawn(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            children.append(process)
            return process
        def cleanup(group, number):
            if not delivered:
                delivered.append(True)
                # First cancellation arrives only after bounded_child entered finally.
                os.kill(os.getpid(), signal.SIGTERM)
            return original_killpg(group, number)
        with patch.object(credentials.subprocess, 'Popen', side_effect=spawn), \
                patch.object(credentials.os, 'killpg', side_effect=cleanup), self.assertRaises(credentials.CredentialError):
            with credentials.termination_scope():
                credentials.bounded_child([sys.executable, '-c', 'import time; time.sleep(10)'], timeout=.05)
        self.assertEqual(delivered, [True])
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].returncode)
        self.assertTrue(children[0].stdin.closed and children[0].stdout.closed)
        self.assertEqual(previous, {item: signal.getsignal(item) for item in previous})

    def test_docker_entire_exact_project_and_unknown_states(self):
        base = {'ID': 'f' * 64, 'Labels': f'com.docker.compose.project={credentials.PROJECT},com.docker.compose.service=offline-restore', 'State': 'exited'}
        for state in ('running', 'paused', 'restarting', 'removing', 'dead', 'unknown', None):
            row = {**base, 'State': state}
            with patch.object(credentials, 'bounded_child', return_value=json.dumps(row).encode()), self.assertRaises(credentials.CredentialError):
                credentials.assert_stopped()
        with patch.object(credentials, 'bounded_child', return_value=json.dumps(base).encode()) as probe:
            credentials.assert_stopped()
            command = probe.call_args.args[0]
            self.assertIn('--all', command)
            self.assertIn(f'label=com.docker.compose.project={credentials.PROJECT}', command)
            self.assertFalse(any('service=' in argument for argument in command))
        for raw in (b'', json.dumps({**base, 'State': 'created'}).encode()):
            with patch.object(credentials, 'bounded_child', return_value=raw):
                credentials.assert_stopped()
        for raw in (b'[]', b'{', json.dumps({**base, 'Labels': 'com.docker.compose.project=other'}).encode(),
                    (json.dumps(base) + '\n' + json.dumps(base)).encode()):
            with patch.object(credentials, 'bounded_child', return_value=raw), self.assertRaises(credentials.CredentialError):
                credentials.assert_stopped()


if __name__ == '__main__':
    unittest.main(verbosity=2)
