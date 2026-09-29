"""Synthetic offline tests of the actual draft functions, never its CLI or services."""
import ast
import contextlib
import hashlib
import io
import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest import mock

DRAFT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DRAFT))
TREE = ast.parse((DRAFT / 'ci-run.py').read_text())
INERT = ast.Module(body=[item for item in TREE.body if isinstance(item, (ast.Import, ast.ImportFrom, ast.Assign, ast.FunctionDef))], type_ignores=[])
ENTRY = ast.Module(body=[TREE.body[-1]], type_ignores=[])
SHA = 'a' * 40
BUILD_COMMAND = ('pnpm', 'exec', 'turbo', 'run', 'build',
                 '--filter=@nutrition-tracker/web...', '--filter=@nutrition-tracker/api...',
                 '--filter=@nutrition-tracker/worker...', '--force')
OUTPUT_ROOTS = ('apps/api/dist', 'apps/worker/dist', 'packages/artifact-store/dist',
                'packages/contracts/dist', 'packages/db/dist', 'packages/domain/dist',
                'packages/search/dist', 'apps/web/.next/standalone', 'apps/web/.next/static')
CHECKS = ['authenticated-session-persistence', 'real-search-and-single-add', 'saved-diary-entry-after-reload', 'report-agrees-with-saved-day', 'narrow-diary-remains-usable']

class DraftTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='nourishing-browser-draft-tests-')
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.private = self.path / 'private'
        self.private.mkdir()
        self.root = self.path / 'repo'
        self.root.mkdir()
        self.ns = {'__file__': str(DRAFT / 'ci-run.py')}
        exec(compile(INERT, str(DRAFT / 'ci-run.py'), 'exec'), self.ns)
        self.ns.update(ROOT=self.root, PRIVATE=self.private)
        self.cfg = json.loads((DRAFT / 'project.json').read_text())
        self.cfg['localBinary']['binarySha256'] = hashlib.sha256(b'synthetic binary').hexdigest()
        self.ns['CFG'] = self.cfg
        (self.private / 'BrowserStackLocal').write_bytes(b'synthetic binary')
        self.env = mock.patch.dict(os.environ, {'GITHUB_SHA': SHA, 'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_ARCH': 'ARM64', 'GITHUB_REPOSITORY': 'liangzixuan/cronometer-gold', 'GITHUB_REF': 'refs/heads/codex/retention-features', 'GITHUB_EVENT_NAME': 'push', 'RUNNER_TEMP': str(self.path), 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.write('browser-input.json', {'localIdentifier': 'nourishing-123-1'})

    def write(self, name, value):
        (self.private / name).write_text(json.dumps(value))

    def trusted_entry(self, override=None):
        calls = []
        self.ns.update(ACTION='prepare', CONFIG=DRAFT / 'project.json', prepare=lambda: calls.append('prepare'))
        with mock.patch.dict(os.environ, override or {}), mock.patch.object(self.ns['platform'], 'machine', return_value='aarch64'), mock.patch.object(self.ns['os'], 'getuid', return_value=1000), contextlib.redirect_stderr(io.StringIO()):
            exec(compile(ENTRY, str(DRAFT / 'ci-run.py'), 'exec'), self.ns)
        return calls

    def source_fixture(self):
        files = {'pnpm-lock.yaml': b'lockfileVersion: 9\n', 'apps/example.ts': b'export const value = 1;\n'}
        for name, value in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
            path.chmod(0o644)
        self.ns['git'] = mock.Mock(side_effect=lambda *args: {('status', '--porcelain'): '', ('rev-parse', 'HEAD'): SHA, ('rev-parse', 'HEAD^{tree}'): 'b' * 40}[args])
        return files

    def test_trusted_context_dispatches_only_mocked_prepare(self):
        self.assertEqual(self.trusted_entry(), ['prepare'])

    def test_rejects_foreign_repository_before_dispatch(self):
        with self.assertRaises(SystemExit): self.trusted_entry({'GITHUB_REPOSITORY': 'foreign/repo'})

    def test_rejects_untrusted_ref_before_dispatch(self):
        with self.assertRaises(SystemExit): self.trusted_entry({'GITHUB_REF': 'refs/pull/4/merge'})

    def test_rejects_self_hosted_runner(self):
        with self.assertRaises(SystemExit): self.trusted_entry({'RUNNER_ENVIRONMENT': 'self-hosted'})

    def test_rejects_non_actions_context(self):
        with self.assertRaises(SystemExit): self.trusted_entry({'GITHUB_ACTIONS': 'false'})

    def test_rejects_untrusted_event_even_on_the_right_branch(self):
        with self.assertRaises(SystemExit): self.trusted_entry({'GITHUB_EVENT_NAME': 'pull_request_target'})

    def test_missing_credentials_never_starts_tunnel(self):
        call = self.ns['command'] = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, 'secrets missing'): self.ns['run_browser']()
        call.assert_not_called()
        self.assertFalse((self.private / 'local-secret.yml').exists())

    def test_changed_vendor_binary_never_starts_tunnel(self):
        (self.private / 'BrowserStackLocal').write_bytes(b'changed')
        call = self.ns['command'] = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, 'binary changed'): self.ns['run_browser']()
        call.assert_not_called()

    def test_source_hash_covers_real_bytes_and_physical_modes(self):
        files = self.source_fixture()
        with mock.patch.object(self.ns['subprocess'], 'check_output', return_value=('\0'.join(files) + '\0').encode()):
            first = self.ns['source']()
            (self.root / 'apps/example.ts').write_bytes(b'changed')
            changed_bytes = self.ns['source']()
            (self.root / 'apps/example.ts').chmod(0o755)
            changed_mode = self.ns['source']()
        self.assertEqual(first['trackedFiles'], 2)
        self.assertNotEqual(first['fileMapSha256'], changed_bytes['fileMapSha256'])
        self.assertNotEqual(changed_bytes['fileMapSha256'], changed_mode['fileMapSha256'])

    def test_source_rejects_dirty_checkout(self):
        self.ns['git'] = lambda *args: ' M file'
        with self.assertRaisesRegex(RuntimeError, 'Checkout changed'): self.ns['source']()

    def test_source_rejects_wrong_commit(self):
        self.ns['git'] = lambda *args: '' if args[0] == 'status' else 'c' * 40
        with self.assertRaisesRegex(RuntimeError, 'Wrong checkout'): self.ns['source']()

    def test_record_build_rejects_cross_source(self):
        self.write('source-before.json', {'sha': SHA})
        self.ns['source'] = lambda: {'sha': 'b' * 40}
        with self.assertRaisesRegex(RuntimeError, 'Build source changed'): self.ns['record_build']()
        self.assertFalse((self.private / 'build.json').exists())

    def build_fixture(self):
        value = {'sha': SHA, 'tree': 'b' * 40, 'fileMapSha256': 'c' * 64, 'trackedFiles': 2, 'lockSha256': 'd' * 64}
        self.write('source-before.json', value)
        self.ns['source'] = lambda: dict(value)
        for name in OUTPUT_ROOTS:
            path = self.root / name
            path.mkdir(parents=True)
            (path / 'output.js').write_text(name)
        (self.root / 'apps/web/.next/BUILD_ID').write_text('synthetic-build-id')

    def record_fixture_build(self):
        with mock.patch.object(self.ns['subprocess'], 'check_output', side_effect=[b'v22.23.2\n', b'11.19.0\n']):
            self.ns['record_build']()
        return json.loads((self.private / 'build.json').read_text())

    def admitted_fixture(self):
        self.write('image-provenance.json', {'images': self.cfg['imageProducers'], 'buildkitVerified': True,
                   'githubSignedProvenanceVerified': True, 'runtimeImageIdentityVerified': True, 'runtimeStarted': False})

    def test_record_build_binds_current_build_outputs(self):
        self.build_fixture()
        receipt = self.record_fixture_build()
        self.assertEqual(receipt['sha'], SHA)
        self.assertEqual(receipt['buildId'], 'synthetic-build-id')
        self.assertEqual(receipt['command'], ' '.join(BUILD_COMMAND))
        self.assertEqual(receipt['nodeVersion'], 'v22.23.2')
        self.assertEqual(receipt['pnpmVersion'], '11.19.0')
        self.assertRegex(receipt['outputsSha256'], '^[a-f0-9]{64}$')

    def test_record_build_requires_every_nonempty_closure_root(self):
        self.build_fixture()
        for name in OUTPUT_ROOTS:
            with self.subTest(root=name):
                path = self.root / name
                (path / 'output.js').unlink()
                with self.assertRaisesRegex(RuntimeError, 'Missing build output'):
                    self.record_fixture_build()
                self.assertFalse((self.private / 'build.json').exists())
                (path / 'output.js').write_text(name)

    def test_substituted_worker_root_is_rejected(self):
        self.build_fixture()
        worker = self.root / 'apps/worker/dist'
        (worker / 'output.js').unlink()
        worker.rmdir()
        other = self.path / 'unrelated-output'
        other.mkdir()
        (other / 'output.js').write_text('not the worker build')
        worker.symlink_to(other, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'Missing build output'):
            self.record_fixture_build()
        self.assertFalse((self.private / 'build.json').exists())

    def test_missing_worker_root_is_not_replaced_by_stale_ingestion_output(self):
        self.build_fixture()
        worker = self.root / 'apps/worker/dist'
        (worker / 'output.js').unlink()
        worker.rmdir()
        stale = self.root / 'packages/ingestion/dist'
        stale.mkdir(parents=True)
        (stale / 'output.js').write_text('unrelated old output')
        with self.assertRaisesRegex(RuntimeError, 'Missing build output'):
            self.record_fixture_build()
        self.assertFalse((self.private / 'build.json').exists())

    def test_worker_bytes_change_the_build_receipt(self):
        self.build_fixture()
        first = self.record_fixture_build()
        (self.private / 'build.json').unlink()
        (self.root / 'apps/worker/dist/output.js').write_text('changed worker')
        second = self.record_fixture_build()
        self.assertNotEqual(first['outputsSha256'], second['outputsSha256'])

    def test_unrelated_output_is_excluded_from_build_receipt(self):
        self.build_fixture()
        first = self.record_fixture_build()
        (self.private / 'build.json').unlink()
        stale = self.root / 'packages/ingestion/dist'
        stale.mkdir(parents=True)
        (stale / 'output.js').write_text('unrelated old output')
        second = self.record_fixture_build()
        self.assertEqual(first['outputsSha256'], second['outputsSha256'])

    def test_changed_worker_is_rejected_before_service_start(self):
        self.build_fixture()
        self.record_fixture_build()
        self.admitted_fixture()
        (self.root / 'apps/worker/dist/output.js').write_text('changed after receipt')
        call = self.ns['command'] = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, 'Build output changed'):
            self.ns['start']()
        call.assert_not_called()

    def test_start_rejects_old_or_weakened_build_command_before_service(self):
        self.build_fixture()
        original = self.record_fixture_build()
        self.admitted_fixture()
        call = self.ns['command'] = mock.Mock()
        for value in ('pnpm build --force', ' '.join(BUILD_COMMAND[:-1]),
                      ' '.join(x for x in BUILD_COMMAND if 'worker' not in x)):
            with self.subTest(command=value):
                self.write('build.json', {**original, 'command': value})
                with self.assertRaisesRegex(RuntimeError, 'Build command/tool mismatch'):
                    self.ns['start']()
                call.assert_not_called()

    def test_summary_rejects_old_or_weakened_build_command(self):
        self.full_receipts()
        original = json.loads((self.private / 'build.json').read_text())
        for value in ('pnpm build --force', ' '.join(BUILD_COMMAND[:-1]),
                      ' '.join(x for x in BUILD_COMMAND if 'worker' not in x)):
            with self.subTest(command=value):
                self.write('build.json', {**original, 'command': value})
                with self.assertRaisesRegex(RuntimeError, 'Browser delivery incomplete'):
                    self.summary_result()

    def test_stale_process_is_never_signalled_and_cleanup_fails(self):
        self.write('tunnel-process.json', {'pid': 999999, 'uid': 1000, 'startTicks': 'old', 'exe': '/synthetic'})
        self.ns['owned_pid'] = mock.Mock(side_effect=RuntimeError('identity changed'))
        with mock.patch.object(self.ns['os'], 'pidfd_open') as opened, mock.patch.object(self.ns['signal'], 'pidfd_send_signal') as signalled:
            with self.assertRaisesRegex(RuntimeError, 'Cleanup failed'): self.ns['cleanup']()
        opened.assert_not_called()
        signalled.assert_not_called()
        self.assertEqual(json.loads((self.private / 'cleanup.json').read_text())['failures'], ['owned-tunnel-cleanup'])

    def test_tunnel_stop_failure_does_not_skip_runtime_cleanup(self):
        (self.private / 'local-secret.yml').write_text('key: synthetic\n')
        (self.private / 'runtime-path').write_text('/synthetic')
        self.ns['runtime_path'] = lambda: Path('/synthetic')
        def fake_command(label, *args):
            if label == 'tunnel-stop': raise RuntimeError('synthetic failure')
        self.ns['command'] = mock.Mock(side_effect=fake_command)
        with self.assertRaisesRegex(RuntimeError, 'Cleanup failed'): self.ns['cleanup']()
        self.assertEqual([call.args[0] for call in self.ns['command'].call_args_list], ['tunnel-stop', 'runtime-stop'])

    def full_receipts(self):
        self.write('build.json', {'sha': SHA, 'buildId': 'synthetic-build', 'tree': 'b' * 40, 'fileMapSha256': 'c' * 64, 'lockSha256': 'd' * 64, 'outputsSha256': 'e' * 64, 'trackedFiles': 2, 'command': ' '.join(BUILD_COMMAND), 'nodeVersion': 'v22.23.2', 'pnpmVersion': '11.19.0'})
        self.write('source-before.json', {'sha': SHA, 'tree': 'b' * 40, 'fileMapSha256': 'c' * 64, 'lockSha256': 'd' * 64, 'trackedFiles': 2})
        self.write('browser-result.json', {'schemaVersion': 1, 'sourceSha': SHA, 'buildId': 'synthetic-build', 'syntheticOnly': True, 'browserSessionsAttempted': 1, 'retries': 0, 'origin': 'http://127.0.0.1:3287', 'checks': CHECKS, 'status': 'passed', 'sessionId': 'synthetic-session', 'browserVersion': 'synthetic-browser',
            'terminal': {'sessionId': 'synthetic-session', 'status': 'passed', 'browserstackStatus': 'done', 'durationSeconds': 25, 'buildName': f'nourishing-{SHA}-123-1', 'projectName': 'Nourishing', 'name': 'synthetic-login-search-add-report'},
            'capture': {'requested': {'video': False, 'screenshots': False, 'networkLogs': False, 'console': 'disable', 'playwrightLogs': False, 'maskCommands': 'sendType,sendPress,setHTTPCredentials,setStorageState,setGeolocation'}, 'observedArtifacts': {'video_url': 'null', 'har_logs_url': 'null', 'browser_console_logs_url': 'null', 'playwright_logs_url': 'missing'}, 'dashboardVerification': 'pending-first-run-review'},
            'cookieAttributesIndependentlyInspected': False})
        self.write('cleanup.json', {'failures': [], 'volumesRetainedUntilEphemeralRunnerTeardown': True})

    def summary_result(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output): self.ns['summary']()
        return json.loads(output.getvalue())

    def change_browser(self, **changes):
        value = json.loads((self.private / 'browser-result.json').read_text())
        value.update(changes)
        self.write('browser-result.json', value)

    def startup_fixture(self, commands=()):
        runtime = self.private / 'runtimes/nourishing-walkthrough-synthetic'
        runtime.mkdir(parents=True, mode=0o700)
        state = {'version': 2, 'syntheticOnly': True, 'runtime': str(runtime),
                 'repository': str(self.root), 'head': SHA, 'runId': 'a' * 16}
        (runtime / 'runtime.json').write_text(json.dumps(state))
        (runtime / 'runtime.json').chmod(0o600)
        self.write('runtime-path', str(runtime))
        (self.private / 'runtime-path').write_text(str(runtime) + '\n')
        (self.private / 'runtime-path').chmod(0o600)
        (self.private / 'create.stderr').write_text(json.dumps({'failed': True, 'reason': 'Expected two owned containers.'}))
        (self.private / 'create.stderr').chmod(0o600)
        for label, code in commands:
            record = {'label': label, 'exit': code, 'startedAt': '2026-09-29T04:00:00+00:00',
                      'endedAt': '2026-09-29T04:00:01.250000+00:00',
                      'argv': ['SYNTHETIC-SECRET-ARGV'], 'log': '/SYNTHETIC-PRIVATE-PATH'}
            path = runtime / (label + '-12345678.json')
            path.write_text(json.dumps(record)); path.chmod(0o600)
        return runtime

    def failed_start(self):
        self.ns['_start_runtime'] = mock.Mock(side_effect=RuntimeError('SYNTHETIC-PRIMARY-SECRET'))
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaisesRegex(RuntimeError, 'SYNTHETIC-PRIMARY-SECRET'):
            self.ns['start']()
        text = output.getvalue()
        self.assertNotIn('SYNTHETIC-PRIMARY-SECRET', text)
        return json.loads(text)['startupFailure']

    def test_startup_failure_projects_actual_receipt_shape_without_private_fields(self):
        self.startup_fixture([('dependencies', 1)])
        value = self.failed_start()
        self.assertEqual(value, {'diagnostics': 'available', 'runtimeCreated': True,
            'commands': [{'phase': 'dependencies', 'exit': 1, 'status': 'failed', 'elapsedMilliseconds': 1250}],
            'guardCode': 'container-count'})
        self.assertNotIn('SYNTHETIC-', json.dumps(value))

    def test_real_launcher_command_receipt_is_safely_projected(self):
        runtime = self.startup_fixture()
        launcher_path = DRAFT.parent / 'local-walkthrough'
        sys.path.insert(0, str(launcher_path))
        try:
            spec = importlib.util.spec_from_file_location('startup_receipt_launcher', launcher_path / 'run.py')
            launcher = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(launcher)
        finally:
            sys.path.remove(str(launcher_path))
        instance = object.__new__(launcher.Runtime)
        instance.path, instance.run_id, instance.base = runtime, 'a' * 16, {}
        child = mock.Mock(pid=4321)
        child.wait.return_value = 1
        with mock.patch.object(launcher.subprocess, 'Popen', return_value=child), \
                mock.patch.object(launcher, 'live_identity', return_value=None), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(launcher.WalkthroughError):
            instance.command('dependencies', ['SYNTHETIC-SECRET-ARGV'])
        value = self.ns['startup_diagnostic']()
        self.assertEqual(value['diagnostics'], 'available')
        self.assertEqual(value['commands'][0]['phase'], 'dependencies')
        self.assertEqual(value['commands'][0]['exit'], 1)
        self.assertNotIn('SYNTHETIC-', json.dumps(value))
        self.assertNotIn(str(runtime), json.dumps(value))

    def test_actual_start_failure_captures_runtime_and_keeps_original_exception(self):
        self.build_fixture(); self.record_fixture_build(); self.admitted_fixture()
        runtime = self.startup_fixture([('dependencies', 1)])
        (self.private / 'runtime-path').unlink()
        def create_failure(label, argv, seconds, env):
            self.assertEqual(label, 'create')
            (self.private / 'create.stdout').write_text(json.dumps({'runtime': str(runtime), 'syntheticOnly': True}) + '\n')
            raise RuntimeError('SYNTHETIC-PRIMARY-SECRET')
        self.ns['command'] = create_failure
        output = io.StringIO()
        # The real CLI has the existing owner-private umask before this call.
        previous = os.umask(0o077)
        try:
            with contextlib.redirect_stdout(output), self.assertRaisesRegex(RuntimeError, 'SYNTHETIC-PRIMARY-SECRET'):
                self.ns['start']()
        finally:
            os.umask(previous)
        self.assertEqual((self.private / 'runtime-path').read_text(), str(runtime) + '\n')
        self.assertEqual(json.loads(output.getvalue())['startupFailure']['commands'][0]['exit'], 1)
        self.assertNotIn('SYNTHETIC-PRIMARY-SECRET', output.getvalue())

    def test_startup_failure_before_runtime_still_preserves_primary(self):
        value = self.failed_start()
        self.assertEqual(value['diagnostics'], 'unavailable')
        self.assertEqual(value['commands'], [])
        self.assertEqual(value['guardCode'], 'undisclosed')

    def test_startup_failure_before_first_command_is_not_container_proof(self):
        runtime = self.startup_fixture()
        (runtime / 'containers.json').write_text('[]')
        value = self.failed_start()
        self.assertEqual(value['commands'], [])
        self.assertNotIn('containers', json.dumps(value))
        self.assertTrue(value['runtimeCreated'])

    def test_startup_rejects_malformed_oversized_and_hostile_receipts(self):
        runtime = self.startup_fixture([('dependencies', 1)])
        p = runtime / 'dependencies-12345678.json'; valid = p.read_bytes()
        for payload in (b'{', b'x' * 65537, json.dumps({'label': 'SYNTHETIC-SECRET', 'exit': 1}).encode()):
            with self.subTest(payload=payload[:20]):
                p.write_bytes(payload)
                value = self.ns['startup_diagnostic']()
                self.assertEqual(value['diagnostics'], 'unavailable')
                self.assertNotIn('SYNTHETIC-SECRET', json.dumps(value))
        p.write_bytes(valid)
        (self.private / 'create.stderr').write_text(json.dumps({'failed': True, 'reason': 'Expected two owned containers.\nSYNTHETIC-SECRET'}))
        self.assertEqual(self.ns['startup_diagnostic']()['guardCode'], 'undisclosed')

    def test_startup_rejects_unsafe_files_without_following_them(self):
        runtime = self.startup_fixture([('dependencies', 1)])
        p = runtime / 'dependencies-12345678.json'; valid = p.read_bytes()
        p.chmod(0o644)
        self.assertEqual(self.ns['startup_diagnostic']()['diagnostics'], 'unavailable')
        p.chmod(0o600); p.unlink(); target = self.path / 'SYNTHETIC-PRIVATE'
        target.write_bytes(valid); target.chmod(0o600); p.symlink_to(target)
        self.assertEqual(self.ns['startup_diagnostic']()['diagnostics'], 'unavailable')
        p.unlink(); os.link(target, p)
        self.assertEqual(self.ns['startup_diagnostic']()['diagnostics'], 'unavailable')
        p.unlink(); p.write_bytes(valid); p.chmod(0o600)
        with mock.patch.object(self.ns['os'], 'getuid', return_value=os.getuid() + 1):
            self.assertEqual(self.ns['startup_diagnostic']()['diagnostics'], 'unavailable')

    def test_startup_rejects_invalid_exit_and_duration_primitives(self):
        runtime = self.startup_fixture([('dependencies', 1)])
        p = runtime / 'dependencies-12345678.json'; valid = json.loads(p.read_text())
        variants = [{'exit': x} for x in (True, 1.5, '1', -65, 256)] + [
            {'endedAt': '2026-09-29T03:59:59+00:00'},
            {'endedAt': '2026-09-29T04:10:01+00:00'},
            {'endedAt': 'NaN'}, {'startedAt': False},
            {'endedAt': '2026-09-29T04:00:01'},
        ]
        for changes in variants:
            with self.subTest(changes=changes):
                p.write_text(json.dumps({**valid, **changes}))
                self.assertEqual(self.ns['startup_diagnostic']()['diagnostics'], 'unavailable')
        for code, status in ((None, 'incomplete'), (-15, 'failed'), (0, 'completed')):
            p.write_text(json.dumps({**valid, 'exit': code}))
            self.assertEqual(self.ns['startup_diagnostic']()['commands'][0]['status'], status)

    def test_startup_projection_failure_never_masks_primary(self):
        self.ns['startup_diagnostic'] = mock.Mock(side_effect=ValueError('SYNTHETIC-SECRET'))
        self.ns['save'] = mock.Mock(side_effect=OSError('SYNTHETIC-WRITE-SECRET'))
        self.assertEqual(self.failed_start()['diagnostics'], 'unavailable')

    def test_startup_summary_retains_failure_and_honest_cleanup_without_browser(self):
        runtime = self.startup_fixture([('dependencies', 1)])
        self.failed_start()
        self.ns['command'] = mock.Mock()
        self.ns['cleanup']()
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(RuntimeError): self.ns['summary']()
        value = json.loads(output.getvalue())
        self.assertFalse(value['accepted'])
        self.assertEqual(value['startupFailure']['commands'][0]['exit'], 1)
        self.assertEqual(value['startupCleanup'], {'runtimeStop': 'passed'})
        self.assertNotIn('containers', json.dumps(value))
        self.assertNotIn(str(runtime), output.getvalue())

    def test_startup_cleanup_status_distinguishes_absent_and_failed(self):
        self.ns['cleanup']()
        self.assertEqual(json.loads((self.private / 'cleanup.json').read_text())['runtimeStop'], 'not-attempted')
        (self.private / 'cleanup.json').unlink()
        self.startup_fixture()
        self.ns['command'] = mock.Mock(side_effect=RuntimeError('SYNTHETIC-SECRET'))
        with self.assertRaises(RuntimeError): self.ns['cleanup']()
        self.assertEqual(json.loads((self.private / 'cleanup.json').read_text())['runtimeStop'], 'failed')

    def test_startup_failure_marker_never_allows_success_summary(self):
        self.full_receipts(); self.write('startup-failure.json', {'failed': True})
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_complete_synthetic_receipts_accept(self):
        self.full_receipts()
        self.assertIs(self.summary_result()['accepted'], True)

    def test_failed_browser_never_accepts(self):
        self.full_receipts(); self.change_browser(status='failed')
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_failed_summary_retains_only_safe_session_diagnostic(self):
        self.full_receipts(); self.change_browser(status='failed', failedStage=CHECKS[0], unexpectedPrivate='SYNTHETIC-SECRET-SENTINEL')
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(RuntimeError): self.ns['summary']()
        value = json.loads(output.getvalue())
        self.assertIs(value['accepted'], False)
        self.assertEqual(value['failedBrowser']['sessionId'], 'synthetic-session')
        self.assertEqual(value['failedBrowser']['stage'], CHECKS[0])
        self.assertNotIn('SYNTHETIC-SECRET-SENTINEL', output.getvalue())

    def failed_summary(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(RuntimeError): self.ns['summary']()
        self.assertNotIn('SYNTHETIC-SECRET', output.getvalue())
        value = json.loads(output.getvalue())
        self.assertIs(value['accepted'], False)
        return value

    def test_failed_search_summary_projects_each_fixed_substep(self):
        for substep in ('open-foods', 'wait-destination', 'check-local-day', 'check-meal',
                        'fill-search', 'submit-search', 'wait-result', 'check-result-count',
                        'fill-amount', 'observe-add-response', 'click-add', 'check-add-response'):
            with self.subTest(substep=substep):
                self.full_receipts()
                self.change_browser(status='failed', failedStage=CHECKS[1], failedSubstep=substep,
                                    checks=[CHECKS[0]], unexpectedPrivate='SYNTHETIC-SECRET')
                value = self.failed_summary()
                self.assertEqual(value['failedBrowser']['stage'], CHECKS[1])
                self.assertEqual(value['failedBrowser']['substep'], substep)

    def test_failed_search_summary_discards_malformed_substeps(self):
        for substep in (None, True, 1, [], {}, 'unknown', 'open-foods\nSYNTHETIC-SECRET',
                        'x' * 10000, 'SYNTHETIC-SECRET'):
            with self.subTest(substep=type(substep).__name__):
                self.full_receipts()
                self.change_browser(status='failed', failedStage=CHECKS[1], failedSubstep=substep)
                value = self.failed_summary()
                self.assertEqual(value['failedBrowser']['stage'], CHECKS[1])
                self.assertNotIn('substep', value['failedBrowser'])

    def test_failed_summary_discards_substeps_from_other_stages(self):
        for stage in ('connect', 'session-identity', *CHECKS[:1], *CHECKS[2:],
                      'terminal-verification', 'unknown', 'SYNTHETIC-SECRET'):
            with self.subTest(stage=stage):
                self.full_receipts()
                self.change_browser(status='failed', failedStage=stage, failedSubstep='open-foods')
                self.assertNotIn('substep', self.failed_summary()['failedBrowser'])

    def test_success_summary_omits_forged_failure_substep(self):
        self.full_receipts()
        self.change_browser(failedStage=CHECKS[1], failedSubstep='open-foods')
        value = self.summary_result()
        self.assertIs(value['accepted'], True)
        self.assertNotIn('failedBrowser', value)
        self.assertNotIn('failedSubstep', json.dumps(value))
        self.assertNotIn('open-foods', json.dumps(value))

    def test_cleanup_failure_does_not_relabel_passed_browser_as_search_failure(self):
        self.full_receipts()
        self.change_browser(failedStage=CHECKS[1], failedSubstep='open-foods')
        self.write('cleanup.json', {'failures': ['runtime-stop']})
        self.assertNotIn('substep', self.failed_summary()['failedBrowser'])

    def test_missing_receipt_never_accepts(self):
        self.full_receipts(); (self.private / 'browser-result.json').unlink()
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_failed_cleanup_never_accepts(self):
        self.full_receipts(); self.write('cleanup.json', {'failures': ['runtime-stop']})
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_cross_source_browser_is_rejected(self):
        self.full_receipts(); self.change_browser(sourceSha='f' * 40)
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_missing_session_is_rejected(self):
        self.full_receipts(); self.change_browser(sessionId=None)
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_missing_journey_checks_are_rejected(self):
        self.full_receipts(); self.change_browser(checks=[])
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_wrong_session_count_is_rejected(self):
        self.full_receipts(); self.change_browser(browserSessionsAttempted=2)
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_cross_build_browser_is_rejected(self):
        self.full_receipts(); self.change_browser(buildId='older-build')
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_retried_browser_is_rejected(self):
        self.full_receipts(); self.change_browser(retries=1)
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_boolean_session_counter_is_rejected(self):
        self.full_receipts(); self.change_browser(browserSessionsAttempted=True)
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_duplicate_journey_check_is_rejected(self):
        self.full_receipts(); self.change_browser(checks=[CHECKS[0]] * len(CHECKS))
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_live_vendor_session_is_rejected(self):
        self.full_receipts(); self.change_browser(terminal={'status': 'passed', 'browserstackStatus': 'running'})
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_cross_session_terminal_record_is_rejected(self):
        self.full_receipts(); self.change_browser(terminal={'status': 'passed', 'browserstackStatus': 'done', 'sessionId': 'different-session'})
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_missing_capture_observation_cannot_be_presented_as_verified(self):
        self.full_receipts(); self.change_browser(capture=None)
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_command_timeout_terminates_owned_group(self):
        child = mock.Mock(pid=4321)
        child.poll.return_value = None
        child.wait.return_value = -15
        with mock.patch.object(self.ns['subprocess'], 'Popen', return_value=child) as opened, mock.patch.object(self.ns['os'], 'killpg') as killed:
            with self.assertRaises(RuntimeError): self.ns['command']('browser', ['synthetic'], 0)
        self.assertTrue(opened.call_args.kwargs.get('start_new_session'))
        killed.assert_called_once_with(4321, self.ns['signal'].SIGTERM)

    def test_command_cancellation_terminates_group_and_restores_handler(self):
        child = mock.Mock(pid=4321)
        child.poll.side_effect = KeyboardInterrupt
        child.wait.return_value = -15
        before = self.ns['signal'].getsignal(self.ns['signal'].SIGTERM)
        with mock.patch.object(self.ns['subprocess'], 'Popen', return_value=child), mock.patch.object(self.ns['os'], 'killpg') as killed:
            with self.assertRaises(RuntimeError): self.ns['command']('browser', ['synthetic'], 1)
        killed.assert_called_once_with(4321, self.ns['signal'].SIGTERM)
        self.assertEqual(self.ns['signal'].getsignal(self.ns['signal'].SIGTERM), before)

    def test_hostile_command_labels_are_rejected_before_process_or_output(self):
        for label in ('unknown', '../private', 'browser\nSECRET', 'SYNTHETIC-SECRET-SENTINEL', None, []):
            with self.subTest(label=label):
                output, errors = io.StringIO(), io.StringIO()
                before = sorted(path.name for path in self.private.iterdir())
                with mock.patch.object(self.ns['subprocess'], 'Popen', side_effect=AssertionError('must not spawn')) as opened, contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    with self.assertRaisesRegex(RuntimeError, 'Unknown command stage'):
                        self.ns['command'](label, ['SYNTHETIC-PRIVATE-ARGUMENT'], 1)
                opened.assert_not_called()
                self.assertEqual(output.getvalue(), '')
                self.assertEqual(errors.getvalue(), '')
                self.assertEqual(sorted(path.name for path in self.private.iterdir()), before)

    def test_known_command_stages_print_only_started_and_passed(self):
        labels = ['local-version', 'local-help', 'image-pull-0', 'image-pull-1',
                  'image-index-0', 'image-index-1', 'image-buildkit-0', 'image-buildkit-1',
                  'image-signed-provenance-0', 'image-signed-provenance-1',
                  'image-labels-0', 'image-labels-1', 'create', 'tunnel-start',
                  'browser', 'tunnel-stop', 'runtime-stop']
        for label in labels:
            with self.subTest(label=label):
                child = mock.Mock(pid=4321, returncode=0)
                child.poll.return_value = 0
                output, errors = io.StringIO(), io.StringIO()
                with mock.patch.object(self.ns['subprocess'], 'Popen', return_value=child), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    self.ns['command'](label, ['SYNTHETIC-PRIVATE-ARGUMENT'], 1, {'PRIVATE': 'SYNTHETIC-SECRET-SENTINEL'})
                self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()],
                                 [{'stage': label, 'status': 'started'}, {'stage': label, 'status': 'passed'}])
                self.assertEqual(errors.getvalue(), '')

    def test_failed_command_prints_stage_without_private_output_or_pass(self):
        child = mock.Mock(pid=4321, returncode=1)
        child.poll.return_value = 1
        def spawn(*args, **kwargs):
            kwargs['stdout'].write(b'SYNTHETIC-SECRET-STDOUT')
            kwargs['stderr'].write(b'SYNTHETIC-SECRET-STDERR')
            return child
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch.object(self.ns['subprocess'], 'Popen', side_effect=spawn), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with self.assertRaisesRegex(RuntimeError, 'browser: command failed'):
                self.ns['command']('browser', ['SYNTHETIC-PRIVATE-ARGUMENT'], 1, {'PRIVATE': 'SYNTHETIC-SECRET-SENTINEL'})
        self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()], [{'stage': 'browser', 'status': 'started'}])
        self.assertEqual(errors.getvalue(), '')
        self.assertEqual((self.private / 'browser.stdout').read_bytes(), b'SYNTHETIC-SECRET-STDOUT')
        self.assertEqual((self.private / 'browser.stderr').read_bytes(), b'SYNTHETIC-SECRET-STDERR')

    def test_capture_observation_does_not_claim_runtime_flags_or_masking_proof(self):
        self.full_receipts()
        result = self.summary_result()
        self.assertEqual(result['capture']['dashboardVerification'], 'pending-first-run-review')
        self.assertIs(result['cookieAttributesIndependentlyInspected'], False)

    def test_boolean_terminal_duration_is_rejected(self):
        self.full_receipts()
        value = json.loads((self.private / 'browser-result.json').read_text())
        value['terminal']['durationSeconds'] = True
        self.write('browser-result.json', value)
        with self.assertRaises(RuntimeError): self.summary_result()

    def test_private_nested_metadata_is_not_printed(self):
        self.full_receipts()
        value = json.loads((self.private / 'browser-result.json').read_text())
        value['terminal']['public_url'] = 'SYNTHETIC-SECRET-SENTINEL'
        value['capture']['private'] = 'SYNTHETIC-SECRET-SENTINEL'
        self.write('browser-result.json', value)
        self.assertNotIn('SYNTHETIC-SECRET-SENTINEL', json.dumps(self.summary_result()))

    def test_summary_does_not_print_unallowlisted_private_field(self):
        self.full_receipts(); self.change_browser(unexpectedPrivate='SYNTHETIC-SECRET-SENTINEL')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            try: self.ns['summary']()
            except RuntimeError: pass
        self.assertNotIn('SYNTHETIC-SECRET-SENTINEL', output.getvalue())

