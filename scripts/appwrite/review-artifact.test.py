import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import subprocess
import sys
import time
from unittest.mock import patch
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("review_artifact", Path(__file__).with_name("review-artifact.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
REVISION = "a" * 40


def archive(files=None, mode=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as result:
        for name, data in files or [("qualification.json", b'{"signed":"fixture"}')]:
            info = zipfile.ZipInfo(name)
            if mode:
                info.external_attr = mode << 16
            result.writestr(info, data)
    return output.getvalue()


def metadata(data):
    return {"id": 12, "expired": False, "size_in_bytes": len(data),
            "url": f"https://api.github.com/repos/{module.REPOSITORY}/actions/artifacts/12",
            "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
            "workflow_run": {"head_sha": REVISION, "head_branch": module.BRANCH,
                             "repository_id": 7, "head_repository_id": 7}}


class ReviewArtifactTests(unittest.TestCase):
    def test_bounded_transport_reaps_children_on_overflow_timeout_and_early_pipe_close(self):
        original = subprocess.Popen
        for script, limit in [("import sys;sys.stdout.write('x'*100);sys.stdout.flush();__import__('time').sleep(30)", 8),
                              ("__import__('time').sleep(30)", 8),
                              ("import os;os.close(1);__import__('time').sleep(30)", 8)]:
            children = []
            def local_process(command, **kwargs):
                child = original([sys.executable, "-c", script], **kwargs)
                children.append(child)
                return child
            with patch.object(module.subprocess, "Popen", local_process), patch.object(module, "COMMAND_SECONDS", 0.15):
                with self.assertRaises((module.AdmissionError, subprocess.TimeoutExpired)):
                    module.bounded_gh("/fixture", limit)
            self.assertEqual(len(children), 1)
            self.assertIsNotNone(children[0].poll())
            self.assertTrue(children[0].stdout.closed)

    def test_exited_leader_cannot_leave_descendant_holding_stdout(self):
        original = subprocess.Popen
        with tempfile.TemporaryDirectory() as temp:
            pidfile = str(Path(temp) / "descendant-pid")
            script = 'import subprocess,sys;from pathlib import Path;p=subprocess.Popen([sys.executable,\'-c\',"__import__(\'time\').sleep(30)"]);Path(sys.argv[1]).write_text(str(p.pid))'
            def local_process(command, **kwargs):
                return original([sys.executable, "-c", script, pidfile], **kwargs)
            with patch.object(module.subprocess, "Popen", local_process), patch.object(module, "COMMAND_SECONDS", 0.3):
                with self.assertRaises(module.AdmissionError):
                    module.bounded_gh("/fixture", 8)
            pid = int(Path(pidfile).read_text())
            state = Path(f"/proc/{pid}/stat")
            for _ in range(100):
                if not state.exists() or state.read_text().split()[2] == "Z":
                    break
                time.sleep(0.01)
            self.assertTrue(not state.exists() or state.read_text().split()[2] == "Z")

    def test_valid_archive_is_only_inert_json_not_acceptance(self):
        data = archive()
        self.assertEqual(set(module.review_files(data, hashlib.sha256(data).hexdigest(),
                                                "prepare", "staging")), {"qualification.json"})

    def test_wrong_digest_rejected(self):
        with self.assertRaises(module.AdmissionError):
            module.review_files(archive(), "0" * 64, "prepare", "staging")

    def test_archive_path_and_type_rejected(self):
        for name, mode in [("../qualification.json", None), ("run.py", None),
                           ("qualification.json", stat.S_IFLNK | 0o777)]:
            with self.subTest(name=name, mode=mode), self.assertRaises(module.AdmissionError):
                data = archive([(name, b"{}")], mode)
                module.review_files(data, hashlib.sha256(data).hexdigest(), "prepare", "staging")

    def test_duplicate_file_and_json_keys_rejected(self):
        for entries in [[("qualification.json", b"{}")] * 2,
                        [("qualification.json", b'{"a":1,"a":2}')]]:
            with self.assertRaises(module.AdmissionError):
                data = archive(entries)
                module.review_files(data, hashlib.sha256(data).hexdigest(), "prepare", "staging")

    def test_oversized_decompressed_file_rejected(self):
        data = archive([("qualification.json", b" " * (module.FILE_LIMIT + 1))])
        with self.assertRaises(module.AdmissionError):
            module.review_files(data, hashlib.sha256(data).hexdigest(), "prepare", "staging")

    def test_candidate_required_only_on_activation(self):
        data = archive()
        with self.assertRaises(module.AdmissionError):
            module.review_files(data, hashlib.sha256(data).hexdigest(), "activate", "staging")

    def test_production_requires_actual_staging_comparison_inputs(self):
        entries = [(name, b"{}") for name in module.NAMES]
        data = archive(entries)
        self.assertEqual(len(module.review_files(data, hashlib.sha256(data).hexdigest(),
                                                "activate", "production")), 4)

    def test_expired_foreign_head_or_fork_rejected_before_archive_fetch(self):
        for change in ["expired", "head_sha", "head_repository_id", "head_branch", "digest", "size"]:
            data = archive()
            row = metadata(data)
            if change == "expired":
                row["expired"] = True
            elif change == "digest":
                row["digest"] = None
            elif change == "size":
                row["size_in_bytes"] = module.ARCHIVE_LIMIT + 1
            else:
                row["workflow_run"][change] = "wrong"
            calls = []
            def fetch(path, limit):
                calls.append(path)
                return json.dumps(row).encode()
            with tempfile.TemporaryDirectory() as temp, self.assertRaises(module.AdmissionError):
                module.download(12, REVISION, "prepare", "staging", str(Path(temp) / "out"), fetch)
            self.assertEqual(len(calls), 1)

    def test_all_files_validated_before_writing_and_private_modes(self):
        for body, valid in [(b"not-json", False), (b"{}", True)]:
            data = archive([("qualification.json", body)])
            row = metadata(data)
            def fetch(path, limit):
                return data if path.endswith("/zip") else json.dumps(row).encode()
            with tempfile.TemporaryDirectory() as temp:
                output = Path(temp) / "out"
                if not valid:
                    with self.assertRaises(module.AdmissionError):
                        module.download(12, REVISION, "prepare", "staging", str(output), fetch)
                    self.assertFalse(output.exists())
                else:
                    module.download(12, REVISION, "prepare", "staging", str(output), fetch)
                    self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
                    self.assertEqual(stat.S_IMODE((output / "qualification.json").stat().st_mode), 0o600)
                    with self.assertRaises(module.AdmissionError):
                        module.download(12, REVISION, "prepare", "staging", str(output), fetch)


if __name__ == "__main__":
    unittest.main()
