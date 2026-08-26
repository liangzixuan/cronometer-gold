"""Normalize a Tailscale relay review package into an unsigned v2 candidate.

This program is deliberately read-only and is not an evidence collector or a
trust authority. It structurally cross-checks operator-supplied capture files and
writes canonical candidate bytes to stdout. The candidate becomes release
evidence only after an independent trusted reviewer inspects the exact sources
and signs a manifest that binds its SHA-256 digest. This program never invokes
Tailscale, installs software, authenticates a node, changes policy, changes
Shields Up, starts/stops Serve or Funnel, or creates a reviewer signature.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn, Sequence
from urllib.parse import urlsplit

try:
    from infra.tailscale.phone_policy import (
        BASELINE_DENIED_TCP_PORTS,
        PhonePolicyError,
        TAILSCALE_NETWORK,
        build_phone_policy,
        parse_lsof_snapshot,
    )
except ModuleNotFoundError:  # Direct ``python infra/tailscale/relay_evidence.py`` invocation.
    from phone_policy import (  # type: ignore[no-redef]
        BASELINE_DENIED_TCP_PORTS,
        PhonePolicyError,
        TAILSCALE_NETWORK,
        build_phone_policy,
        parse_lsof_snapshot,
    )


REPORT_SCHEMA = "nutrition-tracker-physical-device-relay-report-v2"
REVIEW_PACKAGE_SCHEMA = "nutrition-tracker-tailscale-relay-review-package-v1"
SOURCE_CAPTURE_BUNDLE_SCHEMA = (
    "nutrition-tracker-tailscale-relay-source-capture-bundle-v1"
)
UNSIGNED_TRUST_BOUNDARY = (
    "unsigned-structural-candidate-requires-independent-ed25519-manifest-review"
)
CAPTURE_SCHEMA_PREFIX = "nutrition-tracker-tailscale-"
MAX_JSON_BYTES = 262_144
MAX_SESSION_SECONDS = 24 * 60 * 60
PHONE_ALIASES = ("nutrition-tracker-phone-1", "nutrition-tracker-phone-2")
DEVICE_ALIASES = ("nutrition-tracker-mac", *PHONE_ALIASES)
BUILD_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
ISO_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+ -]{2,127}$")
TAILSCALE_DNS_NAME = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\."
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$"
)
CAPTURE_NAMES = (
    "preflightShields",
    "preflightServe",
    "preflightFunnel",
    "preflightIdentities",
    "accessTimeline",
    "activeShields",
    "activeServe",
    "activeFunnel",
    "activeIdentities",
    "policy",
    "configurationEvent",
    "listenerSnapshot",
    "iosProbe",
    "androidProbe",
    "teardownServe",
    "teardownFunnel",
    "teardownShields",
    "teardownDisconnect",
)

ACCESS_TIMELINE_FIELDS = (
    "policyAppliedAt",
    "policyTestsPassedAt",
    "identitiesRevalidatedAt",
    "incomingEnabledAt",
    "shieldsUpBeforePolicy",
    "policyTestsResult",
    "unapprovedPeerHttps443",
    "policySha256",
    "configurationLogEventSha256",
    "activeShieldsSha256",
    "activeIdentityStatusSha256",
    "listenerSnapshotSha256",
    "listenerCapturedAt",
    "iosProbeSha256",
    "androidProbeSha256",
)


class RelayEvidenceError(RuntimeError):
    """A capture or continuity check failed closed."""


def _fail(message: str) -> NoReturn:
    raise RelayEvidenceError(message)


def _exact_keys(value: Any, expected: Sequence[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != set(expected):
        _fail(f"{name} does not have the exact reviewed fields.")
    return value


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("A JSON capture contains a duplicate key.")
        result[key] = value
    return result


def _reject_non_integer_number(_value: str) -> NoReturn:
    _fail("JSON capture numbers must be strict finite integers.")


def _secure_read_record(
    path_value: Any, name: str, maximum: int = MAX_JSON_BYTES
) -> tuple[bytes, tuple[int, int]]:
    if not isinstance(path_value, str):
        _fail(f"{name} capture path is absent.")
    try:
        encoded_path = os.fsencode(path_value)
    except UnicodeEncodeError as error:
        raise RelayEvidenceError(f"{name} capture path encoding is invalid.") from error
    if b"\x00" in encoded_path or len(encoded_path) > 4096:
        _fail(f"{name} capture path violates the bounded path contract.")
    path = Path(path_value)
    if not path.is_absolute() or os.path.normpath(path_value) != path_value:
        _fail(f"{name} capture path must be absolute and normalized.")
    try:
        before = path.lstat()
    except (OSError, ValueError) as error:
        raise RelayEvidenceError(f"{name} capture cannot be inspected.") from error
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        _fail(f"{name} capture must be a regular non-symlink file.")
    if stat.S_IMODE(before.st_mode) != 0o600 or before.st_uid != os.getuid():
        _fail(f"{name} capture must be current-user-owned mode 0600.")
    no_follow = getattr(os, "O_NOFOLLOW", None)
    if not isinstance(no_follow, int):
        _fail("This platform cannot enforce no-follow capture reads.")
    flags = (
        os.O_RDONLY
        | no_follow
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )
    try:
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or stat.S_IMODE(opened.st_mode) != 0o600
                or opened.st_uid != os.getuid()
                or opened.st_size < 1
                or opened.st_size > maximum
                or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
            ):
                _fail(f"{name} capture changed or violated its size/mode boundary.")
            chunks: list[bytes] = []
            remaining = opened.st_size
            while remaining:
                chunk = os.read(descriptor, min(65_536, remaining))
                if not chunk:
                    _fail(f"{name} capture ended unexpectedly.")
                chunks.append(chunk)
                remaining -= len(chunk)
            if os.read(descriptor, 1):
                _fail(f"{name} capture grew while being read.")
            after = os.fstat(descriptor)
            if (
                opened.st_dev,
                opened.st_ino,
                opened.st_size,
                opened.st_mtime_ns,
            ) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                _fail(f"{name} capture changed while being read.")
            return b"".join(chunks), (opened.st_dev, opened.st_ino)
        finally:
            os.close(descriptor)
    except (OSError, ValueError) as error:
        raise RelayEvidenceError(f"{name} capture could not be read safely.") from error


def _secure_read(path_value: Any, name: str, maximum: int = MAX_JSON_BYTES) -> bytes:
    return _secure_read_record(path_value, name, maximum)[0]


def _json(raw: bytes, name: str) -> dict[str, Any]:
    try:
        value = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_float=_reject_non_integer_number,
            parse_constant=_reject_non_integer_number,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RelayEvidenceError(f"{name} capture is not strict UTF-8 JSON.") from error
    if not isinstance(value, dict):
        _fail(f"{name} capture must be a JSON object.")
    return value


def _instant(value: Any, name: str) -> datetime:
    if not isinstance(value, str) or not ISO_INSTANT.fullmatch(value):
        _fail(f"{name} must be a canonical UTC instant with milliseconds.")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise RelayEvidenceError(f"{name} is not a real instant.") from error
    if parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" != value:
        _fail(f"{name} is not canonical.")
    return parsed


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _canonical(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def _source_capture_bundle_sha256(raws: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    digest.update(f"{SOURCE_CAPTURE_BUNDLE_SCHEMA}\n".encode("ascii"))
    for role in CAPTURE_NAMES:
        digest.update(f"{role}\n{_sha(raws[role])}\n".encode("ascii"))
    return digest.hexdigest()


def _capture(value: dict[str, Any], kind: str, fields: Sequence[str]) -> dict[str, Any]:
    result = _exact_keys(value, ("schemaVersion", "capturedAt", *fields), kind)
    if result["schemaVersion"] != f"{CAPTURE_SCHEMA_PREFIX}{kind}-capture-v1":
        _fail(f"{kind} capture schema is not supported.")
    _instant(result["capturedAt"], f"{kind}.capturedAt")
    return result


def _empty_persistent(value: Any, name: str) -> None:
    record = _exact_keys(value, ("TCP", "Web", "Services", "AllowFunnel"), name)
    if any(item != {} for item in record.values()):
        _fail(f"{name} must prove empty persistent Serve and Funnel state.")


def _serve(
    value: dict[str, Any],
    active: bool,
    kind: str,
    *,
    active_may_be_empty: bool = False,
) -> None:
    capture = _capture(value, kind, ("persistent", "foreground"))
    _empty_persistent(capture["persistent"], f"{kind}.persistent")
    foreground = capture["foreground"]
    if not isinstance(foreground, list):
        _fail(f"{kind}.foreground must be an array.")
    expected = [
        {
            "mode": "foreground",
            "httpsPort": 443,
            "handlerPath": "/",
            "upstream": "http://127.0.0.1:4000",
            "allowFunnel": False,
            "services": [],
        }
    ]
    allowed = (
        (expected, [])
        if active and active_may_be_empty
        else ((expected,) if active else ([],))
    )
    if foreground not in allowed:
        _fail(f"{kind} does not prove the exact reviewed foreground relay state.")


def _shields(
    value: dict[str, Any], expected: bool, kind: str, *, first_connection: bool = False
) -> None:
    fields = ("shieldsUp", "firstConnection") if first_connection else ("shieldsUp",)
    capture = _capture(value, kind, fields)
    if capture["shieldsUp"] is not expected:
        _fail(f"{kind} does not prove the required Shields Up state.")
    if first_connection and capture["firstConnection"] is not True:
        _fail(f"{kind} does not prove Shields Up on the Mac's first connection.")


def _identity(
    value: Any, alias: str, connected: bool | None, name: str
) -> tuple[str, str, str, str, str]:
    record = _exact_keys(
        value,
        (
            "alias",
            "nodeId",
            "userPrincipal",
            "tailscaleIpv4",
            "dnsName",
            "connected",
        ),
        name,
    )
    if record["alias"] != alias:
        _fail(f"{name} alias is not the reviewed device alias.")
    for field in ("nodeId", "userPrincipal"):
        if not isinstance(record[field], str) or not SAFE_ID.fullmatch(record[field]):
            _fail(f"{name}.{field} is not a bounded identity.")
    try:
        address = ipaddress.ip_address(record["tailscaleIpv4"])
    except ValueError as error:
        raise RelayEvidenceError(f"{name} has an invalid Tailscale address.") from error
    if (
        address.version != 4
        or address not in TAILSCALE_NETWORK
        or str(address) != record["tailscaleIpv4"]
    ):
        _fail(f"{name} address is not canonical Tailscale IPv4.")
    if not isinstance(record["dnsName"], str) or not TAILSCALE_DNS_NAME.fullmatch(
        record["dnsName"]
    ):
        _fail(f"{name} DNS name is not a canonical private .ts.net hostname.")
    if not isinstance(record["connected"], bool) or (
        connected is not None and record["connected"] is not connected
    ):
        _fail(f"{name} connection state is not the required state.")
    return (
        record["alias"],
        record["nodeId"],
        record["userPrincipal"],
        record["tailscaleIpv4"],
        record["dnsName"],
    )


def _identities(
    value: dict[str, Any], kind: str, mac_connected: bool | None
) -> dict[str, tuple[str, str, str, str, str]]:
    capture = _capture(value, kind, ("devices",))
    devices = _exact_keys(capture["devices"], DEVICE_ALIASES, f"{kind}.devices")
    result = {
        alias: _identity(
            devices[alias],
            alias,
            mac_connected
            if alias == "nutrition-tracker-mac"
            else (True if mac_connected is True else None),
            f"{kind}.{alias}",
        )
        for alias in DEVICE_ALIASES
    }
    if len({identity[1] for identity in result.values()}) != 3 or len(
        {identity[3] for identity in result.values()}
    ) != 3:
        _fail(f"{kind} must bind three distinct device identities and addresses.")
    if len({identity[4] for identity in result.values()}) != 3:
        _fail(f"{kind} must bind three distinct private DNS identities.")
    return result


def _origin(value: Any) -> str:
    if not isinstance(value, str) or value.strip() != value:
        _fail("apiOrigin must be an exact canonical HTTPS origin.")
    try:
        parsed = urlsplit(value)
        hostname = (parsed.hostname or "").lower()
    except ValueError as error:
        raise RelayEvidenceError("apiOrigin is structurally invalid.") from error
    labels = hostname.split(".")
    try:
        explicit_port = parsed.port
    except ValueError as error:
        raise RelayEvidenceError("apiOrigin contains an invalid port.") from error
    if (
        parsed.scheme != "https"
        or explicit_port is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or value != f"https://{hostname}"
        or len(labels) != 4
        or labels[-2:] != ["ts", "net"]
        or any(token in hostname for token in ("localstack", "postgres", "postgresql", "meilisearch"))
    ):
        _fail("apiOrigin is not the reviewed canonical private .ts.net HTTPS origin.")
    return value


def _probe(
    value: dict[str, Any],
    platform: str,
    build_id: str,
    identity: tuple[str, str, str, str, str],
    api_origin: str,
    ports: list[int],
    policy_sha: str,
    event_sha: str,
    started: datetime,
    executed: datetime,
) -> dict[str, Any]:
    kind = f"{platform}-probe"
    capture = _capture(
        value,
        kind,
        (
            "platform", "phoneAlias", "testedEasBuildId", "nodeId", "tailscaleIpv4", "apiOrigin",
            "publicCaAndHostname", "readyHttpStatus", "openTcpPorts", "blockedTcpPorts",
            "tailscaleDisabledHttps", "policySha256", "configurationLogEventSha256",
        ),
    )
    if not (started <= _instant(capture["capturedAt"], f"{kind}.capturedAt") <= executed):
        _fail(f"{kind} was not captured inside the active session.")
    expected_alias = PHONE_ALIASES[0 if platform == "ios" else 1]
    expected = {
        "platform": platform,
        "phoneAlias": expected_alias,
        "testedEasBuildId": build_id,
        "nodeId": identity[1],
        "tailscaleIpv4": identity[3],
        "apiOrigin": api_origin,
        "publicCaAndHostname": "passed",
        "readyHttpStatus": 200,
        "openTcpPorts": [443],
        "blockedTcpPorts": ports,
        "tailscaleDisabledHttps": "blocked",
        "policySha256": policy_sha,
        "configurationLogEventSha256": event_sha,
    }
    for field, expected_value in expected.items():
        if capture[field] != expected_value:
            _fail(f"{kind}.{field} does not match the reviewed session.")
    return {
        "testedEasBuildId": build_id,
        "phoneAlias": expected_alias,
        "observedAt": capture["capturedAt"],
        "policySha256": policy_sha,
        "configurationLogEventSha256": event_sha,
        "publicCaAndHostname": "passed",
        "readyHttpStatus": 200,
        "openTcpPorts": [443],
        "blockedTcpPorts": ports,
        "tailscaleDisabledHttps": "blocked",
    }


def normalize_relay_report_candidate(index_path: str) -> bytes:
    index_raw = _secure_read(index_path, "index")
    index = _exact_keys(
        _json(index_raw, "index"),
        (
            "schemaVersion",
            "trustBoundary",
            "apiOrigin",
            "startedAt",
            "executedAt",
            "completedAt",
            "buildIds",
            "captures",
        ),
        "index",
    )
    if index["schemaVersion"] != REVIEW_PACKAGE_SCHEMA:
        _fail("Review-package schema is not supported.")
    if index["trustBoundary"] != UNSIGNED_TRUST_BOUNDARY:
        _fail("Review package does not acknowledge the unsigned trust boundary.")
    api_origin = _origin(index["apiOrigin"])
    started = _instant(index["startedAt"], "startedAt")
    executed = _instant(index["executedAt"], "executedAt")
    completed = _instant(index["completedAt"], "completedAt")
    if not (started <= executed <= completed) or (
        completed - started
    ).total_seconds() > MAX_SESSION_SECONDS:
        _fail("Capture timing does not describe one session of at most 24 hours.")
    build_ids = _exact_keys(index["buildIds"], ("ios", "android"), "buildIds")
    if any(
        not isinstance(value, str) or not BUILD_ID.fullmatch(value)
        for value in build_ids.values()
    ) or len(set(build_ids.values())) != 2:
        _fail("Both captures must bind canonical EAS build IDs.")
    paths = _exact_keys(index["captures"], CAPTURE_NAMES, "captures")
    records = {
        name: _secure_read_record(
            paths[name], name, 1_048_576 if name == "listenerSnapshot" else MAX_JSON_BYTES
        )
        for name in CAPTURE_NAMES
    }
    raws = {name: record[0] for name, record in records.items()}
    if len({record[1] for record in records.values()}) != len(CAPTURE_NAMES):
        _fail("Every evidence role must use a distinct capture file.")
    data = {name: _json(raw, name) for name, raw in raws.items() if name != "listenerSnapshot"}

    _shields(
        data["preflightShields"],
        True,
        "preflight-shields",
        first_connection=True,
    )
    _serve(data["preflightServe"], False, "serve")
    _serve(data["preflightFunnel"], False, "funnel")
    preflight_ids = _identities(data["preflightIdentities"], "identities", True)
    _shields(data["activeShields"], False, "active-shields")
    _serve(data["activeServe"], True, "serve")
    _serve(data["activeFunnel"], True, "funnel", active_may_be_empty=True)
    active_ids = _identities(data["activeIdentities"], "identities", True)
    if active_ids != preflight_ids:
        _fail("Mac and phone identity/IP continuity changed between preflight and active testing.")
    if api_origin != f"https://{active_ids['nutrition-tracker-mac'][4]}":
        _fail("The private HTTPS origin does not belong to the reviewed Mac identity.")

    try:
        listeners = parse_lsof_snapshot(raws["listenerSnapshot"])
    except PhonePolicyError as error:
        raise RelayEvidenceError("Listener capture does not satisfy the reviewed bounded inventory.") from error
    phone_ips = [active_ids[alias][3] for alias in PHONE_ALIASES]
    mac_ip = active_ids["nutrition-tracker-mac"][3]
    try:
        expected_policy = build_phone_policy(phone_ips, mac_ip, listeners)
    except PhonePolicyError as error:
        raise RelayEvidenceError("Listener and identity captures cannot form a safe reviewed policy.") from error
    if data["policy"] != expected_policy:
        _fail("The reviewed full policy contains default allow, overlap, or a non-exact grant/test graph.")
    policy_sha = _sha(raws["policy"])
    event = _capture(data["configurationEvent"], "configuration-event", ("eventId", "eventType", "outcome", "policySha256"))
    if (
        not isinstance(event["eventId"], str)
        or not SAFE_ID.fullmatch(event["eventId"])
        or event["eventType"] != "policy-update"
        or event["outcome"] != "applied"
        or event["policySha256"] != policy_sha
    ):
        _fail("Configuration-log event does not bind the applied reviewed policy.")
    event_sha = _sha(raws["configurationEvent"])

    timeline = _capture(
        data["accessTimeline"],
        "access-timeline",
        ACCESS_TIMELINE_FIELDS,
    )
    times = [
        _instant(timeline[name], name)
        for name in ("policyAppliedAt", "policyTestsPassedAt", "identitiesRevalidatedAt", "incomingEnabledAt")
    ]
    timeline_time = _instant(timeline["capturedAt"], "accessTimeline.capturedAt")
    if (
        not (started <= times[0] <= times[1] <= times[2] <= times[3] <= executed)
        or timeline_time != times[3]
    ):
        _fail("Access-control timeline does not keep incoming access blocked through policy tests and identity review.")
    if (
        timeline["shieldsUpBeforePolicy"] is not True
        or timeline["policyTestsResult"] != "passed"
        or timeline["unapprovedPeerHttps443"] != "blocked"
        or timeline["policySha256"] != policy_sha
        or timeline["configurationLogEventSha256"] != event_sha
        or timeline["activeShieldsSha256"] != _sha(raws["activeShields"])
        or timeline["activeIdentityStatusSha256"] != _sha(raws["activeIdentities"])
        or timeline["listenerSnapshotSha256"] != _sha(raws["listenerSnapshot"])
        or timeline["iosProbeSha256"] != _sha(raws["iosProbe"])
        or timeline["androidProbeSha256"] != _sha(raws["androidProbe"])
    ):
        _fail("Access-control timeline is not bound to the reviewed policy, event, and Shields sequence.")

    preflight_capture_times = [
        _instant(data[name]["capturedAt"], f"{name}.capturedAt")
        for name in ("preflightShields", "preflightServe", "preflightFunnel", "preflightIdentities")
    ]
    active_capture_times = [
        _instant(data[name]["capturedAt"], f"{name}.capturedAt")
        for name in ("activeShields", "activeServe", "activeFunnel")
    ]
    active_identity_time = _instant(
        data["activeIdentities"]["capturedAt"], "activeIdentities.capturedAt"
    )
    teardown_capture_times = [
        _instant(data[name]["capturedAt"], f"{name}.capturedAt")
        for name in ("teardownServe", "teardownFunnel", "teardownShields", "teardownDisconnect")
    ]
    event_time = _instant(event["capturedAt"], "configurationEvent.capturedAt")
    listener_time = _instant(timeline["listenerCapturedAt"], "listenerCapturedAt")
    if (
        not (started <= preflight_capture_times[0] <= preflight_capture_times[1]
             <= preflight_capture_times[2] <= preflight_capture_times[3]
             <= listener_time <= times[0])
        or event_time != times[0]
        or active_identity_time != times[2]
        or not (times[3] <= active_capture_times[0] <= active_capture_times[1]
                <= active_capture_times[2] <= executed)
        or not (executed <= teardown_capture_times[0] <= teardown_capture_times[1]
                <= teardown_capture_times[2] <= teardown_capture_times[3] <= completed)
    ):
        _fail("Preflight, active, and teardown captures do not form one continuous reviewed session.")

    ports = sorted(BASELINE_DENIED_TCP_PORTS | {item.port for item in listeners if item.port != 443})
    wildcard_hosts = {"*", "0.0.0.0", "::", "[::]"}
    wildcard_ports = sorted(
        {item.port for item in listeners if item.port != 443 and item.host in wildcard_hosts}
    )
    active_ready_at = active_capture_times[2]
    ios_probe = _probe(data["iosProbe"], "ios", build_ids["ios"], active_ids[PHONE_ALIASES[0]], api_origin, ports, policy_sha, event_sha, active_ready_at, executed)
    android_probe = _probe(data["androidProbe"], "android", build_ids["android"], active_ids[PHONE_ALIASES[1]], api_origin, ports, policy_sha, event_sha, active_ready_at, executed)

    _serve(data["teardownServe"], False, "serve")
    _serve(data["teardownFunnel"], False, "funnel")
    _shields(data["teardownShields"], True, "teardown-shields")
    teardown_ids = _identities(data["teardownDisconnect"], "identities", False)
    if teardown_ids != preflight_ids:
        _fail("Mac and phone identity/IP continuity changed before disconnect.")

    report = {
        "schemaVersion": REPORT_SCHEMA,
        "trustBoundary": UNSIGNED_TRUST_BOUNDARY,
        "sourceCaptureBundleSha256": _source_capture_bundle_sha256(raws),
        "apiOrigin": api_origin,
        "startedAt": index["startedAt"],
        "executedAt": index["executedAt"],
        "completedAt": index["completedAt"],
        "preflight": {
            "firstConnectionShieldsUp": "passed", "initialServeAndFunnelStatus": "empty",
            "incomingAccessHeldUntilPolicyTests": "passed", "macIdentityRevalidated": "passed",
            "iosIdentityRevalidated": "passed", "androidIdentityRevalidated": "passed",
            "shieldsUpStatusSha256": _sha(raws["preflightShields"]),
            "initialServeStatusSha256": _sha(raws["preflightServe"]),
            "initialFunnelStatusSha256": _sha(raws["preflightFunnel"]),
            "identityStatusSha256": _sha(raws["preflightIdentities"]),
            "accessControlTimelineSha256": _sha(raws["accessTimeline"]),
        },
        "serve": {
            "mode": "foreground", "httpsPort": 443, "handlerPath": "/",
            "upstream": "http://127.0.0.1:4000", "persistentConfiguration": "empty",
            "foregroundSessionCount": 1, "funnelEnabled": False,
            "serveStatusSha256": _sha(raws["activeServe"]), "funnelStatusSha256": _sha(raws["activeFunnel"]),
        },
        "tailnetAccess": {
            "policySha256": policy_sha, "configurationLogEventSha256": event_sha,
            "approvedPhoneAliases": list(PHONE_ALIASES), "testedPhonesToMacTcp443Only": "passed",
            "noOverlappingAclOrGrant": "passed", "policyTests": "passed",
            "unapprovedPeerHttps443": "blocked",
        },
        "listenerInventory": {
            "snapshotSha256": _sha(raws["listenerSnapshot"]), "requiredServicesIpv4Loopback": "passed",
            "inventoriedNon443TcpPorts": ports, "wildcardNon443TcpPorts": wildcard_ports,
        },
        "deviceProbes": {"ios": ios_probe, "android": android_probe},
        "teardown": {
            "serveAndFunnelStatus": "empty", "shieldsUpRestored": "passed", "macDisconnected": "passed",
            "serveStatusSha256": _sha(raws["teardownServe"]), "funnelStatusSha256": _sha(raws["teardownFunnel"]),
            "shieldsUpStatusSha256": _sha(raws["teardownShields"]),
            "disconnectStatusSha256": _sha(raws["teardownDisconnect"]),
        },
    }
    return _canonical(report)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Structurally normalize a read-only relay review package into an unsigned "
            "canonical candidate; this does not create trusted release evidence."
        )
    )
    parser.add_argument(
        "--capture-index",
        required=True,
        help="Absolute mode-0600 no-follow review-package index path",
    )
    parser.add_argument(
        "--acknowledge-unsigned-candidate",
        action="store_true",
        required=True,
        help="Acknowledge that independent Ed25519 manifest review remains required",
    )
    return parser


def main(arguments: Sequence[str] | None = None) -> int:
    try:
        parsed = _parser().parse_args(arguments)
        sys.stdout.buffer.write(normalize_relay_report_candidate(parsed.capture_index))
        sys.stderr.write(
            "Unsigned structural candidate only; independent trusted Ed25519 manifest review remains required.\n"
        )
        return 0
    except RelayEvidenceError as error:
        sys.stderr.write(f"Relay evidence rejected: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
