#!/usr/bin/env python3
"""Normalize reviewer-prepared P0 smoke captures into an unsigned candidate.

The program is deliberately read-only. It does not run a browser, invoke a
device, authenticate a user, or claim that operator-supplied observations are
authentic. Only the independent Ed25519 signature on the outer health-release
manifest can turn the candidate's exact digest into release evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn, Sequence
from urllib.parse import urlsplit


REPORT_SCHEMA = "nutrition-tracker-p0-client-smoke-report-v1"
REVIEW_PACKAGE_SCHEMA = "nutrition-tracker-p0-client-smoke-review-package-v1"
CAPTURE_SCHEMA = "nutrition-tracker-p0-client-smoke-capture-v1"
SOURCE_BUNDLE_SCHEMA = "nutrition-tracker-p0-client-smoke-source-capture-bundle-v1"
UNSIGNED_TRUST_BOUNDARY = (
    "unsigned-structural-candidate-requires-independent-ed25519-health-manifest-review"
)
DATA_CLASSIFICATION = "synthetic-only"
CLIENT_ROLES = ("browser", "ios", "android")
FLOW_IDS = (
    "unauthenticated-entry",
    "register",
    "sign-in",
    "session-restore",
    "unauthorized-session-rejection",
    "food-search",
    "diary-add-edit-delete",
    "diary-repeat",
    "recipe-create-revise-log",
    "goal-create-revise-progress",
    "retention-trends",
    "custom-food-create-revise-log",
    "biometric-create-edit-delete",
    "reminder-create-pause-revoke",
    "account-export-download",
    "sign-out-private-cleanup",
    "account-erasure",
    "erasure-status-after-session-revocation",
)
MAX_JSON_BYTES = 262_144
MAX_SESSION_SECONDS = 24 * 60 * 60
ISO_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
GIT_COMMIT = re.compile(r"^[0-9a-f]{40}$")
EAS_BUILD_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


class P0SmokeError(RuntimeError):
    """A structural or secure-read precondition failed closed."""


def _fail(message: str) -> NoReturn:
    raise P0SmokeError(message)


def _exact(value: Any, expected: Sequence[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != set(expected):
        _fail(f"{name} does not contain the exact reviewed fields.")
    return value


def _reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("A P0 smoke JSON input contains a duplicate key.")
        result[key] = value
    return result


def _reject_non_integer(_value: str) -> NoReturn:
    _fail("P0 smoke JSON numbers must be strict finite integers.")


def _secure_read_record(path_value: Any, name: str) -> tuple[bytes, tuple[int, int]]:
    if not isinstance(path_value, str):
        _fail(f"{name} path is absent.")
    try:
        encoded = os.fsencode(path_value)
    except UnicodeEncodeError as error:
        raise P0SmokeError(f"{name} path encoding is invalid.") from error
    if b"\x00" in encoded or len(encoded) > 4096:
        _fail(f"{name} path violates the bounded path contract.")
    path = Path(path_value)
    if not path.is_absolute() or os.path.normpath(path_value) != path_value:
        _fail(f"{name} path must be absolute and normalized.")
    try:
        before = path.lstat()
    except (OSError, ValueError) as error:
        raise P0SmokeError(f"{name} cannot be inspected.") from error
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        _fail(f"{name} must be a regular non-symlink file.")
    if stat.S_IMODE(before.st_mode) != 0o600 or before.st_uid != os.getuid():
        _fail(f"{name} must be current-user-owned mode 0600.")
    no_follow = getattr(os, "O_NOFOLLOW", None)
    if not isinstance(no_follow, int):
        _fail("This platform cannot enforce no-follow P0 smoke reads.")
    flags = os.O_RDONLY | no_follow | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or stat.S_IMODE(opened.st_mode) != 0o600
                or opened.st_uid != os.getuid()
                or opened.st_size < 1
                or opened.st_size > MAX_JSON_BYTES
                or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
            ):
                _fail(f"{name} changed or violated its size/mode boundary.")
            chunks: list[bytes] = []
            remaining = opened.st_size
            while remaining:
                chunk = os.read(descriptor, min(65_536, remaining))
                if not chunk:
                    _fail(f"{name} ended unexpectedly.")
                chunks.append(chunk)
                remaining -= len(chunk)
            if os.read(descriptor, 1):
                _fail(f"{name} grew while being read.")
            after = os.fstat(descriptor)
            if (
                opened.st_dev,
                opened.st_ino,
                opened.st_size,
                opened.st_mtime_ns,
            ) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                _fail(f"{name} changed while being read.")
            return b"".join(chunks), (opened.st_dev, opened.st_ino)
        finally:
            os.close(descriptor)
    except (OSError, ValueError) as error:
        raise P0SmokeError(f"{name} could not be read safely.") from error


def _json(raw: bytes, name: str) -> dict[str, Any]:
    try:
        value = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicates,
            parse_float=_reject_non_integer,
            parse_constant=_reject_non_integer,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise P0SmokeError(f"{name} is not strict UTF-8 JSON.") from error
    if not isinstance(value, dict):
        _fail(f"{name} must be a JSON object.")
    return value


def _instant(value: Any, name: str) -> datetime:
    if not isinstance(value, str) or not ISO_INSTANT.fullmatch(value):
        _fail(f"{name} must be a canonical UTC instant with milliseconds.")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise P0SmokeError(f"{name} is not a real instant.") from error
    if parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" != value:
        _fail(f"{name} is not canonical.")
    return parsed


def _origin(value: Any) -> str:
    if not isinstance(value, str) or value.strip() != value:
        _fail("apiOrigin must be an exact canonical HTTPS origin.")
    try:
        parsed = urlsplit(value)
        hostname = (parsed.hostname or "").lower()
        explicit_port = parsed.port
    except ValueError as error:
        raise P0SmokeError("apiOrigin is structurally invalid.") from error
    labels = hostname.split(".")
    if (
        parsed.scheme != "https"
        or explicit_port is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or value != f"https://{hostname}"
        or len(labels) != 4
        or labels[-2:] != ["ts", "net"]
    ):
        _fail("apiOrigin is not the exact private .ts.net HTTPS API origin exercised.")
    return value


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _canonical(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def source_capture_bundle_sha256(raws: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    digest.update(f"{SOURCE_BUNDLE_SCHEMA}\n".encode("ascii"))
    for role in CLIENT_ROLES:
        digest.update(f"{role}\n{_sha(raws[role])}\n".encode("ascii"))
    return digest.hexdigest()


def _capture(
    value: dict[str, Any],
    role: str,
    git_commit: str,
    api_origin: str,
    build_id: str | None,
    started: datetime,
    executed: datetime,
) -> dict[str, Any]:
    capture = _exact(
        value,
        (
            "schemaVersion",
            "dataClassification",
            "client",
            "gitCommit",
            "apiOrigin",
            "testedEasBuildId",
            "capturedAt",
            "results",
        ),
        f"{role} capture",
    )
    if capture["schemaVersion"] != CAPTURE_SCHEMA:
        _fail(f"{role} capture schema is not supported.")
    if capture["dataClassification"] != DATA_CLASSIFICATION:
        _fail(f"{role} capture is not explicitly synthetic-only.")
    if (
        capture["client"] != role
        or capture["gitCommit"] != git_commit
        or capture["apiOrigin"] != api_origin
        or capture["testedEasBuildId"] != build_id
    ):
        _fail(f"{role} capture does not match the review-package context.")
    captured_at = _instant(capture["capturedAt"], f"{role}.capturedAt")
    results = capture["results"]
    if not isinstance(results, list) or len(results) != len(FLOW_IDS):
        _fail(f"{role} capture must contain the exact ordered P0 flow inventory.")
    normalized: list[dict[str, str]] = []
    previous = started
    for expected_flow, item in zip(FLOW_IDS, results, strict=True):
        result = _exact(item, ("flowId", "outcome", "observedAt"), f"{role}.{expected_flow}")
        observed = _instant(result["observedAt"], f"{role}.{expected_flow}.observedAt")
        if (
            result["flowId"] != expected_flow
            or result["outcome"] != "passed"
            or observed < previous
            or observed > executed
        ):
            _fail(f"{role}.{expected_flow} is not one ordered structural pass assertion.")
        previous = observed
        normalized.append(
            {"flowId": expected_flow, "outcome": "passed", "observedAt": result["observedAt"]}
        )
    if captured_at != previous:
        _fail(f"{role}.capturedAt must equal its final ordered flow observation.")
    return {
        "captureSha256": "pending",
        "testedEasBuildId": build_id,
        "capturedAt": capture["capturedAt"],
        "results": normalized,
    }


def normalize_candidate(index_path: str) -> bytes:
    index_raw, _ = _secure_read_record(index_path, "review-package index")
    index = _exact(
        _json(index_raw, "review-package index"),
        (
            "schemaVersion",
            "trustBoundary",
            "dataClassification",
            "gitCommit",
            "apiOrigin",
            "startedAt",
            "executedAt",
            "completedAt",
            "buildIds",
            "captures",
        ),
        "review-package index",
    )
    if index["schemaVersion"] != REVIEW_PACKAGE_SCHEMA:
        _fail("Review-package schema is not supported.")
    if index["trustBoundary"] != UNSIGNED_TRUST_BOUNDARY:
        _fail("Review package does not acknowledge the unsigned trust boundary.")
    if index["dataClassification"] != DATA_CLASSIFICATION:
        _fail("Review package must be explicitly synthetic-only.")
    if not isinstance(index["gitCommit"], str) or not GIT_COMMIT.fullmatch(index["gitCommit"]):
        _fail("gitCommit must be one full lowercase commit.")
    api_origin = _origin(index["apiOrigin"])
    started = _instant(index["startedAt"], "startedAt")
    executed = _instant(index["executedAt"], "executedAt")
    completed = _instant(index["completedAt"], "completedAt")
    if not (started <= executed <= completed) or (completed - started).total_seconds() > MAX_SESSION_SECONDS:
        _fail("P0 smoke timing must describe one session of at most 24 hours.")
    build_ids = _exact(index["buildIds"], ("ios", "android"), "buildIds")
    if any(not isinstance(value, str) or not EAS_BUILD_ID.fullmatch(value) for value in build_ids.values()):
        _fail("Both physical-device captures must bind canonical EAS build IDs.")
    if build_ids["ios"] == build_ids["android"]:
        _fail("The iOS and Android smoke captures must bind distinct EAS builds.")
    paths = _exact(index["captures"], CLIENT_ROLES, "captures")
    records = {role: _secure_read_record(paths[role], role) for role in CLIENT_ROLES}
    if len({identity for _, identity in records.values()}) != len(CLIENT_ROLES):
        _fail("Every P0 smoke client role must use a distinct capture file.")
    raws = {role: record[0] for role, record in records.items()}
    clients = {}
    for role in CLIENT_ROLES:
        build_id = None if role == "browser" else build_ids[role]
        clients[role] = _capture(
            _json(raws[role], role),
            role,
            index["gitCommit"],
            api_origin,
            build_id,
            started,
            executed,
        )
        clients[role]["captureSha256"] = _sha(raws[role])
    report = {
        "schemaVersion": REPORT_SCHEMA,
        "trustBoundary": UNSIGNED_TRUST_BOUNDARY,
        "dataClassification": DATA_CLASSIFICATION,
        "sourceCaptureBundleSha256": source_capture_bundle_sha256(raws),
        "gitCommit": index["gitCommit"],
        "apiOrigin": api_origin,
        "startedAt": index["startedAt"],
        "executedAt": index["executedAt"],
        "completedAt": index["completedAt"],
        "clients": clients,
    }
    return _canonical(report)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Normalize protected P0 smoke captures into an unsigned structural candidate."
    )
    parser.add_argument("--capture-index", required=True, help="Absolute mode-0600 index path")
    parser.add_argument(
        "--acknowledge-unsigned-candidate",
        action="store_true",
        required=True,
        help="Acknowledge that independent Ed25519 health-manifest review is still required",
    )
    return parser


def main(arguments: Sequence[str] | None = None) -> int:
    try:
        parsed = _parser().parse_args(arguments)
        sys.stdout.buffer.write(normalize_candidate(parsed.capture_index))
        sys.stderr.write(
            "Unsigned synthetic P0 smoke candidate only; independent trusted Ed25519 health-manifest review remains required.\n"
        )
        return 0
    except P0SmokeError as error:
        sys.stderr.write(f"P0 smoke candidate rejected: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
