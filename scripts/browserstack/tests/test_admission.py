"""Offline admission contracts against the actual CI helper."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
TREE = ast.parse((ROOT / 'ci-run.py').read_text())
INERT = ast.Module(body=[item for item in TREE.body if isinstance(item, (ast.Import, ast.ImportFrom, ast.Assign, ast.FunctionDef))], type_ignores=[])


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.private = Path(self.temp.name)
        self.ns = {'__file__': str(ROOT / 'ci-run.py')}
        exec(compile(INERT, str(ROOT / 'ci-run.py'), 'exec'), self.ns)
        self.cfg = json.loads((ROOT / 'project.json').read_text())
        self.command = Mock(side_effect=self.output)
        self.ns.update(CFG=self.cfg, PRIVATE=self.private, command=self.command)

    def output(self, label, argv, *unused):
        if label.startswith('image-labels-'):
            index = int(label.rsplit('-', 1)[1])
            producer = self.cfg['imageProducers'][index]
            component = 'postgres' if index == 0 else 'meilisearch'
            config = {'Labels': source_labels(component, producer['sourceSha'])}
            target = self.private / label
            target.write_text(json.dumps([{'Os': 'linux', 'Architecture': 'arm64',
                'RepoDigests': [producer['image']], 'Config': config}]))
            return target
        return self.private / 'index'

    def test_original_provenance_bound_before_runtime(self):
        with patch.dict(os.environ, {'GITHUB_SHA': 'f' * 40}, clear=True):
            self.ns['admit_images']()
        calls = self.command.call_args_list
        self.assertEqual(len(calls), 8)
        for index, producer in enumerate(self.cfg['imageProducers']):
            self.assertEqual(calls[index * 4].args[1], ['docker', 'buildx', 'imagetools', 'inspect', '--raw', producer['image']])
            self.assertEqual(calls[index * 4 + 1].args[1][-2:], ['--image-ref', producer['image']])
            signed = calls[index * 4 + 2].args[1]
            self.assertEqual(signed[:4], ['gh', 'attestation', 'verify', 'oci://' + producer['image']])
            for flag, value in [('--repo', self.cfg['repository']), ('--source-digest', producer['sourceSha']),
                                ('--signer-digest', producer['workflowSha']), ('--source-ref', producer['sourceRef']),
                                ('--predicate-type', 'https://slsa.dev/provenance/v1')]:
                self.assertEqual(signed[signed.index(flag) + 1], value)
            self.assertIn('--deny-self-hosted-runners', signed)
            self.assertNotIn('f' * 40, signed)
            self.assertEqual(calls[index * 4 + 3].args[1], ['docker', 'image', 'inspect', producer['image']])
        receipt = json.loads((self.private / 'image-provenance.json').read_text())
        self.assertEqual(receipt, {'images': self.cfg['imageProducers'], 'buildkitVerified': True,
                                  'githubSignedProvenanceVerified': True, 'runtimeImageIdentityVerified': True, 'runtimeStarted': False})

    def test_changed_image_set_is_rejected_without_command(self):
        self.cfg['imageProducers'][0]['image'] = self.cfg['images'][1]
        with self.assertRaises(RuntimeError):
            self.ns['admit_images']()
        self.command.assert_not_called()

    def test_each_external_failure_stops_before_acceptance(self):
        for fail_at in range(8):
            with self.subTest(fail_at=fail_at):
                def execute(*args):
                    if self.command.call_count == fail_at + 1:
                        raise RuntimeError('synthetic admission failure')
                    return self.output(*args)
                self.command.reset_mock()
                self.command.side_effect = execute
                with self.assertRaisesRegex(RuntimeError, 'synthetic admission failure'):
                    self.ns['admit_images']()
                self.assertEqual(self.command.call_count, fail_at + 1)
                self.assertFalse((self.private / 'image-provenance.json').exists())

    def test_missing_or_cross_image_admission_never_starts_fixture(self):
        with self.assertRaises(RuntimeError):
            self.ns['start']()
        self.command.assert_not_called()
        (self.private / 'image-provenance.json').write_text(json.dumps({'images': [], 'buildkitVerified': True,
            'githubSignedProvenanceVerified': True, 'runtimeImageIdentityVerified': True, 'runtimeStarted': False}))
        with self.assertRaisesRegex(RuntimeError, 'admission missing'):
            self.ns['start']()
        self.command.assert_not_called()


    def test_each_oci_label_mismatch_prevents_admission_receipt(self):
        for key in source_labels('postgres', self.cfg['imageProducers'][0]['sourceSha']):
            with self.subTest(key=key):
                def changed(label, argv, *unused):
                    target = self.output(label, argv)
                    if label == 'image-labels-0':
                        value = json.loads(target.read_text())
                        value[0]['Config']['Labels'][key] = 'unreviewed'
                        target.write_text(json.dumps(value))
                    return target
                self.command.reset_mock()
                self.command.side_effect = changed
                with self.assertRaises(RuntimeError):
                    self.ns['admit_images']()
                self.assertFalse((self.private / 'image-provenance.json').exists())
                self.assertEqual(self.command.call_count, 4)


def source_labels(component, revision):
    return {'org.opencontainers.image.revision': revision,
            'org.opencontainers.image.source': 'https://github.com/liangzixuan/cronometer-gold',
            'org.opencontainers.image.title': 'cronometer-gold-' + component,
            'org.opencontainers.image.version': 'sha-' + revision}


class ExistingSourceContractTests(unittest.TestCase):
    def setUp(self):
        path = ROOT.parents[1] / 'infra/oci/files/image-admission.py'
        spec = importlib.util.spec_from_file_location('existing_image_admission', path)
        self.policy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.policy)

    def test_exact_existing_four_label_contract_is_reused_for_each_component(self):
        revision = 'a' * 40
        for variable, (_repository, component) in self.policy.REPOSITORY_IMAGES.items():
            config = {'Labels': source_labels(component, revision)}
            self.policy.require_repository_source_contract(variable, config, revision)
            for field in config['Labels']:
                with self.subTest(variable=variable, field=field), self.assertRaises(SystemExit):
                    self.policy.require_repository_source_contract(variable,
                        {'Labels': {**config['Labels'], field: 'wrong'}}, revision)

    def test_existing_inspection_still_checks_identity_then_runtime_for_every_image(self):
        revision = 'b' * 40
        expected = []
        def inspected(argv, variable):
            component = self.policy.REPOSITORY_IMAGES[variable][1]
            config = {'Labels': source_labels(component, revision)}
            expected.append((variable, config, revision))
            return [{'Os': 'linux', 'Architecture': 'arm64', 'Config': config}]
        with patch.object(self.policy, 'validate', return_value={key: key for key in self.policy.REPOSITORY_IMAGES}), \
                patch.object(self.policy, 'read_env', return_value={'SERVICE_VERSION': revision}), \
                patch.object(self.policy, 'command_json', side_effect=inspected), \
                patch.object(self.policy, 'require_repository_source_contract', wraps=self.policy.require_repository_source_contract) as identity, \
                patch.object(self.policy, 'require_repository_runtime_contract') as runtime:
            self.policy.inspect_images('unused', 'unused')
        self.assertEqual([call.args for call in identity.call_args_list], expected)
        self.assertEqual([call.args for call in runtime.call_args_list], [(v, config) for v, config, _revision in expected])


if __name__ == '__main__':
    unittest.main()
