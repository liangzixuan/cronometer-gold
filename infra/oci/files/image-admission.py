#!/usr/bin/python3
"""Fail-closed runtime image lock and pulled-image admission checks."""

import json
import pathlib
import re
import subprocess
import sys


REPOSITORY_IMAGES = {
    "CADDY_IMAGE": ("ghcr.io/liangzixuan/cronometer-gold-caddy", "caddy"),
    "POSTGRES_IMAGE": ("ghcr.io/liangzixuan/cronometer-gold-postgres", "postgres"),
    "MEILI_IMAGE": ("ghcr.io/liangzixuan/cronometer-gold-meilisearch", "meilisearch"),
    "API_IMAGE": ("ghcr.io/liangzixuan/cronometer-gold-api", "api"),
    "WEB_IMAGE": ("ghcr.io/liangzixuan/cronometer-gold-web", "web"),
    "WORKER_IMAGE": ("ghcr.io/liangzixuan/cronometer-gold-worker", "worker"),
    "MIGRATOR_IMAGE": ("ghcr.io/liangzixuan/cronometer-gold-migrator", "migrator"),
}
REFERENCE = re.compile(r"[^@\s]+@sha256:[0-9a-f]{64}")
NODE_RUNTIME_REFERENCE = re.compile(
    r"ghcr\.io/liangzixuan/cronometer-gold-node-runtime@sha256:[0-9a-f]{64}"
)

