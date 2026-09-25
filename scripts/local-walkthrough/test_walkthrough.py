"""Offline regressions. No Docker, network, process signals or application writes."""
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import ownership
import run


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.directory.chmod(0o700)
        self.addCleanup(self.temporary.cleanup)
        self.identity = {"pid": 12345, "startTicks": "98765", "processGroup": 12345,
                         "uid": os.getuid(), "cwd": str(self.directory), "exe": "/test/node"}

    def test_private_state_roundtrip_and_no_overwrite(self):
        path = self.directory / "state.json"
        ownership.write_json(path, {"syntheticOnly": True})
        self.assertEqual(ownership.read_private_json(path), {"syntheticOnly": True})
        with self.assertRaises(FileExistsError):
            ownership.write_json(path, {"replace": True})

    def test_state_rejects_symlinks_hardlinks_and_public_mode(self):
        path = self.directory / "state.json"
        ownership.write_json(path, {"syntheticOnly": True})
        link = self.directory / "link.json"
        link.symlink_to(path)
        with self.assertRaises(OSError):
            ownership.read_private_json(link)
        link.unlink()
        os.link(path, link)
        with self.assertRaises(ownership.WalkthroughError):
            ownership.read_private_json(path)
        link.unlink()
        path.chmod(0o644)
        with self.assertRaises(ownership.WalkthroughError):
            ownership.read_private_json(path)

    def test_runtime_path_rejects_symlink_traversal_and_mounts(self):
        link = self.directory / "linked"
        link.symlink_to(self.directory, target_is_directory=True)
        for candidate in (str(link), str(self.directory) + "/../" + self.directory.name, "/mnt"):
            with self.subTest(candidate=candidate), self.assertRaises(ownership.WalkthroughError):
                ownership.linux_directory(candidate)

    def test_private_directory_permissions_required(self):
        self.directory.chmod(0o755)
        with self.assertRaises(ownership.WalkthroughError):
            ownership.linux_directory(self.directory, private=True)

    def test_concurrent_operation_is_rejected(self):
        with ownership.operation_lock(self.directory):
            with self.assertRaises(ownership.WalkthroughError):
                with ownership.operation_lock(self.directory):
                    self.fail("Second writer acquired the lock")

    def test_all_identity_fields_are_required_before_signaling(self):
        for field, replacement in (("startTicks", "changed"), ("cwd", "/elsewhere"),
                                   ("exe", "/other/node"), ("processGroup", 12), ("uid", -1)):
            actual = {**self.identity, field: replacement}
            with self.subTest(field=field), self.assertRaises(ownership.WalkthroughError):
                ownership.assert_process_identity(self.identity, actual)

    def test_changed_pid_is_never_signaled(self):
        with patch.object(ownership, "live_identity", return_value={**self.identity, "startTicks": "reused"}), \
                patch.object(ownership, "group_members", return_value=[12345]), \
                patch.object(ownership.os, "pidfd_open") as opened, \
                patch.object(ownership.signal, "pidfd_send_signal") as sent:
            with self.assertRaises(ownership.WalkthroughError):
                ownership.stop_process({"identity": self.identity}, "demo")
            opened.assert_not_called()
            sent.assert_not_called()

    def test_unowned_group_member_aborts_before_any_signal(self):
        child = {**self.identity, "pid": 12346}
        with patch.object(ownership, "live_identity", side_effect=[self.identity, self.identity, child]), \
                patch.object(ownership, "group_members", return_value=[12345, 12346]), \
                patch.object(ownership, "process_has_owner", side_effect=[True, False]), \
                patch.object(ownership.os, "pidfd_open", side_effect=[80, 81]), \
                patch.object(ownership.os, "close") as closed, \
                patch.object(ownership.signal, "pidfd_send_signal") as sent:
            with self.assertRaises(ownership.WalkthroughError):
                ownership.stop_process({"identity": self.identity}, "demo")
            sent.assert_not_called()
            self.assertEqual(closed.call_count, 2)

    def test_process_replaced_during_pidfd_capture_aborts(self):
        with patch.object(ownership, "live_identity", side_effect=[self.identity, self.identity,
                    {**self.identity, "startTicks": "replacement"}]), \
                patch.object(ownership, "group_members", return_value=[12345]), \
                patch.object(ownership, "process_has_owner", return_value=True), \
                patch.object(ownership.os, "pidfd_open", return_value=80), \
                patch.object(ownership.os, "close"), \
                patch.object(ownership.signal, "pidfd_send_signal") as sent:
            with self.assertRaises(ownership.WalkthroughError):
                ownership.stop_process({"identity": self.identity}, "demo")
            sent.assert_not_called()

    def test_owned_group_uses_pinned_handles_and_graceful_signal(self):
        with patch.object(ownership, "live_identity", return_value=self.identity), \
                patch.object(ownership, "group_members", side_effect=[[12345], []]), \
                patch.object(ownership, "process_has_owner", return_value=True), \
                patch.object(ownership.os, "pidfd_open", return_value=80), \
                patch.object(ownership.os, "close") as closed, \
                patch.object(ownership.signal, "pidfd_send_signal") as sent:
            ownership.stop_process({"identity": self.identity}, "demo")
            sent.assert_called_once_with(80, ownership.signal.SIGTERM)
            closed.assert_called_once_with(80)

    def test_missing_leader_does_not_abandon_an_existing_group(self):
        with patch.object(ownership, "live_identity", return_value=None), \
                patch.object(ownership, "group_members", return_value=[12346]), \
                patch.object(ownership.signal, "pidfd_send_signal") as sent:
            with self.assertRaises(ownership.WalkthroughError):
                ownership.stop_process({"identity": self.identity}, "demo")
            sent.assert_not_called()

    def test_container_replacement_and_foreign_labels_are_rejected(self):
        expected = {"id": "abc", "name": "/walkthrough", "image": "sha256:123",
                    "project": "nourishing-walkthrough-demo", "service": "postgres", "owner": "demo",
                    "ports": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "55488"}]}}
        ownership.assert_container_identity(expected, deepcopy(expected), "demo")
        for field in expected:
            changed = {**expected, field: "unrelated"}
            with self.subTest(field=field), self.assertRaises(ownership.WalkthroughError):
                ownership.assert_container_identity(expected, changed, "demo")


