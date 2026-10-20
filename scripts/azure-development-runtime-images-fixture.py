"""Public controlled image metadata only; no Docker or registry access."""
import json
import runpy
from pathlib import Path

root = Path(__file__).resolve().parents[1]
maintained = runpy.run_path(str(root / "infra/oci/files/image-admission.py"))
revision = "a" * 40
configs = {}
for name in ("API_IMAGE", "WORKER_IMAGE", "MIGRATOR_IMAGE"):
    item = maintained["APP_RUNTIME_CONTRACTS"][name]
    configs[name] = {"User": "1000:1000", "Entrypoint": [], "Cmd": item["cmd"], "WorkingDir": "/app",
        "Env": sorted(item["environment"]), "ExposedPorts": item["ports"], "Healthcheck": item["healthcheck"],
        "Labels": maintained["APP_RUNTIME_LABELS"] | {"io.cronometer.runtime.component": item["component"],
        "io.cronometer.upstream.node-runtime.ref": "ghcr.io/liangzixuan/cronometer-gold-node-runtime@sha256:" + "e" * 64}}
configs["CADDY_IMAGE"] = {
    "User": "1000:1000", "Entrypoint": ["/usr/bin/caddy"], "Cmd": ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
    "WorkingDir": "/srv", "Volumes": {"/config": {}, "/data": {}}, "ExposedPorts": {"2019/tcp": {}, "443/tcp": {}, "443/udp": {}, "80/tcp": {}},
    "Env": ["HOME=/home/caddy", "PATH=/usr/bin", "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt", "XDG_CONFIG_HOME=/config", "XDG_DATA_HOME=/data"],
    "Labels": {"io.cronometer.runtime.component": "caddy", "io.cronometer.runtime.contract": "uid-gid-1000-net-bind-service",
        "io.cronometer.upstream.source": "https://github.com/caddyserver/caddy", "io.cronometer.upstream.source.revision": "e2eee6a7fce366321294c9c2a79f3146891dcbdf",
        "io.cronometer.upstream.source.tag-object": "8ec11a4b7e39a5fd00da2fc5cb9b543e31fd7926", "io.cronometer.upstream.version": "v2.11.4",
        "io.cronometer.upstream.vulnerability-patches": "golang.org/x/crypto=v0.57.0,golang.org/x/net=v0.60.0,golang.org/x/text=v0.42.0,google.golang.org/grpc=v1.83.2"}}
configs["POSTGRES_IMAGE"] = {
    "User": "70:70", "Entrypoint": ["docker-entrypoint.sh"], "Cmd": ["postgres"], "StopSignal": "SIGINT", "Volumes": {"/var/lib/postgresql/data": {}}, "ExposedPorts": {"5432/tcp": {}},
    "Env": ["GOSU_VERSION=", "PGDATA=/var/lib/postgresql/data", "PG_VERSION=17.11"], "Healthcheck": {"Test": ["CMD-SHELL", "pg_isready"]},
    "Labels": {"io.cronometer.runtime.component": "postgres", "io.cronometer.runtime.contract": "openssl-3.5.9-r0-libuuid-2.42.3-r1-uid-gid-70-preowned-pgdata-and-tmpfs",
        "io.cronometer.upstream.image": "docker.io/library/postgres:17.11-alpine3.24", "io.cronometer.upstream.image.digest": "sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73",
        "io.cronometer.upstream.image.arm64.digest": "sha256:dfc2780980fe6ca2d158bfe4342660db5e4c6431fb969088e543430d09f8d0f2", "io.cronometer.upstream.version": "17.11",
        "io.cronometer.runtime.openssl-packages": "libcrypto3=3.5.9-r0,libssl3=3.5.9-r0", "io.cronometer.runtime.openssl-upgrade-trigger": "CVE-2026-14456",
        "io.cronometer.runtime.util-linux-packages": "libuuid=2.42.3-r1", "io.cronometer.runtime.util-linux-upgrade-trigger": "CVE-2026-53612,CVE-2026-53613,CVE-2026-53614,CVE-2026-76642,CVE-2026-78408,CVE-2026-78409,CVE-2026-78410"}}
configs["MEILI_IMAGE"] = {
    "User": "1000:1000", "Entrypoint": ["tini", "--"], "Cmd": ["/bin/sh", "-c", "/bin/meilisearch"], "WorkingDir": "/meili_data", "ExposedPorts": {"7700/tcp": {}},
    "Env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "MEILI_HTTP_ADDR=0.0.0.0:7700", "MEILI_SERVER_PROVIDER=docker"],
    "Healthcheck": {"Test": ["CMD-SHELL", "curl --fail --silent http://127.0.0.1:7700/health >/dev/null || exit 1"], "Interval": 10000000000, "Timeout": 5000000000, "StartPeriod": 20000000000, "Retries": 6},
    "Labels": {"io.cronometer.runtime.component": "meilisearch", "io.cronometer.runtime.contract": "v1.53.1-openssl-3.5.9-r0-curl-8.14.1-r4-uid-gid-1000",
        "io.cronometer.upstream.image": "docker.io/getmeili/meilisearch:v1.53.1", "io.cronometer.upstream.image.digest": "sha256:8d6643d86d71fad6ad3cba92cde7ccfce9e4d6c384bda67598eb553571c32431",
        "io.cronometer.upstream.image.arm64.digest": "sha256:b4a0a1f9545ae1dd8e12a750fa4416ef3f4b421ed0758c430d0c46182ad233ee", "io.cronometer.upstream.source": "https://github.com/meilisearch/meilisearch",
        "io.cronometer.upstream.source.revision": "577f7af28942b71782eab1e59f44ad8296ce0a92", "io.cronometer.upstream.version": "v1.53.1",
        "io.cronometer.runtime.openssl-packages": "libcrypto3=3.5.9-r0,libssl3=3.5.9-r0", "io.cronometer.runtime.openssl-upgrade-trigger": "CVE-2026-14456",
        "io.cronometer.runtime.curl-packages": "curl=8.14.1-r4,libcurl=8.14.1-r4"}}
for name, config in configs.items():
    component = maintained["REPOSITORY_IMAGES"][name][1]
    config["Labels"].update({"org.opencontainers.image.revision": revision, "org.opencontainers.image.source": "https://github.com/liangzixuan/cronometer-gold",
        "org.opencontainers.image.title": "cronometer-gold-" + component, "org.opencontainers.image.version": "sha-" + revision})
print(json.dumps(configs, sort_keys=True))
