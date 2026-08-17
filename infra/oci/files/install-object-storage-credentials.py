#!/usr/bin/python3
"""Atomically install an offline-provisioned OCI Object Storage credential set."""

import hashlib
import hmac
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile


CONFIG = pathlib.Path("/etc/nutrition-tracker")
KEY_DIRECTORY = CONFIG / "oci"
KEY_TARGET = KEY_DIRECTORY / "restore-private-key.pem"
ROTATION_LOCK = pathlib.Path("/run/nutrition-object-credential-rotation.lock")
ROTATION_TOKEN = pathlib.Path("/run/nutrition-object-credential-rotation.token")
START_ADMISSION = pathlib.Path("/run/nutrition-object-credential-start-admission")
ENV_KEYS = {
    "api.env": {
        "EXPORT_ARTIFACT_READ_ACCESS_KEY_ID": ("exportReader", "accessKeyId"),
        "EXPORT_ARTIFACT_READ_SECRET_ACCESS_KEY": ("exportReader", "secretAccessKey"),
    },
    "worker.env": {
        "EXPORT_ARTIFACT_WRITE_ACCESS_KEY_ID": ("exportWriter", "accessKeyId"),
        "EXPORT_ARTIFACT_WRITE_SECRET_ACCESS_KEY": ("exportWriter", "secretAccessKey"),
        "ERASURE_REPLAY_LEDGER_WRITE_ACCESS_KEY_ID": ("ledgerWriter", "accessKeyId"),
        "ERASURE_REPLAY_LEDGER_WRITE_SECRET_ACCESS_KEY": ("ledgerWriter", "secretAccessKey"),
    },
    "restore.env": {
        "ERASURE_REPLAY_LEDGER_RESTORE_ACCESS_KEY_ID": ("ledgerRestore", "accessKeyId"),
        "ERASURE_REPLAY_LEDGER_RESTORE_SECRET_ACCESS_KEY": (
            "ledgerRestore",
            "secretAccessKey",
        ),
        "ERASURE_REPLAY_LEDGER_RESTORE_OCI_KEY_FINGERPRINT": (
            "restoreApi",
            "fingerprint",
        ),
    },
}


def fail(message: str) -> None:
    raise SystemExit(message)


def validate_regular(path: pathlib.Path, uid: int, gid: int, mode: int) -> bytes:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail(f"Refusing non-regular credential target: {path}")
    if (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) != (uid, gid, mode):
        fail(f"Unsafe owner or mode on credential target: {path}")
    return path.read_bytes()


def read_bundle() -> dict:
    raw = sys.stdin.buffer.read(65537)
    if len(raw) == 0 or len(raw) > 65536:
        fail("Credential bundle must be between 1 and 65536 bytes")
    try:
        bundle = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"Credential bundle is not valid JSON: {error}")
    if set(bundle) != {
        "schemaVersion",
        "exportReader",
        "exportWriter",
        "ledgerWriter",
        "ledgerRestore",
        "rotationLockToken",
        "restoreApi",
    } or bundle["schemaVersion"] != 1:
        fail("Credential bundle has an unexpected schema")
    for role in ("exportReader", "exportWriter", "ledgerWriter", "ledgerRestore"):
        credential = bundle[role]
        if not isinstance(credential, dict) or set(credential) != {
            "accessKeyId",
            "secretAccessKey",
        }:
            fail(f"Invalid {role} credential entry")
        for field in ("accessKeyId", "secretAccessKey"):
            value = credential[field]
            if (
                not isinstance(value, str)
                or not 16 <= len(value) <= 256
                or any(character.isspace() or ord(character) < 33 or ord(character) > 126 for character in value)
            ):
                fail(f"Invalid {role} {field}")
    access_ids = [bundle[role]["accessKeyId"] for role in ("exportReader", "exportWriter", "ledgerWriter", "ledgerRestore")]
    secrets = [bundle[role]["secretAccessKey"] for role in ("exportReader", "exportWriter", "ledgerWriter", "ledgerRestore")]
    if len(set(access_ids)) != 4 or len(set(secrets)) != 4:
        fail("Every OCI Object Storage principal must use a distinct credential pair")
    if not isinstance(bundle["rotationLockToken"], str) or not re.fullmatch(
        r"[0-9a-f]{64}", bundle["rotationLockToken"]
    ):
        fail("Invalid credential-rotation lock token")
    restore_api = bundle["restoreApi"]
    if not isinstance(restore_api, dict) or set(restore_api) != {
        "fingerprint",
        "privateKeyPem",
    }:
        fail("Invalid restoreApi entry")
    if not re.fullmatch(r"(?:[0-9a-f]{2}:){15}[0-9a-f]{2}", restore_api["fingerprint"]):
        fail("OCI API-key fingerprint must be a lowercase colon-delimited MD5 fingerprint")
    private_key = restore_api["privateKeyPem"]
    if not isinstance(private_key, str) or not private_key.endswith("\n") or len(private_key) > 16384:
        fail("Restore API private key must be a newline-terminated PEM smaller than 16 KiB")
    return bundle


