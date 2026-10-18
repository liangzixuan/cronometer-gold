"""Exercise the pinned action entrypoint with a synthetic scanner, never Trivy."""
import ast
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / '.github/workflows/browserstack-web.yml'
FIXTURE = Path(__file__).with_name('fixtures') / 'trivy-action-ed142fd' / 'entrypoint.sh.base64'
ACTION = 'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25'
ENTRYPOINT_SHA = '5d35de70292a3461e55874ca658b3d8f6a56acc4d7098c64e546d965c34a0067'
# Exact upstream: https://github.com/aquasecurity/trivy-action/blob/ed142fd0673e97e23eac54620cfb913e5ce36c25/entrypoint.sh
IMAGES = json.loads((ROOT / 'scripts/browserstack/project.json').read_text())['images']
SCALAR = re.compile(r'[A-Za-z0-9_./:@,${} -]+')


def workflow_job(text, name):
    lines = text.splitlines()
    if lines.count('jobs:') != 1 or lines.count('  ' + name + ':') != 1:
        raise ValueError('Expected one exact workflow job')
    start = lines.index('  ' + name + ':')
    end = next((i for i in range(start + 1, len(lines))
                if re.fullmatch(r'  [A-Za-z0-9_-]+:', lines[i])), len(lines))
    return '\n'.join(lines[start:end])


def scan_steps(text):
    """Read only this workflow's two explicit scalar action blocks; reject ambiguity."""
    if '\t' in text:
        raise ValueError('Tabs are not supported in workflow scan blocks')
    blocks = [block for name in ('postgres-fixture-vulnerabilities', 'meilisearch-fixture-vulnerabilities')
              for block in re.split(r'(?m)(?=^      - )', workflow_job(text, name))]
    steps = []
    for block in blocks:
        if 'aquasecurity/trivy-action' not in block:
            continue
        lines = block.splitlines()
        if not re.fullmatch(r'      - name: [A-Za-z0-9 ]+', lines[0]):
            raise ValueError('Expected a named scan action')
        step, section = {}, None
        for line in lines[1:]:
            if not line.strip():
                continue
            if line.startswith('        uses: '):
                if 'uses' in step:
                    raise ValueError('Duplicate action identity')
                value = line.removeprefix('        uses: ').split(' # ', 1)[0]
                if value != ACTION:
                    raise ValueError('Unexpected Trivy action identity')
                step['uses'] = value
                section = None
            elif line in ('        env:', '        with:'):
                section = line.strip()[:-1]
                if section in step:
                    raise ValueError('Duplicate scan mapping')
                step[section] = {}
            else:
                match = re.fullmatch(r'          ([A-Za-z][A-Za-z0-9_-]*): (.+)', line)
                if section is None or match is None:
                    raise ValueError('Unsupported scan mapping shape')
                key, value = match.groups()
                if key in step[section]:
                    raise ValueError('Duplicate scan scalar')
                if value.startswith('"'):
                    value = json.loads(value)
                if not isinstance(value, str) or not SCALAR.fullmatch(value):
                    raise ValueError('Unsupported scan scalar')
                if ('${{' in value and not re.fullmatch(r'\$\{\{ runner\.temp \}\}/[A-Za-z0-9_.-]+', value)):
                    raise ValueError('Unexpected workflow expression')
                step[section][key] = value
        if set(step) != {'uses', 'env', 'with'}:
            raise ValueError('Incomplete scan action')
        steps.append(step)
    if len(steps) != 2:
        raise ValueError('Expected exactly two scan actions')
    return steps