class RealBuildGraphTests(unittest.TestCase):
    def test_workflow_build_resolves_actual_runtime_dependency_closure(self):
        root = DRAFT.parents[1]
        workflow = (root / '.github/workflows/browserstack-web.yml').read_text()
        section = workflow.split('- name: Build this checkout without task-cache reuse\n', 1)[1].split('\n      - name:', 1)[0]
        commands = [shlex.split(line.strip()) for line in section.splitlines()
                    if line.strip().startswith('pnpm ')]
        self.assertEqual(len(commands), 1)
        invocation = commands[0]
        if invocation[:3] == ['pnpm', 'exec', 'turbo']:
            turbo_args = invocation[3:]
        else:
            self.assertEqual(invocation[:2], ['pnpm', 'build'])
            script = shlex.split(json.loads((root / 'package.json').read_text())['scripts']['build'])
            self.assertEqual(script[0], 'turbo')
            turbo_args = [*script[1:], *invocation[2:]]
        env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG') if key in os.environ}
        env.update(CI='1', TURBO_TELEMETRY_DISABLED='1')
        result = subprocess.run(['node', str(root / 'node_modules/turbo/bin/turbo'),
                                 *turbo_args, '--dry=json'], cwd=root, env=env,
                                capture_output=True, text=True, timeout=30, check=True)
        graph = json.loads(result.stdout)
        manifests = {}
        for pattern in ('apps/*/package.json', 'packages/*/package.json'):
            for path in root.glob(pattern):
                value = json.loads(path.read_text())
                manifests[value['name']] = value
        roots = {'@nutrition-tracker/' + name for name in ('web', 'api', 'worker')}
        dependencies = {name: {dep for key in ('dependencies', 'devDependencies')
                              for dep, version in item.get(key, {}).items()
                              if version.startswith('workspace:')}
                        for name, item in manifests.items()}
        closure = set(roots)
        pending = list(roots)
        while pending:
            for dependency in dependencies[pending.pop()]:
                if dependency not in closure:
                    closure.add(dependency)
                    pending.append(dependency)
        expected = {name + '#build' for name in closure}
        tasks = {task['taskId']: task for task in graph['tasks']}
        self.assertEqual(set(tasks), expected)
        self.assertEqual(len(tasks), 8)
        self.assertFalse(any(name in closure for name in
                             ('@nutrition-tracker/mobile', '@nutrition-tracker/ingest', '@nutrition-tracker/ingestion')))
        for name in closure:
            task = tasks[name + '#build']
            self.assertEqual(task['command'], manifests[name]['scripts']['build'])
            self.assertEqual(set(task['dependencies']), {dep + '#build' for dep in dependencies[name]})
        self.assertEqual(invocation, list(BUILD_COMMAND))
        declared = next(item.value for item in TREE.body if isinstance(item, ast.Assign)
                        and any(isinstance(target, ast.Name) and target.id == 'BUILD_COMMAND' for target in item.targets))
        self.assertEqual(ast.literal_eval(declared), BUILD_COMMAND)
        fixture = (root / 'scripts/local-walkthrough/seed-catalogue.mts').read_text()
        dist_imports = re.findall(r'from ["\']\.\./\.\./((?:apps|packages)/[^/]+)/dist/', fixture)
        self.assertIn('apps/worker', dist_imports)
        for package in dist_imports:
            self.assertIn(json.loads((root / package / 'package.json').read_text())['name'], closure)

if __name__ == '__main__': unittest.main()
