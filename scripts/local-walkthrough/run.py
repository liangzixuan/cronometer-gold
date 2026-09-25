#!/usr/bin/env python3
"""Create and operate an explicitly selected, synthetic local walkthrough."""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from ownership import (
    WalkthroughError, assert_container_identity, assert_process_identity,
    container_identity, linux_directory, live_identity, operation_lock, read_private_json,
    require, stop_process, write_json,
)

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent.parent
IMAGES = {
    "postgres": "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
    "meilisearch": "getmeili/meilisearch:v1.32.0@sha256:61b1c86c459fa52d0653516f573702791e611574737dc76175ae9d2628c911f5",
}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_fingerprint():
    result = hashlib.sha256()
    roots = [ROOT / "apps/api/dist", *sorted((ROOT / "packages").glob("*/dist"))]
    for directory in roots:
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                result.update(str(path.relative_to(ROOT)).encode() + b"\0")
                result.update(path.read_bytes())
    result.update((ROOT / "pnpm-lock.yaml").read_bytes())
    return result.hexdigest()


def port(value):
    require(re.fullmatch(r"[1-9][0-9]*", str(value)) is not None,
            "Ports must be decimal integers.")
    parsed = int(value)
    require(1024 <= parsed <= 65535, "Ports must be between 1024 and 65535.")
    return parsed


def selected_ports(arguments):
    ports = {name: port(getattr(arguments, name + "_port"))
             for name in ("web", "api", "postgres", "meilisearch")}
    require(len(set(ports.values())) == 4, "Every service needs a different port.")
    return ports


def free_ports(ports):
    for value in ports:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", value))