def assert_rotation_lock(expected_token: str) -> None:
    token = validate_regular(ROTATION_TOKEN, 0, 0, 0o400).decode("ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{64}", token) or not hmac.compare_digest(
        token, expected_token
    ):
        fail("Credential bundle is not admitted by the active rotation lock")
    lock_metadata = ROTATION_LOCK.lstat()
    if (
        not stat.S_ISREG(lock_metadata.st_mode)
        or stat.S_ISLNK(lock_metadata.st_mode)
        or (lock_metadata.st_uid, lock_metadata.st_gid, stat.S_IMODE(lock_metadata.st_mode))
        != (0, 0, 0o600)
    ):
        fail("Unsafe credential-rotation lock file")
    lock_probe = subprocess.run(
        ["flock", "-n", "-E", "75", str(ROTATION_LOCK), "true"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if lock_probe.returncode != 75:
        fail("The exclusive credential-rotation lock is not held")


def render_environment(original: bytes, updates: dict[str, str], filename: str) -> bytes:
    try:
        lines = original.decode("utf-8").splitlines()
    except UnicodeDecodeError as error:
        fail(f"{filename} is not UTF-8: {error}")
    found: set[str] = set()
    rendered: list[str] = []
    for line in lines:
        key, separator, _value = line.partition("=")
        if separator and key in updates:
            if key in found:
                fail(f"Duplicate {key} in {filename}")
            found.add(key)
            rendered.append(f"{key}={updates[key]}")
        else:
            rendered.append(line)
    if found != set(updates):
        fail(f"{filename} is missing required OCI credential keys")
    return ("\n".join(rendered) + "\n").encode("utf-8")


def write_atomic(path: pathlib.Path, content: bytes, uid: int, gid: int, mode: int) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(temporary, uid, gid)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def verify_private_key(private_key: bytes, expected_fingerprint: str) -> None:
    with tempfile.NamedTemporaryFile(mode="wb", prefix=".restore-key-", dir=CONFIG) as stream:
        stream.write(private_key)
        stream.flush()
        os.chmod(stream.name, 0o600)
        public_der = subprocess.run(
            ["openssl", "pkey", "-in", stream.name, "-pubout", "-outform", "DER"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        ).stdout
    fingerprint = ":".join(
        hashlib.md5(public_der, usedforsecurity=False).hexdigest()[index : index + 2]
        for index in range(0, 32, 2)
    )
    if fingerprint != expected_fingerprint:
        fail("Restore API private key does not match the uploaded OCI fingerprint")


def main() -> None:
    if os.geteuid() != 0:
        fail("Run this installer as root")
    if len(sys.argv) != 1:
        fail("Usage: nutrition-install-object-storage-credentials < credential-bundle.json")
    bundle = read_bundle()
    assert_rotation_lock(bundle["rotationLockToken"])
    if subprocess.run(["systemctl", "is-active", "--quiet", "nutrition-tracker.service"]).returncode == 0:
        fail("Stop nutrition-tracker.service before installing or rotating object credentials")
    for service in (
        "api",
        "web",
        "worker",
        "migrate",
        "object-egress-negative-canary",
        "object-storage-live-canary",
        "erasure-restore-attestation",
        "database-readiness",
    ):
        running = subprocess.run(
            [
                "docker",
                "ps",
                "-q",
                "--filter",
                "label=com.docker.compose.project=cronometer-gold-beta",
                "--filter",
                f"label=com.docker.compose.service={service}",
            ],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        if running.stdout.strip():
            fail(f"{service} must be stopped before object credential installation")

    original: dict[pathlib.Path, bytes] = {}
    rendered: dict[pathlib.Path, bytes] = {}
    for filename, mappings in ENV_KEYS.items():
        path = CONFIG / filename
        original[path] = validate_regular(path, 0, 0, 0o600)
        updates = {
            key: bundle[role][field]
            for key, (role, field) in mappings.items()
        }
        rendered[path] = render_environment(original[path], updates, filename)

    KEY_DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(KEY_DIRECTORY, 0, 0)
    os.chmod(KEY_DIRECTORY, 0o700)
    key_existed = KEY_TARGET.exists()
    if key_existed:
        original[KEY_TARGET] = validate_regular(KEY_TARGET, 1000, 1000, 0o400)
    private_key = bundle["restoreApi"]["privateKeyPem"].encode("ascii")
    verify_private_key(private_key, bundle["restoreApi"]["fingerprint"])
    rendered[KEY_TARGET] = private_key

    try:
        START_ADMISSION.lstat()
    except FileNotFoundError:
        pass
    else:
        fail("A stale credential-rotation start admission marker exists")

    published: list[pathlib.Path] = []
    admission_published = False
    try:
        for path, content in rendered.items():
            if path == KEY_TARGET:
                write_atomic(path, content, 1000, 1000, 0o400)
            else:
                write_atomic(path, content, 0, 0, 0o600)
            published.append(path)
        assert_rotation_lock(bundle["rotationLockToken"])
        write_atomic(
            START_ADMISSION,
            (bundle["rotationLockToken"] + "\n").encode("ascii"),
            0,
            0,
            0o400,
        )
        admission_published = True
        for directory in sorted({path.parent for path in rendered} | {START_ADMISSION.parent}):
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    except BaseException:
        if admission_published:
            START_ADMISSION.unlink(missing_ok=True)
        for path in reversed(published):
            if path in original:
                owner = (1000, 1000, 0o400) if path == KEY_TARGET else (0, 0, 0o600)
                write_atomic(path, original[path], *owner)
            elif path == KEY_TARGET and not key_existed:
                path.unlink(missing_ok=True)
        raise

    print("Installed the OCI Object Storage environment credentials and offline restore key without logging values.")
    print("The restore private key is UID/GID 1000 mode 0400 and is mounted only into offline canary/restore services.")


if __name__ == "__main__":
    main()
