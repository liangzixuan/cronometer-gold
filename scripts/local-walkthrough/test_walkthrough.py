"""Offline regressions. No Docker, external network, process signals or application writes."""
from copy import deepcopy
import errno
import json
import os
from pathlib import Path
import socket
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


class PortProbeTests(unittest.TestCase):
    def test_probe_accepts_a_closed_reusable_connection_in_time_wait(self):
        with socket.socket() as listener, socket.socket() as client:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.settimeout(2)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            client.settimeout(2)
            client.connect(("127.0.0.1", port))
            with listener.accept()[0] as connection:
                connection.settimeout(2)
                connection.shutdown(socket.SHUT_WR)
                self.assertEqual(client.recv(1), b"")
                client.shutdown(socket.SHUT_WR)
                self.assertEqual(connection.recv(1), b"")
        states = [fields[3] for line in Path("/proc/net/tcp").read_text().splitlines()[1:]
                  if (fields := line.split())[1] == f"0100007F:{port:04X}"]
        self.assertIn("06", states)  # TCP_TIME_WAIT proves the connection is still retained.
        self.assertNotIn("0A", states)  # No TCP_LISTEN socket remains.
        run.free_ports([port])

    def test_probe_rejects_an_active_reusable_listener(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            with self.assertRaises(OSError) as rejected:
                run.free_ports([listener.getsockname()[1]])
            self.assertEqual(rejected.exception.errno, errno.EADDRINUSE)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.root = self.directory / "checkout"
        self.parent = self.directory / "runtimes"
        self.root.mkdir()
        self.parent.mkdir()
        self.assets = {name: (run.ROOT / "apps/web/public" / name).read_bytes() for name in (
            "fonts/fa-solid-900.woff2", "images/nutrients/protein.png")}
        files = {"apps/api/dist/server.js": b"offline-api",
                 "apps/web/.next/standalone/apps/web/server.js": b"offline-web",
                 "apps/web/.next/static/chunks/app.js": b"offline-static",
                 "apps/web/.next/BUILD_ID": b"offline-build",
                 "packages/db/dist/cli.js": b"offline-migrator",
                 "node_modules/tsx/dist/cli.mjs": b"offline-tsx",
                 "pnpm-lock.yaml": b"offline-lock",
                 **{"apps/web/public/" + name: data for name, data in self.assets.items()}}
        for name, data in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.arguments = run.parser().parse_args([
            "create", "--runtime-parent", str(self.parent)])

    def prepare(self):
        def prerequisite(arguments, **kwargs):
            if arguments[1:3] == ["image", "inspect"]:
                return json.dumps([{"Id": "sha256:" + "b" * 64, "RepoDigests": [arguments[-1]],
                                    "Os": "linux", "Architecture": "arm64", "Config": {}}])
            return "a" * 40 if arguments == ["git", "rev-parse", "HEAD"] else ""

        with patch.object(run, "ROOT", self.root), \
                patch.object(run, "free_ports"), \
                patch.object(run, "executable", side_effect=lambda name: "/offline/" + name), \
                patch.object(run, "read_command", side_effect=prerequisite), \
                patch.object(run.subprocess, "run", side_effect=AssertionError("No external commands")):
            return run.prepare(self.arguments)

    def test_prepare_exports_public_assets_with_standalone_and_static(self):
        (self.root / "apps/web/public/font.woff2").symlink_to("fonts/fa-solid-900.woff2")
        runtime = self.prepare()
        web = runtime.path / "web/apps/web"
        self.assertEqual((web / "server.js").read_bytes(), b"offline-web")
        self.assertEqual((web / ".next/static/chunks/app.js").read_bytes(), b"offline-static")
        for name, data in self.assets.items():
            with self.subTest(asset=name):
                self.assertTrue((web / "public" / name).is_file())
                self.assertEqual((web / "public" / name).read_bytes(), data)
        alias = web / "public/font.woff2"
        self.assertTrue(alias.is_symlink())
        self.assertEqual(alias.read_bytes(), self.assets["fonts/fa-solid-900.woff2"])

    def test_prepare_rejects_public_symlink_outside_export(self):
        outside = self.directory / "outside-asset"
        outside.write_bytes(b"outside-export")
        (self.root / "apps/web/public/escape").symlink_to(outside)
        with self.assertRaisesRegex(ownership.WalkthroughError, "escaping symlink"):
            self.prepare()
        self.assertEqual(outside.read_bytes(), b"outside-export")


    def test_ci_preparation_records_profile_pins_context_and_rendered_compose(self):
        self.arguments.image_profile = "ci-qualified-arm64"
        with patch.dict(os.environ, ImageProfileTests.CONTEXT, clear=True), \
                patch.object(run.platform, "machine", return_value="aarch64"), \
                patch.object(run, "runtime_image_contract") as admitted:
            runtime = self.prepare()
        self.assertEqual(admitted.call_args_list, [unittest.mock.call("postgres", {}),
                                                   unittest.mock.call("meilisearch", {})])
        self.assertEqual(runtime.state["version"], 2)
        self.assertEqual(runtime.state["imageProfile"], "ci-qualified-arm64")
        self.assertEqual(runtime.state["imagePins"], run.CI_IMAGES)
        self.assertEqual(runtime.state["imageContext"], ImageProfileTests.CONTEXT)
        self.assertEqual(runtime.state["images"], {key: "sha256:" + "b" * 64 for key in run.CI_IMAGES})
        self.assertEqual((runtime.path / "compose.yaml").read_bytes(), run.render_compose("ci-qualified-arm64"))
        self.assertEqual(runtime.state["composeSha256"], run.digest(runtime.path / "compose.yaml"))
        self.assertEqual(runtime.state["head"], "a" * 40)
        with patch.dict(os.environ, {**ImageProfileTests.CONTEXT, "GITHUB_RUN_ATTEMPT": "2"}, clear=True), \
                patch.object(run.platform, "machine", return_value="aarch64"), \
                patch.object(runtime, "owned_containers") as owned:
            with self.assertRaisesRegex(ownership.WalkthroughError, "another CI workflow"):
                runtime.start_apps()
            owned.assert_not_called()
        changed = {**runtime.state, "imagePins": {**run.CI_IMAGES, "postgres": run.IMAGES["postgres"]}}
        (runtime.path / "runtime.json").write_text(json.dumps(changed))
        with patch.object(run, "ROOT", self.root), self.assertRaisesRegex(ownership.WalkthroughError, "selected profile"):
            run.Runtime(runtime.path)


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



class ImageProfileTests(unittest.TestCase):
    CONTEXT = {
        "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
        "RUNNER_OS": "Linux", "RUNNER_ARCH": "ARM64",
        "GITHUB_REPOSITORY": "liangzixuan/cronometer-gold",
        "GITHUB_REF": "refs/heads/codex/retention-features", "GITHUB_EVENT_NAME": "push",
        "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "1234", "GITHUB_RUN_ATTEMPT": "1",
    }

    def test_local_default_is_explicit_and_does_not_require_ci(self):
        arguments = run.parser().parse_args(["create", "--runtime-parent", "/tmp"])
        self.assertEqual(arguments.image_profile, "local")
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(run.profile_context("local"))
        self.assertEqual(run.profile_images("local"), run.IMAGES)
        self.assertEqual(run.render_compose("local"), (run.TOOLS / "compose.yaml").read_bytes())

    def test_only_explicit_reviewed_profile_is_selectable(self):
        with patch("sys.stderr"), self.assertRaises(SystemExit):
            run.parser().parse_args(["create", "--runtime-parent", "/tmp", "--image-profile", "arbitrary"])
        with self.assertRaises(ownership.WalkthroughError):
            run.profile_images("arbitrary")

    def test_ci_requires_exact_hosted_arm_repository_branch_and_event(self):
        with patch.dict(os.environ, self.CONTEXT, clear=True), patch.object(run.platform, "machine", return_value="aarch64"):
            context = run.profile_context("ci-qualified-arm64")
        self.assertEqual(context, {key: self.CONTEXT[key] for key in run.CI_CONTEXT_KEYS})
        for key, value in (
            ("GITHUB_ACTIONS", "false"), ("RUNNER_ENVIRONMENT", "self-hosted"),
            ("RUNNER_OS", "Windows"), ("RUNNER_ARCH", "X64"),
            ("GITHUB_REPOSITORY", "someone/fork"), ("GITHUB_REF", "refs/pull/1/merge"),
            ("GITHUB_EVENT_NAME", "pull_request_target"), ("GITHUB_SHA", "short"),
            ("GITHUB_RUN_ID", "0"), ("GITHUB_RUN_ATTEMPT", "1;extra"),
        ):
            with self.subTest(key=key), patch.dict(os.environ, {**self.CONTEXT, key: value}, clear=True), \
                    patch.object(run.platform, "machine", return_value="aarch64"), \
                    self.assertRaises(ownership.WalkthroughError):
                run.profile_context("ci-qualified-arm64")
        with patch.dict(os.environ, self.CONTEXT, clear=True), patch.object(run.platform, "machine", return_value="x86_64"), \
                self.assertRaises(ownership.WalkthroughError):
            run.profile_context("ci-qualified-arm64")
        with patch.dict(os.environ, {**self.CONTEXT, "GITHUB_EVENT_NAME": "workflow_dispatch"}, clear=True), \
                patch.object(run.platform, "machine", return_value="aarch64"):
            self.assertEqual(run.profile_context("ci-qualified-arm64")["GITHUB_EVENT_NAME"], "workflow_dispatch")

    def test_rejected_ci_context_precedes_ports_docker_or_runtime_creation(self):
        arguments = run.parser().parse_args(["create", "--runtime-parent", "/tmp",
                                             "--image-profile", "ci-qualified-arm64"])
        with patch.dict(os.environ, {}, clear=True), patch.object(run, "free_ports") as ports, \
                patch.object(run, "read_command") as command, patch.object(run.tempfile, "mkdtemp") as temporary:
            with self.assertRaises(ownership.WalkthroughError):
                run.prepare(arguments)
        ports.assert_not_called()
        command.assert_not_called()
        temporary.assert_not_called()


    def test_ci_source_mismatch_precedes_docker_and_runtime_creation(self):
        arguments = run.parser().parse_args(["create", "--runtime-parent", "/tmp",
                                             "--image-profile", "ci-qualified-arm64"])
        with patch.dict(os.environ, self.CONTEXT, clear=True), \
                patch.object(run.platform, "machine", return_value="aarch64"), \
                patch.object(run, "read_command", return_value="b" * 40) as command, \
                patch.object(run.tempfile, "mkdtemp") as temporary:
            with self.assertRaisesRegex(ownership.WalkthroughError, "event source"):
                run.prepare(arguments)
        command.assert_called_once_with(["git", "rev-parse", "HEAD"])
        temporary.assert_not_called()

    def test_ci_claim_rejects_changed_container_user_or_scratch_mount_before_recording(self):
        runtime = run.Runtime.__new__(run.Runtime)
        runtime.profile = "ci-qualified-arm64"
        runtime.run_id = "test"
        runtime.path = Path("/offline")
        runtime.ports = {"postgres": 55488, "meilisearch": 57788}
        runtime.state = {"images": {"postgres": "sha256:postgres", "meilisearch": "sha256:meilisearch"}}
        runtime.docker_env = {}
        def record(service):
            port = "5432/tcp" if service == "postgres" else "7700/tcp"
            return {"id": service, "service": service, "project": "nourishing-walkthrough-test", "owner": "test",
                    "image": runtime.state["images"][service],
                    "ports": {port: [{"HostIp": "127.0.0.1", "HostPort": str(runtime.ports[service])}]},
                    "memory": 1073741824, "memorySwap": 1073741824, "nanoCpus": 1000000000, "pidsLimit": 256,
                    "user": "70:70" if service == "postgres" else "1000:1000",
                    "tmpfs": {} if service == "postgres" else {"/meili_data": run.CI_MEILI_TMPFS.split(":", 1)[1]}}
        records = [record("postgres"), record("meilisearch")]
        with patch.object(runtime, "compose", return_value=["offline"]), \
                patch.object(run, "read_command", return_value="postgres meilisearch"), \
                patch.object(runtime, "inspect", side_effect=records), patch.object(run, "write_json") as saved:
            self.assertEqual(runtime.claim_containers(), records)
            saved.assert_called_once_with(Path("/offline/containers.json"), records)
        for field, replacement in (("user", "0:0"), ("tmpfs", {}),
                                   ("tmpfs", {"/meili_data": "uid=0,gid=0,size=1g"})):
            with self.subTest(field=field, value=replacement), \
                    patch.object(runtime, "compose", return_value=["offline"]), \
                    patch.object(run, "read_command", return_value="postgres meilisearch"), \
                    patch.object(runtime, "inspect", side_effect=[records[0], {**records[1], field: replacement}]), \
                    patch.object(run, "write_json") as saved:
                with self.assertRaises(ownership.WalkthroughError):
                    runtime.claim_containers()
                saved.assert_not_called()

    def test_ci_render_changes_only_two_pins_and_owned_meili_scratch_mount(self):
        source = (run.TOOLS / "compose.yaml").read_bytes()
        rendered = run.render_compose("ci-qualified-arm64")
        for service, pin in run.CI_IMAGES.items():
            self.assertIn(pin, (run.ROOT / ".github/workflows/ci.yml").read_text())
            self.assertIn(("image: " + pin).encode(), rendered)
            rendered = rendered.replace(pin.encode(), run.IMAGES[service].encode())
        rendered = rendered.replace(
            ('    tmpfs:\n      - "' + run.CI_MEILI_TMPFS + '"\n').encode(),
            b"    volumes:\n      - meilisearch-data:/meili_data\n")
        self.assertEqual(rendered, source)

    def test_ci_inspection_requires_exact_pin_platform_id_and_existing_runtime_policy(self):
        pin = run.CI_IMAGES["postgres"]
        record = {"Id": "sha256:" + "b" * 64, "RepoDigests": [pin],
                  "Os": "linux", "Architecture": "arm64", "Config": {"marker": "fixture"}}
        with patch.object(run, "runtime_image_contract") as contract:
            self.assertEqual(run.admit_image("ci-qualified-arm64", "postgres", pin, [record]), record["Id"])
            contract.assert_called_once_with("postgres", record["Config"])
        for field, value in (("Id", "sha256:short"), ("RepoDigests", []),
                             ("Os", "windows"), ("Architecture", "amd64")):
            with self.subTest(field=field), patch.object(run, "runtime_image_contract") as contract:
                with self.assertRaises(ownership.WalkthroughError):
                    run.admit_image("ci-qualified-arm64", "postgres", pin, [{**record, field: value}])
                contract.assert_not_called()
        with self.assertRaises(ownership.WalkthroughError):
            run.admit_image("ci-qualified-arm64", "postgres", pin, [record, record])
        with self.assertRaises(ownership.WalkthroughError):
            run.runtime_image_contract("postgres", {})

    def test_runtime_inspection_retains_uid_and_tmpfs_in_ownership_fingerprint(self):
        runtime = run.Runtime.__new__(run.Runtime)
        runtime.state = {"docker": "/offline/docker"}
        runtime.docker_env = {}
        fixture = {"Id": "id", "Name": "/owned", "Image": "sha256:fixture",
                   "Config": {"Labels": {}, "User": "1000:1000"},
                   "HostConfig": {"PortBindings": {}, "Memory": 1073741824,
                                  "MemorySwap": 1073741824, "NanoCpus": 1000000000,
                                  "PidsLimit": 256, "Tmpfs": {"/meili_data": "uid=1000,gid=1000,mode=0700,size=512m"}}}
        with patch.object(run, "read_command", return_value=json.dumps([fixture])):
            record = runtime.inspect("id")
        self.assertEqual(record["user"], "1000:1000")
        self.assertEqual(record["tmpfs"], fixture["HostConfig"]["Tmpfs"])


if __name__ == "__main__":
    unittest.main()