def base_environment():
    # Do not inherit application/cloud credentials, NODE_OPTIONS, .env or Docker contexts.
    return {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": str(Path.home()), "LANG": "C.UTF-8"}


def executable(name):
    value = shutil.which(name)
    require(value is not None, "Install the documented prerequisite: " + name)
    return str(Path(value).resolve(strict=True))


def read_command(arguments, *, env=None, cwd=ROOT):
    result = subprocess.run(arguments, env=env or base_environment(), cwd=cwd,
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    require(result.returncode == 0, "Prerequisite command failed: " + Path(arguments[0]).name)
    return result.stdout


class Runtime:
    def __init__(self, directory):
        self.path = linux_directory(directory, private=True)
        self.state = read_private_json(self.path / "runtime.json")
        require(self.state.get("version") == 1 and self.state.get("syntheticOnly") is True
                and self.state.get("runtime") == str(self.path)
                and self.state.get("repository") == str(ROOT)
                and re.fullmatch(r"[a-f0-9]{16}", self.state.get("runId", "")) is not None,
                "Runtime identity does not match this checkout.")
        self.run_id = self.state["runId"]
        self.ports = self.state["ports"]
        require(set(self.ports) == {"web", "api", "postgres", "meilisearch"}
                and len(set(self.ports.values())) == 4
                and all(type(value) is int and port(value) == value for value in self.ports.values()),
                "Invalid runtime ports.")
        self.private = read_private_json(self.path / "private-env.json")
        require(self.private.get("WALKTHROUGH_RUN_ID") == self.run_id
                and self.private.get("WALKTHROUGH_EVIDENCE_DIR") == str(self.path)
                and self.private.get("API_HOST") == "127.0.0.1"
                and self.private.get("API_PORT") == str(self.ports["api"])
                and self.private.get("MEILI_URL") == f"http://127.0.0.1:{self.ports['meilisearch']}",
                "Private environment does not match its runtime.")
        self.base = base_environment()
        self.docker_env = {**self.base, "DOCKER_HOST": "unix:///var/run/docker.sock",
                           "DOCKER_CONFIG": str(self.path / "docker-config")}

    def docker(self, *arguments):
        return [self.state["docker"], *arguments]

    def compose(self, *arguments):
        require(digest(self.path / "compose.yaml") == self.state["composeSha256"],
                "Runtime Compose file changed.")
        return self.docker("compose", "--env-file", str(self.path / "compose.env"),
                           "-f", str(self.path / "compose.yaml"), *arguments)

    def command(self, label, arguments, *, env=None, cwd=ROOT, timeout=180):
        log = self.path / (label + "-" + secrets.token_hex(4) + ".log")
        receipt = {"label": label, "startedAt": now(), "argv": arguments,
                   "log": str(log), "exit": None}
        try:
            with log.open("xb") as output:
                child = subprocess.Popen(arguments, env={**(env or self.base),
                    "NOURISHING_WALKTHROUGH_OWNER": self.run_id}, cwd=cwd,
                    stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
                identity = live_identity(child.pid)
                process_record = {"identity": identity, "startedAt": now(), "log": str(log)}
                write_json(log.with_name(log.stem + "-process.json"), process_record)
                try:
                    receipt["exit"] = child.wait(timeout=timeout)
                except BaseException:
                    # Re-read after exec so the captured process can be stopped through its
                    # actual executable identity. A reused PID must never be adopted.
                    actual = live_identity(child.pid)
                    if actual is not None:
                        require(identity is not None and actual["startTicks"] == identity["startTicks"]
                                and actual["processGroup"] == child.pid,
                                "Timed-out command identity changed; inspect its private receipt.")
                        stop_process({"identity": actual}, self.run_id)
                        child.wait(timeout=1)
                    raise
            require(receipt["exit"] == 0, label + " failed; inspect its private log.")
        finally:
            receipt["endedAt"] = now()
            write_json(log.with_suffix(".json"), receipt)
            print(json.dumps(receipt), flush=True)

    def inspect(self, container_id):
        return container_identity(json.loads(read_command(
            self.docker("inspect", container_id), env=self.docker_env))[0])

    def owned_containers(self):
        records = read_private_json(self.path / "containers.json")
        require(type(records) is list and len(records) <= 2
                and len({item["id"] for item in records}) == len(records),
                "Invalid container inventory.")
        for record in records:
            assert_container_identity(record, self.inspect(record["id"]), self.run_id)
        return records

    def claim_containers(self):
        records = []
        ids = read_command(self.compose("ps", "-q", "--all"), env=self.docker_env).split()
        for container_id in ids:
            record = self.inspect(container_id)
            service = record["service"]
            require(service in IMAGES, "Unexpected service in the owned project.")
            expected_port = "5432/tcp" if service == "postgres" else "7700/tcp"
            require(record["project"] == "nourishing-walkthrough-" + self.run_id
                    and record["owner"] == self.run_id
                    and record["image"] == self.state["images"][service]
                    and record["ports"] == {expected_port: [{"HostIp": "127.0.0.1",
                                                             "HostPort": str(self.ports[service])}]}
                    and record["memory"] == 1_073_741_824
                    and record["memorySwap"] == 1_073_741_824
                    and record["nanoCpus"] == 1_000_000_000 and record["pidsLimit"] == 256,
                    "Created container does not match the pinned, bounded local contract.")
            records.append(record)
        write_json(self.path / "containers.json", records)
        return records

    def process_record(self, name):
        # Sequence-numbered receipts retain earlier process identities after restart.
        files = sorted(self.path.glob(name + "-process-*.json"))
        return read_private_json(files[-1]) if files else None

    def launch(self, name, arguments, env, cwd):
        previous = self.process_record(name)
        require(previous is None or live_identity(previous["identity"]["pid"]) is None,
                name + " already has a live recorded process; stop it first.")
        log = self.path / (name + "-" + secrets.token_hex(4) + ".log")
        with log.open("xb") as output:
            child = subprocess.Popen(arguments, env={**self.base, **env,
                "NOURISHING_WALKTHROUGH_OWNER": self.run_id}, cwd=cwd,
                stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
        identity = None
        for _ in range(100):
            identity = live_identity(child.pid)
            if identity is not None and identity["exe"] == self.state["node"]:
                break
            time.sleep(0.01)
        require(identity is not None and identity["exe"] == self.state["node"]
                and identity["cwd"] == str(cwd) and identity["processGroup"] == child.pid,
                name + " exited or did not acquire the expected identity.")
        number = len(list(self.path.glob(name + "-process-*.json"))) + 1
        write_json(self.path / f"{name}-process-{number:06d}.json",
                   {"identity": identity, "startedAt": now(), "log": str(log), "argv": arguments})

    def start_apps(self):
        containers = self.owned_containers()
        require(len(containers) == 2, "Both owned containers are required.")
        for record in containers:
            require(read_command(self.docker("inspect", "--format", "{{.State.Running}}", record["id"]),
                                 env=self.docker_env).strip() == "true",
                    "Owned containers are stopped; create a fresh runtime.")
        free_ports([self.ports["api"], self.ports["web"]])
        require((ROOT / "apps/web/.next/BUILD_ID").read_text().strip() == self.state["buildId"],
                "Web build changed; create a fresh runtime after validation.")
        require(build_fingerprint() == self.state["buildFingerprint"],
                "API/package build or lockfile changed; create a fresh runtime after validation.")
        api_fields = {key: value for key, value in self.private.items() if key not in (
            "MEILI_MASTER_KEY", "MEILI_ADMIN_KEY", "MEILI_TASK_OBSERVER_KEY",
            "WALKTHROUGH_API_ORIGIN", "WALKTHROUGH_FIXTURE_ONLY", "WALKTHROUGH_RUN_ID",
            "WALKTHROUGH_EVIDENCE_DIR", "DB_MIGRATIONS_DIR", "MEILI_PORT")}
        keys = dict(line.split("=", 1) for line in (self.path / "scoped-keys.env").read_text().splitlines())
        api_fields["MEILI_SEARCH_KEY"] = keys["MEILI_SEARCH_KEY"]
        self.launch("api", [self.state["node"], str(ROOT / "apps/api/dist/server.js")],
                    api_fields, self.path)
        ready(f"http://127.0.0.1:{self.ports['api']}/ready", api=True)
        web = self.path / "web/apps/web"
        self.launch("web", [self.state["node"], str(web / "server.js")],
                    {"NODE_ENV": "production", "HOSTNAME": "127.0.0.1", "PORT": str(self.ports["web"]),
                     "API_INTERNAL_URL": f"http://127.0.0.1:{self.ports['api']}",
                     "WEB_PUBLIC_ORIGIN": f"http://127.0.0.1:{self.ports['web']}",
                     "NEXT_TELEMETRY_DISABLED": "1"}, web)
        ready(f"http://127.0.0.1:{self.ports['web']}/login")

    def stop_apps(self):
        records = [self.process_record(name) for name in ("web", "api")]
        for record in records:
            if record and (actual := live_identity(record["identity"]["pid"])) is not None:
                assert_process_identity(record["identity"], actual)
        for record in records:
            if record:
                stop_process(record, self.run_id)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def ready(url, *, api=False):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            with opener.open(url, timeout=2) as response:
                if response.status == 200 and (not api or json.loads(response.read(128)) == {"status": "ok"}):
                    return
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    raise WalkthroughError("Readiness failed at the selected loopback service.")


def prepare(arguments):
    linux_directory(ROOT)
    ports = selected_ports(arguments)
    free_ports(ports.values())
    parent = linux_directory(arguments.runtime_parent)
    require(ROOT != parent and ROOT not in parent.parents,
            "Keep the runtime outside the application checkout.")
    node, docker = executable("node"), executable("docker")
    require(hasattr(os, "pidfd_open") and hasattr(__import__("signal"), "pidfd_send_signal"),
            "Linux pidfd support is required for safe process cleanup.")
    for relative in ("apps/api/dist/server.js", "apps/web/.next/standalone/apps/web/server.js",
                     "apps/web/.next/BUILD_ID", "packages/db/dist/cli.js", "node_modules/tsx/dist/cli.mjs"):
        require((ROOT / relative).is_file(), "Run the documented build first: missing " + relative)
    run_id = secrets.token_hex(8)
    path = Path(tempfile.mkdtemp(prefix="nourishing-walkthrough-", dir=parent))
    print(json.dumps({"runtime": str(path), "syntheticOnly": True}), flush=True)
    for name in ("docker-config", "exports", "spool"):
        (path / name).mkdir(mode=0o700)
    docker_env = {**base_environment(), "DOCKER_HOST": "unix:///var/run/docker.sock",
                  "DOCKER_CONFIG": str(path / "docker-config")}
    read_command([docker, "info", "--format", "{{.ID}}"], env=docker_env)
    read_command([docker, "compose", "version", "--short"], env=docker_env)
    images = {service: json.loads(read_command([docker, "image", "inspect", pin], env=docker_env))[0]["Id"]
              for service, pin in IMAGES.items()}
    require(not read_command([docker, "ps", "-aq", "--filter",
                "label=com.docker.compose.project=nourishing-walkthrough-" + run_id], env=docker_env).strip(),
            "The generated project name already exists.")
    password, master = secrets.token_hex(24), secrets.token_hex(32)
    shutil.copyfile(TOOLS / "compose.yaml", path / "compose.yaml")
    (path / "compose.env").write_text(f"WALKTHROUGH_RUN_ID={run_id}\nPOSTGRES_PASSWORD={password}\nMEILI_MASTER_KEY={master}\n"
        f"WALKTHROUGH_POSTGRES_PORT={ports['postgres']}\nWALKTHROUGH_MEILI_PORT={ports['meilisearch']}\n")
    b64 = lambda: base64.b64encode(secrets.token_bytes(32)).decode()
    private = {"WALKTHROUGH_RUN_ID": run_id, "WALKTHROUGH_FIXTURE_ONLY": "yes",
        "WALKTHROUGH_EVIDENCE_DIR": str(path),
        "WALKTHROUGH_API_ORIGIN": f"http://127.0.0.1:{ports['api']}",
        "DATABASE_URL": f"postgresql://walkthrough_owner:{password}@127.0.0.1:{ports['postgres']}/nourishing_walkthrough_{run_id}",
        "DATABASE_SSL_MODE": "disable", "DB_MIGRATIONS_DIR": str(ROOT / "packages/db/migrations"),
        "NODE_ENV": "development", "MEILI_URL": f"http://127.0.0.1:{ports['meilisearch']}",
        "MEILI_PORT": str(ports["meilisearch"]), "MEILI_MASTER_KEY": master,
        "API_HOST": "127.0.0.1", "API_PORT": str(ports["api"]), "RETENTION_FEATURES_ENABLED": "true",
        "SEARCH_CURSOR_SECRET": secrets.token_hex(32), "EXPORT_ARTIFACT_CURRENT_KEY_ID": "walkthrough-export-v1",
        "EXPORT_ARTIFACT_ENCRYPTION_KEYS": json.dumps({"walkthrough-export-v1": b64()}),
        "ERASURE_REPLAY_LEDGER_LOCATOR_CURRENT_KEY_ID": "walkthrough-locator-v1",
        "ERASURE_REPLAY_LEDGER_LOCATOR_HMAC_KEYS": json.dumps({"walkthrough-locator-v1": b64()}),
        "ERASURE_STATUS_CAPABILITY_HMAC_KEY": b64(), "DEVICE_CHALLENGE_HMAC_KEY": b64(),
        "EXPORT_ARTIFACT_STORE": "filesystem", "EXPORT_ARTIFACT_DIRECTORY": str(path / "exports"),
        "EXPORT_ARTIFACT_READ_SPOOL_DIR": str(path / "spool")}
    write_json(path / "private-env.json", private)
    write_json(path / "runtime.json", {"version": 1, "syntheticOnly": True, "createdAt": now(),
        "runtime": str(path), "repository": str(ROOT), "runId": run_id, "ports": ports,
        "node": node, "docker": docker, "images": images, "composeSha256": digest(path / "compose.yaml"),
        "buildId": (ROOT / "apps/web/.next/BUILD_ID").read_text().strip(),
        "buildFingerprint": build_fingerprint(),
        "head": read_command(["git", "rev-parse", "HEAD"]).strip(),
        "diffSha256": hashlib.sha256(read_command(["git", "diff", "--binary"]).encode()).hexdigest(),
        "status": read_command(["git", "status", "--short"]),
        "nodeVersion": read_command([node, "--version"]).strip()})
    shutil.copytree(ROOT / "apps/web/.next/standalone", path / "web", symlinks=True)
    shutil.copytree(ROOT / "apps/web/.next/static", path / "web/apps/web/.next/static", symlinks=True)
    for entry in (path / "web").rglob("*"):
        require(not entry.is_symlink() or entry.resolve().is_relative_to(path / "web"),
                "Standalone export contains an escaping symlink.")
    return Runtime(path)


def create(arguments):
    runtime = prepare(arguments)
    with operation_lock(runtime.path):
        populate_runtime(runtime)


def populate_runtime(runtime):
    try:
        try:
            runtime.command("dependencies", runtime.compose("up", "-d", "--pull", "never", "--wait",
                            "--wait-timeout", "120"), env=runtime.docker_env)
        finally:
            containers = runtime.claim_containers()
        require(len(containers) == 2, "Expected two owned containers.")
        private = runtime.private
        runtime.command("migrate", [runtime.state["node"], str(ROOT / "packages/db/dist/cli.js")],
                        env={**runtime.base, **{key: private[key] for key in (
                            "DATABASE_URL", "DATABASE_SSL_MODE", "DB_MIGRATIONS_DIR")}}, cwd=runtime.path)
        runtime.command("scoped-keys", [runtime.state["node"], str(ROOT / "scripts/scoped-meili-keys.mjs"),
                        "--output-file", str(runtime.path / "scoped-keys.env")],
                        env={**runtime.base, **{key: private[key] for key in (
                            "MEILI_URL", "MEILI_PORT", "MEILI_MASTER_KEY")}})
        keys = dict(line.split("=", 1) for line in (runtime.path / "scoped-keys.env").read_text().splitlines())
        fixture_env = {**runtime.base, **{key: value for key, value in private.items() if key != "MEILI_MASTER_KEY"}, **keys}
        runtime.command("catalogue", [runtime.state["node"], str(ROOT / "node_modules/tsx/dist/cli.mjs"),
                        str(TOOLS / "seed-catalogue.mts")], env=fixture_env)
        runtime.start_apps()
        runtime.command("account", [runtime.state["node"], str(TOOLS / "populate-account.mjs")],
                        env={**runtime.base, **{key: private[key] for key in (
                            "WALKTHROUGH_RUN_ID", "WALKTHROUGH_API_ORIGIN", "WALKTHROUGH_EVIDENCE_DIR")}})
        show_status(runtime)
    except BaseException:
        print(json.dumps({"failed": True, "runtime": str(runtime.path),
                          "action": "Inspect private receipts; use stop with this runtime. Partial data is retained."}), flush=True)
        raise


def show_status(runtime):
    processes = {}
    for name in ("api", "web"):
        record = runtime.process_record(name)
        actual = live_identity(record["identity"]["pid"]) if record else None
        processes[name] = "running" if record and actual == record["identity"] else "stopped-or-changed"
    catalogue = runtime.path / "synthetic-catalogue.json"
    print(json.dumps({"runtime": str(runtime.path), "syntheticOnly": True, "processes": processes,
        "web": f"http://127.0.0.1:{runtime.ports['web']}/login",
        "credentials": str(runtime.path / "walkthrough-account-credentials.json"),
        "fixtureExpiresAt": read_private_json(catalogue)["fixtureExpiresAt"] if catalogue.exists() else None}, indent=2))


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    actions = value.add_subparsers(dest="action", required=True)
    fresh = actions.add_parser("create", help="Opt in to new synthetic containers, account and applications")
    fresh.add_argument("--runtime-parent", required=True, help="Existing Linux directory outside the checkout")
    for name, default in (("web", 3287), ("api", 4287), ("postgres", 55488), ("meilisearch", 57788)):
        fresh.add_argument("--" + name + "-port", default=default)
    for action in ("status", "stop", "stop-apps", "start-apps", "restart-apps"):
        command = actions.add_parser(action)
        command.add_argument("--runtime", required=True, help="Exact private directory printed by create")
    return value


def operate(runtime, action):
    if action == "stop":
        records = runtime.owned_containers()  # Validate all identities before any mutation.
        runtime.stop_apps()
        for record in records:
            assert_container_identity(record, runtime.inspect(record["id"]), runtime.run_id)
            runtime.command("stop-container", runtime.docker("stop", "--time", "30", record["id"]), env=runtime.docker_env)
        print(json.dumps({"stopped": True, "runtime": str(runtime.path), "volumesRetained": True}))
    elif action == "stop-apps":
        runtime.stop_apps()
    else:
        if action == "restart-apps":
            runtime.stop_apps()
        runtime.start_apps()
        show_status(runtime)


def main():
    arguments = parser().parse_args()
    require(sys.platform == "linux" and os.getuid() != 0,
            "Run as the project user in Linux/WSL; do not use sudo.")
    os.umask(0o077)
    if arguments.action == "create":
        create(arguments)
        return
    runtime = Runtime(arguments.runtime)
    if arguments.action == "status":
        show_status(runtime)
        return
    with operation_lock(runtime.path):
        operate(runtime, arguments.action)


if __name__ == "__main__":
    try:
        main()
    except (WalkthroughError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        # Avoid emitting environment values, credentials, SQL or exception stacks.
        message = str(error) if isinstance(error, WalkthroughError) else type(error).__name__
        print(json.dumps({"failed": True, "reason": message}), file=sys.stderr)
        sys.exit(1)