APP_RUNTIME_LABELS = {
    "io.cronometer.runtime.contract": (
        "patched-node22.23.2-openssl3.5.7-08e7756-base-nossl-debian13-uid-gid-1000-empty-entrypoint"
    ),
    "io.cronometer.upstream.node.version": "22.23.2",
    "io.cronometer.upstream.node.source": (
        "https://nodejs.org/dist/v22.23.2/node-v22.23.2.tar.xz"
    ),
    "io.cronometer.upstream.node.source.sha256": (
        "bbe768df8d5815d7fa76124052985332452e0a4742d39f32027550d1aab8f6fb"
    ),
    "io.cronometer.upstream.node.source.manifest.sha256": (
        "778ac5b2fcdbd68d9c0ae9f4310674faa3af0910bd0d18e7f6597787c40a3e39"
    ),
    "io.cronometer.upstream.node.source.manifest.signature.sha256": (
        "169f1452c14cd653247408352f1534b9f31e3d13f9c6399c3977368095e11eda"
    ),
    "io.cronometer.upstream.node.source.signature.fingerprint": (
        "CC68F5A3106FF448322E48ED27F5E38D5B0A215F"
    ),
    "io.cronometer.upstream.node.release.tag-object": (
        "490a9fef8f8adcda5a95bd6f96035b05cb43fe5b"
    ),
    "io.cronometer.upstream.node.release.commit": (
        "aa4c77582be995286fc6e00aaf530dc7ade102a9"
    ),
    "io.cronometer.upstream.node.release.signer.source.commit": (
        "43d7b8e5d41e87a3721d416f14fb86a68aeec1ce"
    ),
    "io.cronometer.upstream.node.release.signer.material.sha256": (
        "e31e1aa40a8331f01d753cef475f7b9eab934fc25f5f0b36995bfd80bd66ad27"
    ),
    "io.cronometer.upstream.openssl.version": "3.5.7",
    "io.cronometer.upstream.openssl.fix.cve": "CVE-2026-14456",
    "io.cronometer.upstream.openssl.fix.advisory": (
        "https://openssl-library.org/news/secadv/20260813.txt"
    ),
    "io.cronometer.upstream.openssl.fix.commit": (
        "08e7756c3900bcfd77a720e7b74e27d6e4ed01a9"
    ),
    "io.cronometer.upstream.openssl.fix.patch.sha256": (
        "3b4f3ff1e9d26ca3dd75f6d98cc5d30c7dbfc03892e4bc0037a7e14bec8c5087"
    ),
    "io.cronometer.upstream.node.builder.image": (
        "docker.io/library/python:3.12.14-bookworm"
    ),
    "io.cronometer.upstream.node.builder.image.digest": (
        "sha256:80f5d259a5969c86f6c92145d572de4a68c68e0edd28d4367dec0fb411b42af3"
    ),
    "io.cronometer.upstream.node.builder.image.arm64.digest": (
        "sha256:b6e215e1d3d8787fe1e0f1507c7d2418b16fe19acef77cf971b2d965570ced41"
    ),
    "io.cronometer.upstream.cxx.image": (
        "gcr.io/distroless/nodejs22-debian13:nonroot"
    ),
    "io.cronometer.upstream.cxx.image.digest": (
        "sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167"
    ),
    "io.cronometer.upstream.cxx.image.arm64.digest": (
        "sha256:806e2fa26e3cec196e986cb206f44f07070d211c028389c79091fd440cb75882"
    ),
    "io.cronometer.upstream.base.image": (
        "gcr.io/distroless/base-nossl-debian13:nonroot"
    ),
    "io.cronometer.upstream.base.image.digest": (
        "sha256:86554c46a420d507ff2d678fd261ab8691fba4875a20302f38a49e684b42a33f"
    ),
    "io.cronometer.upstream.base.image.arm64.digest": (
        "sha256:ab7e729cfe775ce5f251b2d28b45e88b70e0582cdbadd1aa1f99a41601f11f3b"
    ),
    "io.cronometer.upstream.distroless.signature.identity": (
        "keyless@distroless.iam.gserviceaccount.com"
    ),
    "io.cronometer.upstream.distroless.signature.issuer": "https://accounts.google.com",
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


def validate(deploy_file):
    deploy = read_env(deploy_file)
    for variable, (repository, _component) in REPOSITORY_IMAGES.items():
        reference = deploy.get(variable, "")
        if not REFERENCE.fullmatch(reference) or not reference.startswith(f"{repository}@"):
            fail(f"{variable} must use its exact GHCR package at an immutable digest")
    return deploy


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
        node_runtime_reference = labels.get("io.cronometer.upstream.node-runtime.ref")
        if (
            not isinstance(node_runtime_reference, str)
            or not NODE_RUNTIME_REFERENCE.fullmatch(node_runtime_reference)
        ):
            fail(f"{variable} patched Node runtime reference differs from the reviewed contract")
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
            "io.cronometer.upstream.vulnerability-patches": "golang.org/x/crypto=v0.55.0,golang.org/x/net=v0.58.0,golang.org/x/text=v0.41.0,google.golang.org/grpc=v1.83.2",
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
            "io.cronometer.runtime.contract": "openssl-3.5.8-r0-libuuid-2.42.3-r0-uid-gid-70-preowned-pgdata-and-tmpfs",
            "io.cronometer.upstream.image": "docker.io/library/postgres:17.11-alpine3.24",
            "io.cronometer.upstream.image.digest": "sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73",
            "io.cronometer.upstream.image.arm64.digest": "sha256:dfc2780980fe6ca2d158bfe4342660db5e4c6431fb969088e543430d09f8d0f2",
            "io.cronometer.upstream.version": "17.11",
            "io.cronometer.runtime.openssl-packages": "libcrypto3=3.5.8-r0,libssl3=3.5.8-r0",
            "io.cronometer.runtime.openssl-upgrade-trigger": "CVE-2026-14456",
            "io.cronometer.runtime.util-linux-packages": "libuuid=2.42.3-r0",
            "io.cronometer.runtime.util-linux-upgrade-trigger": "CVE-2026-53612,CVE-2026-53613,CVE-2026-53614,CVE-2026-76642,CVE-2026-78408,CVE-2026-78409,CVE-2026-78410",
        }
        expected_environment = {
            "GOSU_VERSION=",
            "PGDATA=/var/lib/postgresql/data",
            "PG_VERSION=17.11",
        }
        healthcheck = (config.get("Healthcheck") or {}).get("Test") or []
        if not healthcheck or healthcheck[0] != "CMD-SHELL":
            fail("POSTGRES_IMAGE healthcheck differs from the repository runtime contract")
    elif variable == "MEILI_IMAGE":
        exact = {
            "User": "1000:1000",
            "Entrypoint": ["tini", "--"],
            "Cmd": ["/bin/sh", "-c", "/bin/meilisearch"],
            "WorkingDir": "/meili_data",
            "Volumes": None,
            "StopSignal": None,
            "Shell": None,
            "ExposedPorts": {"7700/tcp": {}},
            "Healthcheck": {
                "Test": [
                    "CMD-SHELL",
                    "curl --fail --silent http://127.0.0.1:7700/health >/dev/null || exit 1",
                ],
                "Interval": 10_000_000_000,
                "Timeout": 5_000_000_000,
                "StartPeriod": 20_000_000_000,
                "Retries": 6,
            },
        }
        expected_labels = {
            "io.cronometer.runtime.component": "meilisearch",
            "io.cronometer.runtime.contract": "v1.53.1-openssl-3.5.8-r0-uid-gid-1000",
            "io.cronometer.upstream.image": "docker.io/getmeili/meilisearch:v1.53.1",
            "io.cronometer.upstream.image.digest": "sha256:8d6643d86d71fad6ad3cba92cde7ccfce9e4d6c384bda67598eb553571c32431",
            "io.cronometer.upstream.image.arm64.digest": "sha256:b4a0a1f9545ae1dd8e12a750fa4416ef3f4b421ed0758c430d0c46182ad233ee",
            "io.cronometer.upstream.source": "https://github.com/meilisearch/meilisearch",
            "io.cronometer.upstream.source.revision": "577f7af28942b71782eab1e59f44ad8296ce0a92",
            "io.cronometer.upstream.version": "v1.53.1",
            "io.cronometer.runtime.openssl-packages": "libcrypto3=3.5.8-r0,libssl3=3.5.8-r0",
            "io.cronometer.runtime.openssl-upgrade-trigger": "CVE-2026-14456",
        }
        expected_environment = {
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "MEILI_HTTP_ADDR=0.0.0.0:7700",
            "MEILI_SERVER_PROVIDER=docker",
        }
        if len(environment_entries) != len(expected_environment) or environment != expected_environment:
            fail("MEILI_IMAGE environment differs from the repository runtime contract")
    else:
        fail(f"{variable} has no reviewed repository runtime contract")
    if any(config.get(key) != value for key, value in exact.items()):
        fail(f"{variable} process identity or filesystem contract differs from the reviewed runtime")
    if any(labels.get(key) != value for key, value in expected_labels.items()):
        fail(f"{variable} component or upstream runtime labels differ from the reviewed contract")
    if not expected_environment <= environment:
        fail(f"{variable} environment differs from the reviewed runtime contract")


def inspect_images(deploy_file, runtime_file):
    deploy = validate(deploy_file)
    runtime = read_env(runtime_file)
    revision = runtime.get("SERVICE_VERSION", "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        fail("SERVICE_VERSION must be a full Git SHA before image inspection")

    for variable in REPOSITORY_IMAGES:
        inspected = command_json(["docker", "image", "inspect", deploy[variable]], variable)
        if len(inspected) != 1 or (inspected[0].get("Os"), inspected[0].get("Architecture")) != (
            "linux", "arm64",
        ):
            fail(f"{variable} is not a pulled linux/arm64 runtime image")
        labels = inspected[0].get("Config", {}).get("Labels") or {}
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
    if len(sys.argv) == 3 and sys.argv[1] == "validate":
        validate(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == "inspect":
        inspect_images(sys.argv[2], sys.argv[3])
    else:
        fail("Usage: nutrition-image-admission validate <deploy.env> | inspect <deploy.env> <runtime.env>")


if __name__ == "__main__":
    main()