class InterfaceTests(unittest.TestCase):
    def test_fresh_creation_requires_explicit_action_and_parent(self):
        for arguments in ([], ["create"], ["stop"], ["restart-apps"]):
            with self.subTest(arguments=arguments), patch("sys.stderr"), self.assertRaises(SystemExit):
                run.parser().parse_args(arguments)

    def test_rejects_duplicate_and_nonlocal_service_ports(self):
        for invalid in ("0", "80", "65536", "-1", "12.5", "01234", "1234;rm"):
            with self.subTest(invalid=invalid), self.assertRaises(ownership.WalkthroughError):
                run.port(invalid)
        args = run.parser().parse_args(["create", "--runtime-parent", "/tmp", "--api-port", "3287"])
        with self.assertRaises(ownership.WalkthroughError):
            run.selected_ports(args)

    def test_child_environment_does_not_inherit_credentials_or_injected_node_code(self):
        with patch.dict(os.environ, {"DATABASE_URL": "private", "AWS_SECRET_ACCESS_KEY": "private",
                                     "NODE_OPTIONS": "--require /malicious", "DOCKER_HOST": "tcp://remote"}):
            self.assertEqual(set(run.base_environment()), {"PATH", "HOME", "LANG"})

    def test_migration_cannot_load_the_checkout_dotenv(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "scoped-keys.env").write_text("MEILI_SEARCH_KEY=synthetic\n")
            private = {key: "synthetic-" + key for key in (
                "DATABASE_URL", "DATABASE_SSL_MODE", "DB_MIGRATIONS_DIR", "MEILI_URL",
                "MEILI_PORT", "MEILI_MASTER_KEY", "WALKTHROUGH_RUN_ID",
                "WALKTHROUGH_API_ORIGIN", "WALKTHROUGH_EVIDENCE_DIR")}
            runtime = Mock(path=directory, state={"node": "/runtime/node"}, private=private,
                           base={"PATH": "/runtime/bin"}, docker_env={})
            runtime.claim_containers.return_value = [{"id": "postgres"}, {"id": "search"}]
            with patch.object(run, "show_status"):
                run.populate_runtime(runtime)
            migrations = [call for call in runtime.command.call_args_list
                          if call.args[0] == "migrate"]
            self.assertEqual(len(migrations), 1)
            self.assertEqual(migrations[0].args, ("migrate", [
                "/runtime/node", str(run.ROOT / "packages/db/dist/cli.js")]))
            self.assertEqual(migrations[0].kwargs, {
                "cwd": directory,
                "env": {**runtime.base, **{key: private[key] for key in (
                    "DATABASE_URL", "DATABASE_SSL_MODE", "DB_MIGRATIONS_DIR")}},
            })

    def test_compose_contract_keeps_pins_loopback_and_resources(self):
        source = (Path(__file__).parent / "compose.yaml").read_text()
        for image in run.IMAGES.values():
            self.assertIn("image: " + image, source)
        self.assertEqual(source.count("pull_policy: never"), 2)
        self.assertEqual(source.count("mem_limit: 1g"), 2)
        self.assertEqual(source.count("memswap_limit: 1g"), 2)
        self.assertEqual(source.count("pids_limit: 256"), 2)
        self.assertEqual(source.count('restart: "no"'), 2)
        self.assertEqual(source.count('"127.0.0.1:${WALKTHROUGH_'), 2)


if __name__ == "__main__":
    unittest.main()