def independent_scans(text):
    names = re.findall(r'(?m)^  ([A-Za-z0-9_-]+):$', text.split('jobs:\n', 1)[1])
    expected = ['synthetic-browser', 'postgres-fixture-vulnerabilities', 'meilisearch-fixture-vulnerabilities']
    if sorted(names) != sorted(expected):
        raise ValueError('Expected independent browser and two scan jobs')
    functional = workflow_job(text, 'synthetic-browser')
    header = functional.split('    steps:\n', 1)[0]
    guard = "    if: github.repository == 'liangzixuan/cronometer-gold' && github.ref == 'refs/heads/codex/retention-features'"
    if ('aquasecurity/trivy-action' in functional or
            re.search(r'(?m)^    (?:needs|continue-on-error):', header) or
            re.findall(r'(?m)^    if:.*$', header) != [guard]):
        raise ValueError('Browser must run independently under its trusted source guard')
    for name, label in zip(expected[1:], ['PostgreSQL', 'Meilisearch']):
        job = workflow_job(text, name)
        marker = '      - name: Reject high or critical ' + label + ' fixture vulnerabilities'
        prefix = job.split(marker, 1)[0]
        required = ('  ' + name + ':\n' + guard + '\n'
                    '    runs-on: ubuntu-24.04-arm\n    timeout-minutes: 20\n    steps:\n'
                    '      - name: Check out source\n'
                    '        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0\n'
                    '        with:\n          persist-credentials: false\n'
                    '      - name: Initialize empty fixture vulnerability-ignore policy\n'
                    '        run: install -m 600 /dev/null "${RUNNER_TEMP}/browser-fixture.trivyignore"\n')
        if prefix != required or job.count('aquasecurity/trivy-action') != 1:
            raise ValueError('Scan must remain strict and independent under the original guard')
    return scan_steps(text)


