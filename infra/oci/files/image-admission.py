#!/usr/bin/python3
"""Fail-closed runtime image lock and pulled-image admission checks."""

import json
import pathlib
import re
import subprocess
import sys


EXTERNAL = {
    "MEILI_IMAGE": "docker.io/getmeili/meilisearch",
}
REPOSITORY_IMAGES = {
    "CADDY_IMAGE": ("ghcr.io/liangzixuan/cronometer-gold-caddy", "caddy"),
    "POSTGRES_IMAGE": ("ghcr.io/liangzixuan/cronometer-gold-postgres", "postgres"),
    "API_IMAGE": ("ghcr.io/liangzixuan/cronometer-gold-api", "api"),
    "WEB_IMAGE": ("ghcr.io/liangzixuan/cronometer-gold-web", "web"),
    "WORKER_IMAGE": ("ghcr.io/liangzixuan/cronometer-gold-worker", "worker"),
    "MIGRATOR_IMAGE": ("ghcr.io/liangzixuan/cronometer-gold-migrator", "migrator"),
}
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
REFERENCE = re.compile(r"[^@\s]+@sha256:[0-9a-f]{64}")

APP_RUNTIME_LABELS = {
    "io.cronometer.runtime.contract": (
        "distroless-node22-debian13-uid-gid-1000-empty-entrypoint"
    ),
    "io.cronometer.upstream.image": "gcr.io/distroless/nodejs22-debian13:nonroot",
    "io.cronometer.upstream.image.digest": (
        "sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167"
    ),
    "io.cronometer.upstream.node.version": "22.23.2",
    "io.cronometer.upstream.signature.identity": (
        "keyless@distroless.iam.gserviceaccount.com"
    ),
    "io.cronometer.upstream.signature.issuer": "https://accounts.google.com",
}
APP_RUNTIME_ENVIRONMENT = {
    "HOME=/home/node",
    "NODE_ENV=production",
    "PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
}
APP_RUNTIME_CONTRACTS = {
    "API_IMAGE": {
        "component": "api",
        "cmd": ["/nodejs/bin/node", "--enable-source-maps", "dist/server.js"],
        "ports": {"3001/tcp": {}},
        "environment": APP_RUNTIME_ENVIRONMENT | {
            "API_HOST=0.0.0.0",
            "API_PORT=3001",
        },
        "healthcheck": {
            "Test": [
                "CMD",
                "/nodejs/bin/node",
                "-e",
                (
                    "fetch('http://127.0.0.1:' + (process.env.API_PORT || '3001') + "
                    "'/ready').then((response) => { if (!response.ok) process.exit(1) })"
                    ".catch(() => process.exit(1))"
                ),
            ],
            "Interval": 30_000_000_000,
            "Timeout": 5_000_000_000,
            "StartPeriod": 30_000_000_000,
            "Retries": 3,
        },
    },
    "WORKER_IMAGE": {
        "component": "worker",
        "cmd": ["/nodejs/bin/node", "--enable-source-maps", "dist/index.js"],
        "ports": None,
        "environment": APP_RUNTIME_ENVIRONMENT,
        "healthcheck": {
            "Test": ["CMD", "/nodejs/bin/node", "dist/database-readiness-probe.js"],
            "Interval": 60_000_000_000,
            "Timeout": 10_000_000_000,
            "StartPeriod": 30_000_000_000,
            "Retries": 3,
        },
    },
    "MIGRATOR_IMAGE": {
        "component": "migrator",
        "cmd": ["/nodejs/bin/node", "--enable-source-maps", "dist/cli.js"],
        "ports": None,
        "environment": APP_RUNTIME_ENVIRONMENT,
        "healthcheck": {"Test": ["NONE"]},
    },
    "WEB_IMAGE": {
        "component": "web",
        "cmd": ["/nodejs/bin/node", "apps/web/server.js"],
        "ports": {"3000/tcp": {}},
        "environment": APP_RUNTIME_ENVIRONMENT | {
            "HOSTNAME=0.0.0.0",
            "NEXT_TELEMETRY_DISABLED=1",
            "PORT=3000",
        },
        "healthcheck": {
            "Test": [
                "CMD",
                "/nodejs/bin/node",
                "-e",
                (
                    "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + "
                    "'/').then((response) => { if (!response.ok) process.exit(1) })"
                    ".catch(() => process.exit(1))"
                ),
            ],
            "Interval": 30_000_000_000,
            "Timeout": 5_000_000_000,
            "StartPeriod": 30_000_000_000,
            "Retries": 3,
        },
    },
}


def fail(message):
    raise SystemExit(message)