class TrivyWorkflowTests(unittest.TestCase):
    def setUp(self):
        encoded = FIXTURE.read_text(encoding='ascii')
        decoded = base64.b64decode(''.join(encoded.splitlines()), validate=True)
        self.assertEqual(hashlib.sha256(decoded).hexdigest(), ENTRYPOINT_SHA)
        self.temporary = tempfile.TemporaryDirectory(prefix='trivy-action-contract-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.entrypoint = self.base / 'entrypoint.sh'
        self.entrypoint.write_bytes(decoded)
        self.entrypoint.chmod(0o600)
        self.checkout = self.base / 'checkout'
        self.runner = self.base / 'runner-temp'
        self.checkout.mkdir()
        self.runner.mkdir()
        self.lock = b'lockfileVersion: 9\n'
        (self.checkout / 'pnpm-lock.yaml').write_bytes(self.lock)
        (self.checkout / 'pnpm-lock.yaml').chmod(0o644)
        self.ignore = self.runner / 'browser-fixture.trivyignore'
        self.ignore.write_bytes(b'')
        self.ignore.chmod(0o600)
        self.stub = self.base / 'trivy-stub'
        self.stub.write_text('#!' + sys.executable + '\n' + '''
import json, os, pathlib, sys
cache = pathlib.Path(os.environ['TRIVY_CACHE_DIR'])
cache.mkdir(parents=True, exist_ok=True)
(cache / 'synthetic-db-cache').write_bytes(b'synthetic cache')
keys = ['TRIVY_PLATFORM', 'TRIVY_IGNOREFILE', 'TRIVY_CACHE_DIR', 'TRIVY_EXIT_CODE',
        'TRIVY_IGNORE_UNFIXED', 'TRIVY_PKG_TYPES', 'TRIVY_SCANNERS', 'TRIVY_SEVERITY', 'TRIVY_TIMEOUT']
pathlib.Path(os.environ['STUB_RECEIPT']).write_text(json.dumps({'argv': sys.argv[1:],
    'env': {key: os.environ.get(key) for key in keys}}))
sys.exit(int(os.environ.get('STUB_EXIT', '0')))
''')
        self.stub.chmod(0o700)
        tree = ast.parse((ROOT / 'scripts/browserstack/ci-run.py').read_text())
        selected = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                    and node.name in ('require', 'sha', 'source')]
        self.assertEqual({node.name for node in selected}, {'require', 'sha', 'source'})
        self.ns = {'ROOT': self.checkout, 'hashlib': hashlib, 'json': json,
                   'os': os, 'stat': stat, 'subprocess': subprocess, 'git': self.git}
        exec(compile(ast.Module(body=selected, type_ignores=[]), '<actual-source-guard>', 'exec'), self.ns)

    def git(self, *args):
        if args == ('status', '--porcelain'):
            entries = list(self.checkout.iterdir())
            return '' if (entries == [self.checkout / 'pnpm-lock.yaml'] and
                          entries[0].read_bytes() == self.lock) else '?? unexpected-change'
        if args == ('rev-parse', 'HEAD'):
            return 'a' * 40
        if args == ('rev-parse', 'HEAD^{tree}'):
            return 'b' * 40
        raise AssertionError('Unreviewed synthetic Git request')

    def assert_source(self):
        with patch.dict(os.environ, {'GITHUB_SHA': 'a' * 40}, clear=True), \
             patch.object(subprocess, 'check_output', return_value=b'pnpm-lock.yaml\0') as command:
            result = self.ns['source']()
        command.assert_called_once_with(['git', 'ls-files', '-z'], cwd=self.checkout, timeout=20)
        return result

    def run_action(self, step, label, exit_code=0):
        resolve = lambda value: value.replace('${{ runner.temp }}', str(self.runner))
        inputs = step['with']
        receipt = self.runner / (label + '.json')
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TRIVY_CMD': str(self.stub),
               'STUB_RECEIPT': str(receipt), 'STUB_EXIT': str(exit_code),
               'INPUT_SCAN_TYPE': inputs.get('scan-type', 'image'),
               'INPUT_IMAGE_REF': inputs['image-ref'],
               'INPUT_TRIVYIGNORES': resolve(inputs.get('trivyignores', '')),
               'TRIVY_CACHE_DIR': resolve(inputs.get('cache-dir', '.cache/trivy'))}
        # The pinned composite action omits these values when they equal its defaults.
        # Strict workflow inputs still bind them; the scanner uses its own defaults.
        for key, target in {'exit-code': 'TRIVY_EXIT_CODE', 'ignore-unfixed': 'TRIVY_IGNORE_UNFIXED',
                            'vuln-type': 'TRIVY_PKG_TYPES', 'scanners': 'TRIVY_SCANNERS',
                            'severity': 'TRIVY_SEVERITY', 'timeout': 'TRIVY_TIMEOUT'}.items():
            defaults = {'ignore-unfixed': 'false', 'vuln-type': 'os,library'}
            if inputs[key] != defaults.get(key, ''):
                env[target] = inputs[key]
        env.update({key: resolve(value) for key, value in step['env'].items()})
        result = subprocess.run(['/bin/bash', str(self.entrypoint)], cwd=self.checkout, env=env,
                                capture_output=True, text=True, timeout=10)
        return result, json.loads(receipt.read_text())

    def test_fixture_scans_do_not_gate_browser(self):
        self.assertEqual(len(independent_scans(WORKFLOW.read_text())), 2)

    def test_rejects_dependencies_hidden_failures_and_scan_bypasses(self):
        original = WORKFLOW.read_text()
        variants = [
            original.replace('  synthetic-browser:\n', '  synthetic-browser:\n    needs: meilisearch-fixture-vulnerabilities\n', 1),
            original.replace('  postgres-fixture-vulnerabilities:\n', '  postgres-fixture-vulnerabilities:\n    needs: synthetic-browser\n', 1),
            original.replace('  meilisearch-fixture-vulnerabilities:\n', '  meilisearch-fixture-vulnerabilities:\n    continue-on-error: true\n', 1),
            original.replace('      - name: Reject high or critical PostgreSQL fixture vulnerabilities\n', '      - name: Reject high or critical PostgreSQL fixture vulnerabilities\n        continue-on-error: true\n', 1),
            original.replace('      - name: Reject high or critical Meilisearch fixture vulnerabilities\n', '      - name: Reject high or critical Meilisearch fixture vulnerabilities\n        if: false\n', 1),
        ]
        scan_job = workflow_job(original, 'postgres-fixture-vulnerabilities')
        block = scan_job[scan_job.index('      - name: Reject high or critical PostgreSQL fixture vulnerabilities'):]
        moved = original.replace(block, '', 1).replace('      - name: Build this checkout without task-cache reuse', block + '\n      - name: Build this checkout without task-cache reuse', 1)
        variants.append(moved)
        for changed in variants:
            with self.subTest(changed=changed[-40:]), self.assertRaises(ValueError):
                independent_scans(changed)

    def test_workflow_preserves_exact_strict_scan_policy(self):
        steps = scan_steps(WORKFLOW.read_text())
        for step, image in zip(steps, IMAGES):
            with self.subTest(image=image):
                self.assertEqual(step['uses'], ACTION)
                self.assertEqual(step['env'], {'TRIVY_PLATFORM': 'linux/arm64',
                    'TRIVY_IGNOREFILE': '${{ runner.temp }}/browser-fixture.trivyignore'})
                self.assertEqual(step['with'], {'version': 'v0.74.0', 'cache': 'false',
                    'cache-dir': '${{ runner.temp }}/browser-fixture-trivy-cache',
                    'scan-type': 'image', 'image-ref': image, 'scanners': 'vuln',
                    'vuln-type': 'os,library', 'severity': 'HIGH,CRITICAL',
                    'ignore-unfixed': 'false', 'exit-code': '1', 'timeout': '5m'})

    def test_pinned_entrypoint_keeps_ignore_and_cache_outside_checkout(self):
        before = self.assert_source()
        for index, step in enumerate(scan_steps(WORKFLOW.read_text())):
            result, record = self.run_action(step, f'scan-{index}')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.assert_source(), before)
            self.assertEqual(record['argv'], ['image', IMAGES[index]])
            self.assertEqual(record['env'], {'TRIVY_PLATFORM': 'linux/arm64',
                'TRIVY_IGNOREFILE': str(self.ignore),
                'TRIVY_CACHE_DIR': str(self.runner / 'browser-fixture-trivy-cache'),
                'TRIVY_EXIT_CODE': '1', 'TRIVY_IGNORE_UNFIXED': None,
                'TRIVY_PKG_TYPES': None, 'TRIVY_SCANNERS': 'vuln',
                'TRIVY_SEVERITY': 'HIGH,CRITICAL', 'TRIVY_TIMEOUT': '5m'})
            self.assertEqual((self.runner / 'browser-fixture-trivy-cache/synthetic-db-cache').read_bytes(), b'synthetic cache')
            self.assertEqual(self.ignore.read_bytes(), b'')
        rejected, _ = self.run_action(scan_steps(WORKFLOW.read_text())[0], 'rejected', exit_code=7)
        self.assertEqual(rejected.returncode, 7)

    def test_plain_ignore_input_reproduces_dirty_checkout_rejection(self):
        step = copy.deepcopy(scan_steps(WORKFLOW.read_text())[0])
        step['with']['trivyignores'] = '${{ runner.temp }}/browser-fixture.trivyignore'
        result, record = self.run_action(step, 'legacy-plain')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(record['env']['TRIVY_IGNOREFILE'], './trivyignores')
        self.assertEqual((self.checkout / 'trivyignores').read_bytes(), b'')
        with self.assertRaisesRegex(RuntimeError, 'Checkout changed or has untracked files'):
            self.assert_source()

    def test_source_guard_still_rejects_unrelated_untracked_and_tracked_changes(self):
        self.assert_source()
        extra = self.checkout / 'unrelated.txt'
        extra.write_text('synthetic unrelated file')
        with self.assertRaisesRegex(RuntimeError, 'Checkout changed or has untracked files'):
            self.assert_source()
        extra.unlink()
        (self.checkout / 'pnpm-lock.yaml').write_text('changed lock')
        with self.assertRaisesRegex(RuntimeError, 'Checkout changed or has untracked files'):
            self.assert_source()

    def test_scan_block_extraction_rejects_ambiguous_yaml(self):
        original = WORKFLOW.read_text()
        variants = [original.replace('          scanners: vuln', '          scanners: vuln\n          scanners: vuln', 1),
                    original.replace('        env:\n          TRIVY_PLATFORM:', '        env: &alias\n          TRIVY_PLATFORM:', 1),
                    original.replace('          severity: HIGH,CRITICAL', '          severity: [HIGH, CRITICAL]', 1),
                    original.replace(ACTION, ACTION.replace('ed142fd', 'aa142fd'), 1)]
        for value in variants:
            with self.subTest(value=value[-40:]), self.assertRaises(ValueError):
                scan_steps(value)


if __name__ == '__main__':
    unittest.main(verbosity=2)