def read_env(filename):
    values = {}
    for number, raw in enumerate(pathlib.Path(filename).read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        key, separator, value = raw.partition("=")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in values:
            fail(f"Invalid or duplicate environment entry at {filename}:{number}")
        values[key] = value
    return values


def load_lock(filename):
    lock = json.loads(pathlib.Path(filename).read_text(encoding="utf-8"))
    if set(lock) != {"schemaVersion", "sourceLockSha256", "reviewedAt", "policy", "images"}:
        fail("External runtime-lock projection has unexpected top-level fields")
    if lock["schemaVersion"] != 1 or not re.fullmatch(r"[0-9a-f]{64}", lock["sourceLockSha256"]):
        fail("External runtime-lock projection schema or source digest is invalid")
    policy = lock["policy"]
    if set(policy) != {
        "platform", "scanner", "scannerVersion", "databaseUpdatedAt", "severities",
        "includeUnfixed", "ignorePolicy",
    } or (
        policy["platform"], policy["scanner"], policy["scannerVersion"],
        policy["severities"], policy["includeUnfixed"], policy["ignorePolicy"],
    ) != ("linux/arm64", "Trivy", "v0.74.0", ["HIGH", "CRITICAL"], True, "explicit-empty"):
        fail("External image lock scan policy is not the reviewed policy")
    if set(lock["images"]) != set(EXTERNAL):
        fail("External image lock has an unexpected image set")
    return lock


def validate(deploy_file, lock_file):
    deploy = read_env(deploy_file)
    lock = load_lock(lock_file)
    blocked = []
    for variable, repository in EXTERNAL.items():
        image = lock["images"][variable]
        if set(image) != {
            "repository", "version", "platform", "digest", "arm64Digest", "ref",
            "approved", "scan",
        }:
            fail(f"{variable} has unexpected lock fields")
        scan = image["scan"]
        if (
            image["repository"] != repository
            or image["platform"] != "linux/arm64"
            or not isinstance(image["version"], str)
            or not image["version"]
            or not DIGEST.fullmatch(image["digest"])
            or not DIGEST.fullmatch(image["arm64Digest"])
            or image["ref"] != f'{repository}@{image["digest"]}'
            or deploy.get(variable) != image["ref"]
        ):
            fail(f"{variable} does not exactly match its reviewed repository, platform, and digests")
        if set(scan) != {"critical", "high", "total", "result"} or any(
            type(scan.get(key)) is not int or scan[key] < 0 for key in ("critical", "high", "total")
        ) or scan["total"] != scan["critical"] + scan["high"]:
            fail(f"{variable} vulnerability evidence is invalid")
        if image["approved"] is not True or scan != {
            "critical": 0, "high": 0, "total": 0, "result": "passed",
        }:
            blocked.append(f'{variable} ({scan["critical"]} critical, {scan["high"]} high)')

    for variable, (repository, _component) in REPOSITORY_IMAGES.items():
        reference = deploy.get(variable, "")
        if not REFERENCE.fullmatch(reference) or not reference.startswith(f"{repository}@"):
            fail(f"{variable} must use its exact GHCR package at an immutable digest")
    if blocked:
        fail("External dependency admission is blocked: " + "; ".join(blocked))
    return deploy, lock


def command_json(arguments, description):
    try:
        return json.loads(subprocess.check_output(arguments, text=True, stderr=subprocess.DEVNULL))
    except (subprocess.CalledProcessError, json.JSONDecodeError) as error:
        fail(f"Could not inspect {description}: {error}")


def require_repository_runtime_contract(variable, config):
    labels = config.get("Labels") or {}
    environment_entries = config.get("Env") or []
    if not isinstance(environment_entries, list) or any(
        not isinstance(entry, str) for entry in environment_entries
    ):
        fail(f"{variable} environment differs from the reviewed runtime contract")
    environment = set(environment_entries)
    if variable in APP_RUNTIME_CONTRACTS:
        contract = APP_RUNTIME_CONTRACTS[variable]
        exact = {
            "User": "1000:1000",
            "Cmd": contract["cmd"],
            "WorkingDir": "/app",
            "Volumes": None,
            "StopSignal": None,
            "Shell": None,
            "ExposedPorts": contract["ports"],
            "Healthcheck": contract["healthcheck"],
        }
        expected_labels = APP_RUNTIME_LABELS | {
            "io.cronometer.runtime.component": contract["component"],
        }
        expected_environment = contract["environment"]
        if config.get("Entrypoint") not in (None, []):
            fail(f"{variable} process identity or filesystem contract differs from the reviewed runtime")
        if len(environment_entries) != len(expected_environment) or environment != expected_environment:
            fail(f"{variable} environment differs from the reviewed runtime contract")
    elif variable == "CADDY_IMAGE":
        exact = {
            "User": "1000:1000",
            "Entrypoint": ["/usr/bin/caddy"],
            "Cmd": ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
            "WorkingDir": "/srv",
            "Volumes": {"/config": {}, "/data": {}},
            "ExposedPorts": {"2019/tcp": {}, "443/tcp": {}, "443/udp": {}, "80/tcp": {}},
        }
        expected_labels = {
            "io.cronometer.runtime.component": "caddy",
            "io.cronometer.runtime.contract": "uid-gid-1000-net-bind-service",
            "io.cronometer.upstream.source": "https://github.com/caddyserver/caddy",
            "io.cronometer.upstream.source.revision": "e2eee6a7fce366321294c9c2a79f3146891dcbdf",
            "io.cronometer.upstream.source.tag-object": "8ec11a4b7e39a5fd00da2fc5cb9b543e31fd7926",
            "io.cronometer.upstream.version": "v2.11.4",
            "io.cronometer.upstream.vulnerability-patches": "golang.org/x/net=v0.56.0,golang.org/x/text=v0.39.0,google.golang.org/grpc=v1.82.1",
        }
        expected_environment = {
            "HOME=/home/caddy",
            "PATH=/usr/bin",
            "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
            "XDG_CONFIG_HOME=/config",
            "XDG_DATA_HOME=/data",
        }
    elif variable == "POSTGRES_IMAGE":
        exact = {
            "User": "70:70",
            "Entrypoint": ["docker-entrypoint.sh"],
            "Cmd": ["postgres"],
            "StopSignal": "SIGINT",
            "Volumes": {"/var/lib/postgresql/data": {}},
            "ExposedPorts": {"5432/tcp": {}},
        }
        expected_labels = {
            "io.cronometer.runtime.component": "postgres",
            "io.cronometer.runtime.contract": "uid-gid-70-preowned-pgdata-and-tmpfs",
            "io.cronometer.upstream.image": "docker.io/library/postgres:17.11-alpine3.24",
            "io.cronometer.upstream.image.digest": "sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73",
            "io.cronometer.upstream.version": "17.11",
        }
        expected_environment = {
            "GOSU_VERSION=",
            "PGDATA=/var/lib/postgresql/data",
            "PG_VERSION=17.11",
        }
        healthcheck = (config.get("Healthcheck") or {}).get("Test") or []
        if not healthcheck or healthcheck[0] != "CMD-SHELL":
            fail("POSTGRES_IMAGE healthcheck differs from the repository runtime contract")
    else:
        return
    if any(config.get(key) != value for key, value in exact.items()):
        fail(f"{variable} process identity or filesystem contract differs from the reviewed runtime")
    if any(labels.get(key) != value for key, value in expected_labels.items()):
        fail(f"{variable} component or upstream runtime labels differ from the reviewed contract")
    if not expected_environment <= environment:
        fail(f"{variable} environment differs from the reviewed runtime contract")


def inspect_images(deploy_file, runtime_file, lock_file):
    deploy, lock = validate(deploy_file, lock_file)
    runtime = read_env(runtime_file)
    revision = runtime.get("SERVICE_VERSION", "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        fail("SERVICE_VERSION must be a full Git SHA before image inspection")

    for variable in EXTERNAL:
        image = lock["images"][variable]
        index = command_json(
            ["docker", "buildx", "imagetools", "inspect", deploy[variable], "--raw"], variable
        )
        children = [
            descriptor for descriptor in index.get("manifests", [])
            if descriptor.get("platform", {}).get("os") == "linux"
            and descriptor.get("platform", {}).get("architecture") == "arm64"
            and descriptor.get("platform", {}).get("variant") in (None, "", "v8")
        ]
        if len(children) != 1 or children[0].get("digest") != image["arm64Digest"]:
            fail(f"{variable} does not resolve to its uniquely reviewed ARM64 child")

    for variable in (*EXTERNAL, *REPOSITORY_IMAGES):
        inspected = command_json(["docker", "image", "inspect", deploy[variable]], variable)
        if len(inspected) != 1 or (inspected[0].get("Os"), inspected[0].get("Architecture")) != (
            "linux", "arm64",
        ):
            fail(f"{variable} is not a pulled linux/arm64 runtime image")
        labels = inspected[0].get("Config", {}).get("Labels") or {}
        if variable in REPOSITORY_IMAGES:
            component = REPOSITORY_IMAGES[variable][1]
            expected = {
                "org.opencontainers.image.revision": revision,
                "org.opencontainers.image.source": "https://github.com/liangzixuan/cronometer-gold",
                "org.opencontainers.image.title": f"cronometer-gold-{component}",
                "org.opencontainers.image.version": f"sha-{revision}",
            }
            if any(labels.get(key) != value for key, value in expected.items()):
                fail(f"{variable} source, revision, title, or version differs from the release contract")
            require_repository_runtime_contract(variable, inspected[0].get("Config", {}))


def main():
    if len(sys.argv) == 4 and sys.argv[1] == "validate":
        validate(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 5 and sys.argv[1] == "inspect":
        inspect_images(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        fail("Usage: nutrition-image-admission validate <deploy.env> <lock.json> | inspect <deploy.env> <runtime.env> <lock.json>")


if __name__ == "__main__":
    main()
