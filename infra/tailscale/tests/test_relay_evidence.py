from __future__ import annotations

import ast
import base64
import hashlib
import io
import json
import os
import tempfile
import traceback
import unittest
from pathlib import Path
from unittest import mock

from infra.tailscale import phone_policy as POLICY
from infra.tailscale import relay_evidence as RELAY


ROOT = Path(__file__).resolve().parents[3]
MODULE = ROOT / "infra" / "tailscale" / "relay_evidence.py"
REFERENCE = ROOT / "infra" / "tailscale" / "relay-review-package-v2.md"
SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
IOS_BUILD = "11111111-1111-4111-8111-111111111111"
ANDROID_BUILD = "22222222-2222-4222-8222-222222222222"
ORIGIN = "https://relay.example.ts.net"
SOURCE_COMMIT = "a" * 40
SYNTHETIC_ADAPTER_ID = "test-synthetic-windows-contract-v1"
SYNTHETIC_VERSION = "0.0.0-test"
SYNTHETIC_SOURCE_SCHEMA = "nutrition-tracker-tailscale-protected-raw-source-v1"
LISTENER_PORTS = sorted(RELAY.BASELINE_DENIED_TCP_PORTS | {49231})


def _attribute_chain(node: ast.AST) -> tuple[str, ...] | None:
    parts: list[str] = []
    current = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if not isinstance(current, ast.Name):
        return None
    return (current.id, *reversed(parts))


def noncollecting_surface_violations(source: str) -> list[str]:
    """Return AST capabilities outside the reviewed read-only producer surface."""

    tree = ast.parse(source)
    violations: list[str] = []
    allowed_plain_imports = {
        "argparse",
        "base64",
        "binascii",
        "ctypes",
        "hashlib",
        "json",
        "os",
        "re",
        "stat",
        "sys",
    }
    allowed_from_imports = {
        "__future__": {"annotations"},
        "collections.abc": {"Callable", "Mapping", "Sequence"},
        "dataclasses": {"dataclass"},
        "datetime": {"datetime", "timezone"},
        "infra.tailscale.phone_policy": {
            "build_phone_policy",
            "parse_phone_policy_input",
        },
        "pathlib": {"Path"},
        "phone_policy": {"build_phone_policy", "parse_phone_policy_input"},
        "types": {"MappingProxyType"},
        "typing": {"Any", "NoReturn"},
    }
    allowed_direct_calls = {
        "CaptureRecord",
        "MappingProxyType",
        "OSError",
        "Path",
        "RelayEvidenceError",
        "RuntimeError",
        "SystemExit",
        "_QuietArgumentParser",
        "_StatFs",
        "_approved_probe_report",
        "_assert_adapter_metadata",
        "_assert_adapter_observations",
        "_assert_approved_probe",
        "_assert_bounded_json_nesting",
        "_assert_boundaries",
        "_assert_host_boundary",
        "_assert_observation_field_ownership",
        "_assert_policy",
        "_assert_reachability",
        "_assert_restart",
        "_assert_session_ledger",
        "_assert_sha",
        "_assert_stable_entry_at",
        "_assert_timing",
        "_assert_versions_and_environment",
        "_boundary_phase",
        "_bounded_integer",
        "_canonical",
        "_canonical_json",
        "_capture_filename",
        "_checked_review_directory",
        "_contains_git_metadata",
        "_core_observation_fields",
        "_creation_chronology",
        "_decode_mount_field",
        "_decode_raw_source",
        "_directory_identity",
        "_exact_keys",
        "_fail",
        "_file_state",
        "_filesystem_magic",
        "_instant",
        "_json",
        "_lan_probe_report",
        "_native_linux_filesystem",
        "_normalized_observation_sha256",
        "_observation_fields",
        "_open_review_directory",
        "_parse_capture",
        "_parser",
        "_probe_set",
        "_readiness_report",
        "_report_candidate",
        "_role_schema",
        "_roles_for_phase",
        "_secure_read_at",
        "_sha",
        "_sorted_ports",
        "_source_capture_bundle_sha256",
        "_source_observation_fields",
        "_unapproved_probe_report",
        "any",
        "api_origin_commitment_sha256",
        "build_phone_policy",
        "callable",
        "chr",
        "dataclass",
        "dict",
        "frozenset",
        "fstatfs",
        "getattr",
        "int",
        "isinstance",
        "len",
        "list",
        "main",
        "max",
        "min",
        "normalize_relay_report_candidate",
        "open",
        "parse_phone_policy_input",
        "set",
        "sorted",
        "tuple",
        "zip",
    }
    allowed_attribute_call_targets = {
        "(ancestor / '.git').lstat",
        "(completed - started).total_seconds",
        "(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'), "
        "sort_keys=True) + '\\n').encode",
        "BASELINE_DENIED_TCP_PORTS.issubset",
        "GIT_COMMIT.fullmatch",
        "INCOMING_STATES.items",
        "ISO_INSTANT.fullmatch",
        "PRIVATE_ORIGIN.fullmatch",
        "SAFE_ADAPTER_ID.fullmatch",
        "SAFE_VERSION.fullmatch",
        "SERVE_STATES.items",
        "SHA256_HEX.fullmatch",
        "STANDARD_BASE64.fullmatch",
        "UUID.fullmatch",
        "_parser().parse_args",
        "adapters.get",
        "b''.join",
        "base64.b64decode",
        "base64.b64encode",
        "base64.b64encode(raw).decode",
        "build_ids.values",
        "candidates.append",
        "chunks.append",
        "ctypes.CDLL",
        "ctypes.POINTER",
        "ctypes.byref",
        "core_owned.add",
        "core_owned.update",
        "ctypes.get_errno",
        "datetime.strptime",
        "datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%fZ').replace",
        "digest.hexdigest",
        "digest.update",
        "endpoints.append",
        "expected.items",
        "expected_links.items",
        "expected_results.items",
        "f'{ORIGIN_COMMITMENT_DOMAIN}\\n{origin}\\n'.encode",
        "f'{SOURCE_CAPTURE_BUNDLE_SCHEMA}\\n'.encode",
        "f'{role}\\n{records[role].sha256}\\n'.encode",
        "hashlib.sha256",
        "hashlib.sha256(READY_BODY).hexdigest",
        "hashlib.sha256(raw).hexdigest",
        "index_path.is_absolute",
        "inventories.append",
        "json.dumps",
        "json.loads",
        "left.split",
        "line.split",
        "match.group",
        "mount_file.read",
        "normalizer.normalize",
        "os.close",
        "os.fsencode",
        "os.fstat",
        "os.getuid",
        "os.lstat",
        "os.major",
        "os.minor",
        "os.open",
        "os.path.normpath",
        "os.read",
        "os.stat",
        "parsed.strftime",
        "parser.add_argument",
        "part.casefold",
        "path.is_absolute",
        "path.relative_to",
        "path.stat",
        "raw.decode",
        "raw_records.items",
        "raw_records.values",
        "re.compile",
        "re.sub",
        "re.sub('(?<!^)(?=[A-Z])', '-', role).lower",
        "record.captured_at.strftime",
        "record.observation.get",
        "records.items",
        "records.values",
        "records[role].captured_at.strftime",
        "required.items",
        "review_directory.lstat",
        "review_directory.resolve",
        "right.split",
        "role_samples.append",
        "role.endswith",
        "stat.S_IMODE",
        "stat.S_ISDIR",
        "stat.S_ISLNK",
        "stat.S_ISREG",
        "sys.stderr.write",
        "sys.stdout.buffer.write",
        "text.splitlines",
        "union.update",
    }
    allowed_module_attributes = {
        "argparse.ArgumentParser",
        "base64.b64decode",
        "base64.b64encode",
        "binascii.Error",
        "ctypes.CDLL",
        "ctypes.POINTER",
        "ctypes.Structure",
        "ctypes.byref",
        "ctypes.c_int",
        "ctypes.c_long",
        "ctypes.c_ulong",
        "ctypes.get_errno",
        "datetime.strptime",
        "hashlib.sha256",
        "json.JSONDecodeError",
        "json.dumps",
        "json.loads",
        "os.O_RDONLY",
        "os.close",
        "os.fsencode",
        "os.fstat",
        "os.getuid",
        "os.lstat",
        "os.major",
        "os.minor",
        "os.open",
        "os.path",
        "os.path.normpath",
        "os.read",
        "os.stat",
        "os.stat_result",
        "re.compile",
        "re.sub",
        "stat.S_IMODE",
        "stat.S_ISDIR",
        "stat.S_ISLNK",
        "stat.S_ISREG",
        "sys.platform",
        "sys.stderr",
        "sys.stderr.write",
        "sys.stdout",
        "sys.stdout.buffer",
        "sys.stdout.buffer.write",
        "timezone.utc",
    }
    allowed_declarations = {
        "AdapterCorpusSample",
        "AdapterCorpusMetadata",
        "CaptureRecord",
        "NormalizedObservation",
        "RelayEvidenceError",
        "RoleNormalizer",
        "VersionAdapter",
        "_QuietArgumentParser",
        "_StatFs",
        "_approved_probe_report",
        "_assert_adapter_metadata",
        "_assert_adapter_observations",
        "_assert_approved_probe",
        "_assert_bounded_json_nesting",
        "_assert_boundaries",
        "_assert_host_boundary",
        "_assert_observation_field_ownership",
        "_assert_policy",
        "_assert_reachability",
        "_assert_restart",
        "_assert_session_ledger",
        "_assert_sha",
        "_assert_stable_entry_at",
        "_assert_timing",
        "_assert_versions_and_environment",
        "_boundary_phase",
        "_bounded_integer",
        "_canonical",
        "_canonical_json",
        "_capture_filename",
        "_capture_hashes",
        "_checked_review_directory",
        "_contains_git_metadata",
        "_core_observation_fields",
        "_creation_chronology",
        "_decode_mount_field",
        "_decode_raw_source",
        "_directory_identity",
        "_exact_keys",
        "_fail",
        "_file_state",
        "_filesystem_magic",
        "_instant",
        "_json",
        "_lan_probe_report",
        "_native_linux_filesystem",
        "_normalized_observation_sha256",
        "_observation_fields",
        "_open_review_directory",
        "_parse_capture",
        "_parser",
        "_probe_set",
        "_readiness_report",
        "_reject_duplicate_keys",
        "_reject_non_integer_number",
        "_report_candidate",
        "_role_schema",
        "_roles_for_phase",
        "_secure_read_at",
        "_sha",
        "_sorted_ports",
        "_source_capture_bundle_sha256",
        "_source_observation_fields",
        "_unapproved_probe_report",
        "api_origin_commitment_sha256",
        "error",
        "main",
        "normalize_relay_report_candidate",
        "sha256",
    }
    controlled_roots = {
        "argparse",
        "base64",
        "binascii",
        "ctypes",
        "datetime",
        "hashlib",
        "json",
        "os",
        "re",
        "stat",
        "sys",
        "timezone",
    } | allowed_direct_calls
    allowed_getattrs = {
        "getattr(os, 'O_CLOEXEC', 0)",
        "getattr(os, 'O_DIRECTORY', None)",
        "getattr(os, 'O_NOFOLLOW', None)",
        "getattr(os, 'O_NONBLOCK', 0)",
    }
    allowed_os_opens = {
        "os.open(path, os.O_RDONLY | no_follow | directory_flag | getattr(os, 'O_CLOEXEC', 0))",
        "os.open(name, os.O_RDONLY | no_follow | getattr(os, 'O_CLOEXEC', 0) | "
        "getattr(os, 'O_NONBLOCK', 0), dir_fd=directory_descriptor)",
    }
    allowed_ctypes_calls = {
        "ctypes.CDLL(None, use_errno=True)",
        "ctypes.POINTER(_StatFs)",
        "ctypes.byref(result)",
        "ctypes.get_errno()",
    }
    allowed_json_loads = (
        "json.loads(raw.decode('utf-8', errors='strict'), "
        "object_pairs_hook=_reject_duplicate_keys, parse_int=_bounded_integer, "
        "parse_float=_reject_non_integer_number, parse_constant=_reject_non_integer_number)"
    )
    imported_names = allowed_plain_imports | {
        name for names in allowed_from_imports.values() for name in names
    }
    non_rebindable_names = (
        imported_names | allowed_direct_calls | (allowed_declarations - {"error", "sha256"})
    )

    def binding_names(target: ast.AST) -> set[str]:
        if isinstance(target, ast.Name):
            return {target.id}
        if isinstance(target, ast.Starred):
            return binding_names(target.value)
        if isinstance(target, (ast.List, ast.Tuple)):
            return {name for item in target.elts for name in binding_names(item)}
        return set()

    capability_attribute_targets = allowed_module_attributes | allowed_attribute_call_targets | {
        "libc.fstatfs",
        "fstatfs.argtypes",
        "fstatfs.restype",
    }

    def contains_capability_reference(value: ast.AST | None) -> bool:
        if value is None or isinstance(value, ast.Constant):
            return False
        if isinstance(value, ast.Name):
            return value.id in controlled_roots | {"libc", "fstatfs"}
        if isinstance(value, ast.Attribute):
            chain = _attribute_chain(value)
            rendered = ast.unparse(value)
            return (
                (chain is not None and chain[0] in controlled_roots | {"libc", "fstatfs"})
                or rendered in capability_attribute_targets
            )
        if isinstance(value, (ast.Call, ast.Lambda)):
            return False
        return any(
            contains_capability_reference(child)
            for child in ast.iter_child_nodes(value)
            if isinstance(child, ast.expr)
        )

    expected_assignments = {
        "libc": "libc = ctypes.CDLL(None, use_errno=True)",
        "fstatfs": "fstatfs = libc.fstatfs",
    }
    allowed_attribute_assignments = {
        "fstatfs.argtypes = (ctypes.c_int, ctypes.POINTER(_StatFs))",
        "fstatfs.restype = ctypes.c_int",
    }
    expected_import_statements = {
        "from __future__ import annotations",
        "from collections.abc import Callable, Mapping, Sequence",
        "from dataclasses import dataclass",
        "from datetime import datetime, timezone",
        "from infra.tailscale.phone_policy import build_phone_policy, parse_phone_policy_input",
        "from pathlib import Path",
        "from phone_policy import build_phone_policy, parse_phone_policy_input",
        "from types import MappingProxyType",
        "from typing import Any, NoReturn",
        "import argparse",
        "import base64",
        "import binascii",
        "import ctypes",
        "import hashlib",
        "import json",
        "import os",
        "import re",
        "import stat",
        "import sys",
    }

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname is not None or alias.name not in allowed_plain_imports:
                    violations.append(f"unapproved import: {ast.unparse(node)}")
        elif isinstance(node, ast.ImportFrom):
            names = allowed_from_imports.get(node.module or "")
            if (
                node.level != 0
                or names is None
                or any(alias.asname is not None or alias.name not in names for alias in node.names)
            ):
                violations.append(f"unapproved from-import: {ast.unparse(node)}")
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            if node.id in non_rebindable_names - {"fstatfs"}:
                violations.append(f"rebound protected name: {node.id}")
        elif isinstance(node, ast.arg) and node.arg in non_rebindable_names | {"libc", "fstatfs"}:
            violations.append(f"protected parameter name: {node.arg}")
        elif isinstance(node, ast.Attribute):
            chain = _attribute_chain(node)
            if chain is None:
                continue
            rendered = ".".join(chain)
            if chain[0] == "libc":
                if rendered != "libc.fstatfs":
                    violations.append(f"unapproved libc attribute: {rendered}")
            elif chain[0] == "fstatfs":
                if rendered not in {
                    "fstatfs.argtypes",
                    "fstatfs.restype",
                }:
                    violations.append(f"unapproved fstatfs attribute: {rendered}")
            elif chain[0] in controlled_roots and rendered not in allowed_module_attributes:
                violations.append(f"unapproved protected attribute: {rendered}")
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                parent_assignment = next(
                    (
                        candidate
                        for candidate in ast.walk(tree)
                        if isinstance(candidate, (ast.Assign, ast.AnnAssign, ast.AugAssign))
                        and node in ast.walk(candidate)
                    ),
                    None,
                )
                if parent_assignment is None or ast.unparse(parent_assignment) not in allowed_attribute_assignments:
                    violations.append(f"unapproved attribute binding: {rendered}")
        elif isinstance(node, ast.Call):
            rendered = ast.unparse(node)
            if isinstance(node.func, ast.Name):
                if node.func.id not in allowed_direct_calls:
                    violations.append(f"unapproved direct call: {node.func.id}")
                elif node.func.id == "getattr" and rendered not in allowed_getattrs:
                    violations.append(f"unapproved getattr call: {rendered}")
                elif node.func.id == "open" and rendered != (
                    "open('/proc/self/mountinfo', 'rb', buffering=0)"
                ):
                    violations.append(f"unapproved built-in open call: {rendered}")
                elif node.func.id == "fstatfs" and rendered != (
                    "fstatfs(descriptor, ctypes.byref(result))"
                ):
                    violations.append(f"unapproved fstatfs call: {rendered}")
            elif isinstance(node.func, ast.Attribute):
                target = ast.unparse(node.func)
                if target not in allowed_attribute_call_targets:
                    violations.append(f"unapproved receiver/call target: {target}")
                elif target == "os.open" and rendered not in allowed_os_opens:
                    violations.append(f"unapproved os.open call: {rendered}")
                elif target.startswith("ctypes.") and rendered not in allowed_ctypes_calls:
                    violations.append(f"unapproved ctypes call: {rendered}")
                elif target == "json.loads" and rendered != allowed_json_loads:
                    violations.append(f"unapproved JSON parser call: {rendered}")
                elif target in {"sys.stdout.buffer.write", "sys.stderr.write"}:
                    enclosing = [
                        candidate
                        for candidate in ast.walk(tree)
                        if isinstance(candidate, (ast.FunctionDef, ast.AsyncFunctionDef))
                        and node in ast.walk(candidate)
                    ]
                    approved_outputs = {
                        "sys.stdout.buffer.write(normalized_output)",
                        "sys.stderr.write('Unsigned structural candidate only; independent trusted Ed25519 manifest review remains required.\\n')",
                        "sys.stderr.write(f'Relay evidence rejected: {error}\\n')",
                    }
                    if (
                        len(enclosing) != 1
                        or enclosing[0].name != "main"
                        or rendered not in approved_outputs
                    ):
                        violations.append(f"unapproved scoped output call: {rendered}")
            else:
                violations.append(f"unapproved dynamic call target: {ast.unparse(node.func)}")
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if node.name in non_rebindable_names and node.name not in allowed_declarations:
                violations.append(f"declaration rebinds protected name: {node.name}")
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and any(
                contains_capability_reference(default)
                for default in (*node.args.defaults, *node.args.kw_defaults)
            ):
                violations.append(f"protected callable default alias in {node.name}")
        elif isinstance(node, ast.Lambda) and any(
            contains_capability_reference(default)
            for default in (*node.args.defaults, *node.args.kw_defaults)
        ):
            violations.append("protected callable default alias in lambda")
        elif isinstance(node, ast.NamedExpr):
            if contains_capability_reference(node.value):
                violations.append(f"protected named-expression alias: {ast.unparse(node)}")
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            if binding_names(node.target) and contains_capability_reference(node.iter):
                violations.append(f"protected loop alias: {ast.unparse(node.target)}")
        elif isinstance(node, ast.comprehension):
            if binding_names(node.target) and contains_capability_reference(node.iter):
                violations.append(f"protected comprehension alias: {ast.unparse(node.target)}")
        elif isinstance(node, ast.withitem):
            if (
                node.optional_vars is not None
                and binding_names(node.optional_vars)
                and contains_capability_reference(node.context_expr)
            ):
                violations.append(f"protected with-item alias: {ast.unparse(node.optional_vars)}")
        elif isinstance(node, ast.ExceptHandler):
            if node.name in non_rebindable_names | {"libc", "fstatfs"}:
                violations.append(f"exception handler rebinds protected name: {node.name}")
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)):
            if node.name in non_rebindable_names | {"libc", "fstatfs"}:
                violations.append(f"pattern rebinds protected name: {node.name}")
        elif isinstance(node, ast.MatchMapping):
            if node.rest in non_rebindable_names | {"libc", "fstatfs"}:
                violations.append(f"mapping pattern rebinds protected name: {node.rest}")

    assignments = {
        name: [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)
        ]
        for name in ("libc", "fstatfs")
    }
    for name, nodes in assignments.items():
        if len(nodes) != 1 or ast.unparse(nodes[0]) != expected_assignments[name]:
            violations.append(f"unapproved {name} binding")
    special_store_counts = {
        name: sum(
            1
            for node in ast.walk(tree)
            if isinstance(node, ast.Name)
            and node.id == name
            and isinstance(node.ctx, (ast.Store, ast.Del))
        )
        for name in ("libc", "fstatfs")
    }
    if special_store_counts != {"libc": 1, "fstatfs": 1}:
        violations.append("libc/fstatfs names were rebound")

    declaration_counts = {
        name: sum(
            1
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            and node.name == name
        )
        for name in allowed_declarations
    }
    if any(count != 1 for count in declaration_counts.values()):
        violations.append("reviewed producer declarations were missing or rebound")

    for node in ast.walk(tree):
        if not isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else (node.target,)
        names = {name for target in targets for name in binding_names(target)}
        value = node.value if isinstance(node, (ast.Assign, ast.AnnAssign)) else node.value
        rendered = ast.unparse(node)
        if names & non_rebindable_names and rendered != expected_assignments["fstatfs"]:
            violations.append(f"assignment rebinds protected name: {rendered}")
        if (
            names
            and contains_capability_reference(value)
            and rendered != expected_assignments["fstatfs"]
            and names != {"_fields_"}
        ):
            violations.append(f"protected capability alias: {rendered}")

    normalized_output_bindings = [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign))
        and "normalized_output"
        in {
            name
            for target in (
                node.targets if isinstance(node, ast.Assign) else (node.target,)
            )
            for name in binding_names(target)
        }
    ]
    normalized_output_binding_parents = (
        [
            candidate
            for candidate in ast.walk(tree)
            if isinstance(candidate, (ast.FunctionDef, ast.AsyncFunctionDef))
            and normalized_output_bindings[0] in ast.walk(candidate)
        ]
        if len(normalized_output_bindings) == 1
        else []
    )
    if (
        len(normalized_output_bindings) != 1
        or ast.unparse(normalized_output_bindings[0])
        != "normalized_output = normalize_relay_report_candidate(parsed.capture_index)"
        or len(normalized_output_binding_parents) != 1
        or normalized_output_binding_parents[0].name != "main"
    ):
        violations.append("normalized output was not bound exactly once to the protected normalizer")

    observed_import_statements = [
        ast.unparse(node)
        for node in ast.walk(tree)
        if isinstance(node, (ast.Import, ast.ImportFrom))
    ]
    if len(observed_import_statements) != len(expected_import_statements) or set(
        observed_import_statements
    ) != expected_import_statements:
        violations.append("reviewed imports were missing, duplicated, reordered by shape, or rebound")
    return sorted(set(violations))
LISTENER_BINDINGS = [{"host": "127.0.0.1", "port": port} for port in LISTENER_PORTS]
POLICY_LISTENERS = [
    {"host": "127.0.0.1", "port": port}
    for port in sorted(POLICY.REQUIRED_LOOPBACK_PORTS | {1025, 2181, 8025, 8080, 8081, 9092, 49231})
]


def compact(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True) + "\n").encode()


def digest(value: bytes | str) -> str:
    raw = value.encode() if isinstance(value, str) else value
    return hashlib.sha256(raw).hexdigest()


def instant(minute: int, second: int = 0) -> str:
    return f"2026-08-28T00:{minute:02d}:{second:02d}.000Z"


def synthetic_corpus(
    *,
    adapter_id: str = SYNTHETIC_ADAPTER_ID,
    adapter_kind: str = "test",
    platform: str = RELAY.ADAPTER_PLATFORM,
    schema_version: str = RELAY.ADAPTER_CORPUS_SCHEMA,
    windows_version: str = "11.0.26100",
    wsl_version: str = "2.5.10.0",
    ubuntu_version: str = "24.04",
    docker_desktop_version: str = "4.44.3",
    docker_engine_version: str = "29.0.0",
    tailscale_client_version: str = SYNTHETIC_VERSION,
    tailscale_daemon_version: str = SYNTHETIC_VERSION,
    client_help_sha256: str = digest("client-help"),
    daemon_help_sha256: str = digest("daemon-help"),
    samples: tuple[RELAY.AdapterCorpusSample, ...] | None = None,
    corpus_manifest: bytes | None = None,
) -> RELAY.AdapterCorpusMetadata:
    if samples is None:
        sample_bundle = CaptureBundle(
            Path("/synthetic-corpus-unused"),
            session_id="dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            windows_version=windows_version,
            wsl_version=wsl_version,
            ubuntu_version=ubuntu_version,
            docker_desktop_version=docker_desktop_version,
            docker_engine_version=docker_engine_version,
            tailscale_client_version=tailscale_client_version,
            tailscale_daemon_version=tailscale_daemon_version,
            client_help_sha256=client_help_sha256,
            daemon_help_sha256=daemon_help_sha256,
        )
        sample_bundle.build()
        sample_sources = {
            role: base64.b64decode(
                json.loads(sample_bundle.raws[role])["rawSourceBase64"],
                validate=True,
            )
            for role in RELAY.CAPTURE_NAMES
        }
        samples = tuple(
            RELAY.AdapterCorpusSample(
                role=role,
                raw_source=sample_sources[role],
                expected=synthetic_normalize(role, sample_sources[role]),
            )
            for role in RELAY.CAPTURE_NAMES
        )
    if corpus_manifest is None:
        corpus_manifest = compact(
            {
                "schemaVersion": schema_version,
                "adapterId": adapter_id,
                "adapterKind": adapter_kind,
                "platform": platform,
                "roleSamples": [
                    {
                        "role": sample.role,
                        "sourceSha256": digest(sample.raw_source),
                        "normalizedSha256": RELAY._normalized_observation_sha256(
                            sample.expected,
                            sample.role,
                            sample.raw_source,
                        ),
                    }
                    for sample in samples
                ],
                "windowsVersion": windows_version,
                "wslVersion": wsl_version,
                "ubuntuVersion": ubuntu_version,
                "dockerDesktopVersion": docker_desktop_version,
                "dockerEngineVersion": docker_engine_version,
                "tailscaleClientVersion": tailscale_client_version,
                "tailscaleDaemonVersion": tailscale_daemon_version,
                "clientHelpSha256": client_help_sha256,
                "daemonHelpSha256": daemon_help_sha256,
            }
        )
    return RELAY.AdapterCorpusMetadata(
        adapter_kind=adapter_kind,
        platform=platform,
        schema_version=schema_version,
        windows_version=windows_version,
        wsl_version=wsl_version,
        ubuntu_version=ubuntu_version,
        docker_desktop_version=docker_desktop_version,
        docker_engine_version=docker_engine_version,
        tailscale_client_version=tailscale_client_version,
        tailscale_daemon_version=tailscale_daemon_version,
        client_help_sha256=client_help_sha256,
        daemon_help_sha256=daemon_help_sha256,
        samples=samples,
        corpus_manifest=corpus_manifest,
    )


def synthetic_source(
    role: str,
    session_id: str,
    captured_at: str,
    raw_output: bytes,
) -> bytes:
    return compact(
        {
            "schemaVersion": SYNTHETIC_SOURCE_SCHEMA,
            "role": role,
            "sessionId": session_id,
            "capturedAt": captured_at,
            "rawOutputSha256": digest(raw_output),
            "rawOutputBase64": base64.b64encode(raw_output).decode("ascii"),
        }
    )


def synthetic_normalize(role: str, raw: bytes) -> RELAY.NormalizedObservation:
    protected = RELAY._exact_keys(
        RELAY._canonical_json(raw, f"{role} synthetic protected source"),
        (
            "schemaVersion",
            "role",
            "sessionId",
            "capturedAt",
            "rawOutputSha256",
            "rawOutputBase64",
        ),
        f"{role} synthetic protected source",
    )
    if protected["schemaVersion"] != SYNTHETIC_SOURCE_SCHEMA:
        raise RELAY.RelayEvidenceError("Synthetic protected-source schema drifted.")
    raw_output = base64.b64decode(protected["rawOutputBase64"], validate=True)
    if digest(raw_output) != protected["rawOutputSha256"]:
        raise RELAY.RelayEvidenceError("Synthetic protected-source digest drifted.")
    value = RELAY._canonical_json(raw_output, f"{role} synthetic raw output")
    if role == "policyProposal":
        parsed = POLICY.parse_phone_policy_input(value)
        expected_policy = POLICY.build_phone_policy(
            parsed.phone_tailscale_ipv4,
            parsed.relay_host_tailscale_ipv4,
            parsed.listeners,
        )
        derived = {"policyInput": value, "policy": expected_policy}
    elif role == "policy":
        derived = {"policy": value}
    else:
        derived = {
            field: value[field]
            for field in RELAY._source_observation_fields(role)
        }
    return RELAY.NormalizedObservation(
        role=protected["role"],
        session_id=protected["sessionId"],
        captured_at=protected["capturedAt"],
        source_sha256=digest(raw),
        raw_output=raw_output,
        observation_json=compact(derived),
    )


def synthetic_normalizer_for(role: str):
    def normalize(raw: bytes):
        return synthetic_normalize(role, raw)

    return normalize


def synthetic_version_adapter(
    *,
    adapter_id: str = SYNTHETIC_ADAPTER_ID,
    corpus: RELAY.AdapterCorpusMetadata | None = None,
    role_normalizers: tuple[RELAY.RoleNormalizer, ...] | None = None,
) -> RELAY.VersionAdapter:
    if corpus is None:
        corpus = synthetic_corpus(adapter_id=adapter_id)
    if role_normalizers is None:
        role_normalizers = tuple(
            RELAY.RoleNormalizer(role=role, normalize=synthetic_normalizer_for(role))
            for role in RELAY.CAPTURE_NAMES
        )
    return RELAY.VersionAdapter(
        adapter_id=adapter_id,
        corpus=corpus,
        role_normalizers=role_normalizers,
    )


def normalize_synthetic(index_path: Path) -> bytes:
    adapter = synthetic_version_adapter()
    return RELAY.normalize_relay_report_candidate(
        str(index_path), adapters={adapter.adapter_id: adapter}
    )


class CaptureBundle:
    def __init__(
        self,
        root: Path,
        *,
        policy_listeners: list[dict[str, object]] | None = None,
        session_id: str = SESSION_ID,
        windows_version: str = "11.0.26100",
        wsl_version: str = "2.5.10.0",
        ubuntu_version: str = "24.04",
        docker_desktop_version: str = "4.44.3",
        docker_engine_version: str = "29.0.0",
        tailscale_client_version: str = SYNTHETIC_VERSION,
        tailscale_daemon_version: str = SYNTHETIC_VERSION,
        client_help_sha256: str = digest("client-help"),
        daemon_help_sha256: str = digest("daemon-help"),
    ):
        self.root = root
        self.session_id = session_id
        self.windows_version = windows_version
        self.wsl_version = wsl_version
        self.ubuntu_version = ubuntu_version
        self.docker_desktop_version = docker_desktop_version
        self.docker_engine_version = docker_engine_version
        self.tailscale_client_version = tailscale_client_version
        self.tailscale_daemon_version = tailscale_daemon_version
        self.client_help_sha256 = client_help_sha256
        self.daemon_help_sha256 = daemon_help_sha256
        self.paths: dict[str, str] = {}
        self.raws: dict[str, bytes] = {}
        self.times = self._times()
        selected = POLICY_LISTENERS if policy_listeners is None else policy_listeners
        self.policy_listeners = [dict(listener) for listener in selected]

    @staticmethod
    def _times() -> dict[str, str]:
        return {
            role: instant(index // 60, index % 60)
            for index, role in enumerate(RELAY._creation_chronology())
        }

    def add(self, role: str, observation: dict[str, object], *, source: bytes | None = None) -> None:
        raw_output = compact(observation) if source is None else source
        raw_source = synthetic_source(
            role,
            self.session_id,
            self.times[role],
            raw_output,
        )
        envelope = {
            "schemaVersion": RELAY._role_schema(role),
            "sessionId": self.session_id,
            "capturedAt": self.times[role],
            "rawSourceSha256": digest(raw_source),
            "rawSourceBase64": base64.b64encode(raw_source).decode("ascii"),
            "observation": observation,
        }
        self.raws[role] = compact(envelope)

    def environment(self, role: str, host_sha: str) -> dict[str, object]:
        return {
            "adapterId": SYNTHETIC_ADAPTER_ID,
            "windowsVersion": self.windows_version,
            "wslVersion": self.wsl_version,
            "ubuntuVersion": self.ubuntu_version,
            "dockerDesktopVersion": self.docker_desktop_version,
            "dockerEngineVersion": self.docker_engine_version,
            "tailscaleClientVersion": self.tailscale_client_version,
            "tailscaleDaemonVersion": self.tailscale_daemon_version,
            "clientHelpSha256": self.client_help_sha256,
            "daemonHelpSha256": self.daemon_help_sha256,
            "rawStatusSha256": digest(f"{role}-status"),
            "linuxContainers": True,
            "dockerDesktopWslIntegration": True,
            "dockerUnixSocket": "local",
            "tailscaleInWsl": False,
            "secondDockerEngineInWsl": False,
            "sourceHead": SOURCE_COMMIT,
            "sourceTreeClean": True,
            "apiProcessSha256": digest("api-process"),
            "apiCwdSha256": digest("api-cwd"),
            "hostBoundarySha256": host_sha,
        }

    def identity(self, role: str, host_sha: str, *, connected: bool = True) -> dict[str, object]:
        return {
            "adapterId": SYNTHETIC_ADAPTER_ID,
            "relayHostIdentitySha256": digest("relay-host-identity"),
            "iosIdentitySha256": digest("ios-identity"),
            "androidIdentitySha256": digest("android-identity"),
            "relayHostConnected": connected,
            "phonesConnected": True,
            "hostBoundarySha256": host_sha,
        }

    def build(self) -> None:
        host_boundary = {
            "relayNode": "windows-host",
            "applicationNode": "wsl2-ubuntu",
            "containerProvider": "docker-desktop-wsl-integration",
            "tailscalePlacement": "windows-host-only",
            "apiBind": "127.0.0.1:4000",
            "serveUpstream": "http://127.0.0.1:4000",
            "wslNetworkingMode": "nat",
        }
        self.add("hostBoundary", host_boundary)
        host_sha = digest(self.raws["hostBoundary"])

        for role in RELAY.ENVIRONMENT_ROLES:
            self.add(role, self.environment(role, host_sha))
        for role, state in RELAY.INCOMING_STATES.items():
            self.add(
                role,
                {"adapterId": SYNTHETIC_ADAPTER_ID, "state": state, "hostBoundarySha256": host_sha},
            )
        for role in RELAY.IDENTITY_ROLES:
            self.add(role, self.identity(role, host_sha, connected=role != "teardownDisconnect"))
        for role, state in RELAY.SERVE_STATES.items():
            active = state == "attended-foreground"
            self.add(
                role,
                {
                    "adapterId": SYNTHETIC_ADAPTER_ID,
                    "state": state,
                    "mode": "attended-foreground" if active else "none",
                    "httpsPort": 443 if active else None,
                    "handlerPath": "/" if active else None,
                    "upstream": "http://127.0.0.1:4000" if active else None,
                    "persistentConfiguration": "empty",
                    "hostBoundarySha256": host_sha,
                },
            )
        for role in RELAY.FUNNEL_ROLES:
            self.add(
                role,
                {
                    "adapterId": SYNTHETIC_ADAPTER_ID,
                    "state": "disabled",
                    "allowFunnel": False,
                    "publicHandlers": [],
                    "services": [],
                    "persistentConfiguration": "empty",
                    "hostBoundarySha256": host_sha,
                },
            )

        for role in RELAY.LISTENER_BOUNDARY_ROLES | RELAY.STATE_BOUNDARY_ROLES:
            suffix = next(suffix for suffix in RELAY.BOUNDARY_SUFFIXES if role.endswith(suffix))
            phase = next(prefix for prefix in ("preflight", "active", "restart", "teardown") if role.startswith(prefix))
            state_phase = "preflight" if phase == "teardown" else phase
            observation: dict[str, object] = {
                "canonicalStateSha256": digest(f"{state_phase}-{suffix}"),
                "safe": "passed",
                "hostBoundarySha256": host_sha,
            }
            if role in RELAY.LISTENER_BOUNDARY_ROLES:
                observation["bindings"] = [dict(binding) for binding in LISTENER_BINDINGS]
                observation["inventoriedNon443TcpPorts"] = list(LISTENER_PORTS)
            self.add(role, observation)

        policy_input = {
            "schemaVersion": POLICY.INPUT_SCHEMA,
            "phoneTailscaleIpv4": {
                PHONE_ALIAS: ip
                for PHONE_ALIAS, ip in zip(RELAY.PHONE_ALIASES, ("100.64.0.10", "100.64.0.11"), strict=True)
            },
            "relayHostTailscaleIpv4": "100.64.0.20",
            "listeners": self.policy_listeners,
        }
        parsed = POLICY.parse_phone_policy_input(policy_input)
        policy = POLICY.build_phone_policy(
            parsed.phone_tailscale_ipv4, parsed.relay_host_tailscale_ipv4, parsed.listeners
        )
        self.add(
            "policyProposal",
            {"policyInput": policy_input, "policy": policy, "hostBoundarySha256": host_sha},
            source=compact(policy_input),
        )
        self.add(
            "policy",
            {
                "policy": policy,
                "proposalCaptureSha256": digest(self.raws["policyProposal"]),
                "hostBoundarySha256": host_sha,
            },
            source=compact(policy),
        )
        self.add(
            "policyTests",
            {
                "result": "passed",
                "positiveTestsPassed": True,
                "negativeTestsPassed": True,
                "unapprovedTailnetBlocked": True,
                "proposalCaptureSha256": digest(self.raws["policyProposal"]),
                "appliedCaptureSha256": digest(self.raws["policy"]),
                "hostBoundarySha256": host_sha,
            },
        )
        self.add(
            "configurationEvent",
            {
                "eventType": "policy-update",
                "outcome": "applied",
                "eventIdSha256": digest("configuration-event"),
                "policyRevisionSha256": digest("policy-revision"),
                "appliedCaptureSha256": digest(self.raws["policy"]),
                "hostBoundarySha256": host_sha,
            },
        )
        for role in RELAY.POLICY_STATE_ROLES:
            self.add(
                role,
                {
                    "adapterId": SYNTHETIC_ADAPTER_ID,
                    "policyRevisionSha256": digest("policy-revision"),
                    "policy": policy,
                    "appliedCaptureSha256": digest(self.raws["policy"]),
                    "configurationEventCaptureSha256": digest(
                        self.raws["configurationEvent"]
                    ),
                    "hostBoundarySha256": host_sha,
                },
            )
        self.add(
            "policyGate",
            {
                "result": "passed",
                "proposalCaptureSha256": digest(self.raws["policyProposal"]),
                "appliedCaptureSha256": digest(self.raws["policy"]),
                "testsCaptureSha256": digest(self.raws["policyTests"]),
                "configurationEventCaptureSha256": digest(self.raws["configurationEvent"]),
                "currentPolicyCaptureSha256": digest(self.raws["activePolicyState"]),
                "identitiesCaptureSha256": digest(self.raws["activeIdentities"]),
                "hostBoundarySha256": host_sha,
            },
        )
        gate_sha = digest(self.raws["policyGate"])

        for role, (platform, alias) in RELAY.APPROVED_PROBE_ROLES.items():
            identity_role = "restartActiveIdentities" if role.startswith("restart") else "activeIdentities"
            identities = self.identity(identity_role, host_sha)
            build_id = IOS_BUILD if platform == "ios" else ANDROID_BUILD
            self.add(
                role,
                {
                    "platform": platform,
                    "testedEasBuildId": build_id,
                    "phoneAlias": alias,
                    "observedAt": self.times[role],
                    "apiOrigin": ORIGIN,
                    "publicCaAndHostname": "passed",
                    "readyHttpStatus": 200,
                    "readyBodySha256": RELAY.READY_BODY_SHA256,
                    "openTcpPorts": [443],
                    "blockedTcpPorts": list(LISTENER_PORTS),
                    "directWindowsWslDockerTargets": "blocked",
                    "tailscaleDisabledHttps": "blocked",
                    "policyGateSha256": gate_sha,
                    "relayHostIdentitySha256": identities["relayHostIdentitySha256"],
                    "phoneIdentitySha256": identities[f"{platform}IdentitySha256"],
                    "hostBoundarySha256": host_sha,
                },
            )
        for role in RELAY.UNAPPROVED_PROBE_ROLES:
            self.add(
                role,
                {
                    "observedAt": self.times[role],
                    "peerClassSha256": digest("unapproved-tailnet-peer-class"),
                    "httpsPort": "blocked",
                    "blockedTcpPorts": list(LISTENER_PORTS),
                    "policyGateSha256": gate_sha,
                    "hostBoundarySha256": host_sha,
                },
            )
        for role in RELAY.LAN_PROBE_ROLES:
            self.add(
                role,
                {
                    "observedAt": self.times[role],
                    "peerClassSha256": digest("lan-peer-class"),
                    "httpsPort": "blocked",
                    "blockedTcpPorts": list(LISTENER_PORTS),
                    "windowsWslDockerTargets": "blocked",
                    "ipv4AndIpv6Paths": "blocked",
                    "policyGateSha256": gate_sha,
                    "hostBoundarySha256": host_sha,
                },
            )
        restart_environment = self.environment("restartEnvironment", host_sha)
        for role in RELAY.READINESS_ROLES:
            self.add(
                role,
                {
                    "observedAt": self.times[role],
                    "httpStatus": 200,
                    "bodySha256": RELAY.READY_BODY_SHA256,
                    "sourceHead": SOURCE_COMMIT,
                    "apiProcessSha256": restart_environment["apiProcessSha256"],
                    "apiCwdSha256": restart_environment["apiCwdSha256"],
                    "hostBoundarySha256": host_sha,
                },
            )

        pre_shutdown_roles = (
            "restartPreShutdownIncoming",
            "restartPreShutdownServe",
            "restartPreShutdownFunnel",
        )
        cold_observation = {
            "preShutdown": {role: digest(self.raws[role]) for role in pre_shutdown_roles},
            "postRestart": {role: digest(self.raws[role]) for role in RELAY.COLD_POST_RESTART_ROLES},
            "shutdownOrder": [
                "incoming-disabled",
                "serve-stopped",
                "docker-desktop-stopped",
                "wsl-shutdown",
            ],
            "restartOrder": ["wsl-started", "docker-desktop-started"],
            "dockerBoundaryRestored": "passed",
            "migrationsCurrent": "passed",
            "sourceHead": SOURCE_COMMIT,
            "sourceTreeClean": True,
            "apiProcessSha256": restart_environment["apiProcessSha256"],
            "apiCwdSha256": restart_environment["apiCwdSha256"],
            "result": "passed",
            "hostBoundarySha256": host_sha,
        }
        self.add("coldRestartEvent", cold_observation)

        entries = [
            {
                "role": role,
                "schemaVersion": RELAY._role_schema(role),
                "capturedAt": self.times[role],
                "sha256": digest(self.raws[role]),
            }
            for role in RELAY.CAPTURE_NAMES[:-1]
        ]
        ledger_observation = {"entries": entries}
        self.add("sessionLedger", ledger_observation, source=compact(ledger_observation))
        if set(self.raws) != set(RELAY.CAPTURE_NAMES):
            raise AssertionError("Synthetic bundle does not cover the complete phase matrix")

    def write(self) -> Path:
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.root.chmod(0o700)
        self.build()
        for role in RELAY.CAPTURE_NAMES:
            path = self.root / f"{role}.json"
            path.write_bytes(self.raws[role])
            path.chmod(0o600)
            self.paths[role] = str(path)
        index = {
            "schemaVersion": RELAY.REVIEW_PACKAGE_SCHEMA,
            "trustBoundary": RELAY.UNSIGNED_TRUST_BOUNDARY,
            "sessionId": self.session_id,
            "apiOrigin": ORIGIN,
            "startedAt": self.times["sessionEnvironment"],
            "executedAt": self.times["coldRestartEvent"],
            "completedAt": self.times["sessionLedger"],
            "buildIds": {"ios": IOS_BUILD, "android": ANDROID_BUILD},
            "captures": self.paths,
        }
        index_path = self.root / "index.json"
        index_path.write_bytes(compact(index))
        index_path.chmod(0o600)
        return index_path


class RelayEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="nutrition-relay-v2-")
        self.addCleanup(self.temporary.cleanup)
        self.bundle = CaptureBundle(Path(self.temporary.name) / "review")
        self.index = self.bundle.write()

    def rewrite(self, role: str, mutate, *, rebind_source: bool = True) -> None:
        path = Path(self.bundle.paths[role])
        value = json.loads(path.read_text(encoding="utf-8"))
        mutate(value)
        if rebind_source:
            observation = value["observation"]
            if role == "policyProposal":
                source = compact(observation["policyInput"])
            elif role == "policy":
                source = compact(observation["policy"])
            else:
                source = compact(observation)
            protected_source = synthetic_source(
                role,
                value["sessionId"],
                value["capturedAt"],
                source,
            )
            value["rawSourceSha256"] = digest(protected_source)
            value["rawSourceBase64"] = base64.b64encode(protected_source).decode("ascii")
        path.write_bytes(compact(value))
        path.chmod(0o600)

    def test_emits_canonical_redacted_v4_with_exact_adapter_and_restart_bindings(self) -> None:
        raw = normalize_synthetic(self.index)
        report = json.loads(raw)
        corpus = synthetic_version_adapter().corpus
        self.assertEqual(raw, compact(report))
        self.assertEqual(report["schemaVersion"], RELAY.REPORT_SCHEMA)
        self.assertEqual(RELAY.REPORT_SCHEMA, "nutrition-tracker-physical-device-relay-report-v4")
        adapter_report = report["versionAdapter"]
        self.assertEqual(adapter_report["adapterId"], SYNTHETIC_ADAPTER_ID)
        self.assertTrue(adapter_report["adapterId"].startswith(RELAY.TEST_ADAPTER_PREFIX))
        self.assertEqual(adapter_report["adapterKind"], "test")
        self.assertEqual(adapter_report["platform"], RELAY.ADAPTER_PLATFORM)
        self.assertEqual(adapter_report["corpusSchemaVersion"], RELAY.ADAPTER_CORPUS_SCHEMA)
        self.assertEqual(adapter_report["corpusSha256"], digest(corpus.corpus_manifest))
        self.assertEqual(adapter_report["tailscaleClientVersion"], corpus.tailscale_client_version)
        self.assertEqual(adapter_report["tailscaleDaemonVersion"], corpus.tailscale_daemon_version)
        self.assertEqual(adapter_report["clientHelpSha256"], corpus.client_help_sha256)
        self.assertEqual(adapter_report["daemonHelpSha256"], corpus.daemon_help_sha256)
        self.assertEqual(dict(RELAY.PRODUCTION_VERSION_ADAPTERS), {})
        self.assertEqual(report["sourceCommit"], SOURCE_COMMIT)
        self.assertEqual(
            report["apiOriginCommitmentSha256"],
            RELAY.api_origin_commitment_sha256(ORIGIN),
        )
        self.assertNotIn("apiOrigin", report)
        self.assertEqual(report["hostTopology"]["relayNode"], "windows-host")
        self.assertEqual(report["policy"]["incomingAccessHeldUntilPolicyTests"], "passed")
        self.assertEqual(report["restart"]["preShutdown"]["incoming"], "disabled")
        self.assertEqual(report["restart"]["preExposure"]["incoming"], "disabled")
        self.assertEqual(report["restart"]["reenabledRelay"]["incoming"], "enabled")
        self.assertEqual(report["teardown"]["relayHostDisconnected"], "passed")
        for protected in (ORIGIN, "100.64.0.10", "100.64.0.20", "tail1234"):
            self.assertNotIn(protected, raw.decode("utf-8"))

    def test_matrix_is_the_only_role_source_and_every_role_is_bound_once(self) -> None:
        flattened = tuple(
            role for _phase, _boundary, roles in RELAY.PHASE_MATRIX for role in roles
        )
        self.assertEqual(RELAY.CAPTURE_NAMES, flattened)
        self.assertEqual(len(flattened), len(set(flattened)))
        self.assertEqual(flattened[-1], "sessionLedger")
        reference = REFERENCE.read_text(encoding="utf-8")
        for role in flattened:
            self.assertIn(f"`{role}`", reference)
        report = json.loads(normalize_synthetic(self.index))
        expected = RELAY._source_capture_bundle_sha256(
            {
                role: RELAY._parse_capture(
                    role,
                    Path(self.bundle.paths[role]).read_bytes(),
                    (1, index),
                    SESSION_ID,
                )
                for index, role in enumerate(RELAY.CAPTURE_NAMES, start=1)
            }
        )
        self.assertEqual(report["sourceCaptureBundleSha256"], expected)

    def test_every_observation_field_has_exactly_one_owner(self) -> None:
        for role in RELAY.CAPTURE_NAMES:
            with self.subTest(role=role):
                fields = set(RELAY._observation_fields(role))
                core_owned = set(RELAY._core_observation_fields(role))
                source_owned = set(RELAY._source_observation_fields(role))
                expected_core: set[str] = set()
                if role in RELAY.ADAPTER_ROLES:
                    expected_core.add("adapterId")
                if role not in {"hostBoundary", "sessionLedger"}:
                    expected_core.add("hostBoundarySha256")
                if role == "policy":
                    expected_core.add("proposalCaptureSha256")
                if role == "policyTests":
                    expected_core.update(("proposalCaptureSha256", "appliedCaptureSha256"))
                if role == "configurationEvent":
                    expected_core.add("appliedCaptureSha256")
                if role == "policyGate":
                    expected_core.update(
                        (
                            "proposalCaptureSha256",
                            "appliedCaptureSha256",
                            "testsCaptureSha256",
                            "configurationEventCaptureSha256",
                            "currentPolicyCaptureSha256",
                            "identitiesCaptureSha256",
                        )
                    )
                if role in RELAY.POLICY_STATE_ROLES:
                    expected_core.update(
                        ("appliedCaptureSha256", "configurationEventCaptureSha256")
                    )
                if role in RELAY.APPROVED_PROBE_ROLES:
                    expected_core.update(
                        (
                            "policyGateSha256",
                            "relayHostIdentitySha256",
                            "phoneIdentitySha256",
                        )
                    )
                if role in RELAY.UNAPPROVED_PROBE_ROLES or role in RELAY.LAN_PROBE_ROLES:
                    expected_core.add("policyGateSha256")
                if role in RELAY.READINESS_ROLES:
                    expected_core.update(
                        ("sourceHead", "apiProcessSha256", "apiCwdSha256")
                    )
                if role == "coldRestartEvent":
                    expected_core.update(
                        (
                            "preShutdown",
                            "postRestart",
                            "sourceHead",
                            "apiProcessSha256",
                            "apiCwdSha256",
                        )
                    )
                if role == "sessionLedger":
                    expected_core.add("entries")
                self.assertEqual(core_owned, expected_core)
                self.assertFalse(core_owned & source_owned)
                self.assertEqual(core_owned | source_owned, fields)
                self.assertEqual(len(core_owned) + len(source_owned), len(fields))

    def test_adapter_metadata_is_immutable_exact_and_registry_namespaced(self) -> None:
        base = synthetic_version_adapter()

        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "exact reviewed fields"):
            RELAY._exact_keys(
                {"adapterId": base.adapter_id},
                ("adapterId", "adapterId"),
                "duplicate expected-field declaration",
            )

        with self.assertRaises(AttributeError):
            base.corpus.platform = "forged-platform"
        with self.assertRaises(AttributeError):
            base.corpus.corpus_sha256 = "0" * 64
        with self.assertRaises(TypeError):
            base.role_normalizers[0] = base.role_normalizers[0]
        with self.assertRaises(TypeError):
            base.corpus.samples[0] = base.corpus.samples[0]
        with self.assertRaises(TypeError):
            base.corpus.samples[0].raw_source[0] = 0
        with self.assertRaises(AttributeError):
            base.corpus.samples[0].expected.role = "forged-role"
        self.assertEqual(base.corpus.corpus_sha256, digest(base.corpus.corpus_manifest))
        manifest = json.loads(base.corpus.corpus_manifest)
        self.assertEqual(
            [sample["role"] for sample in manifest["roleSamples"]],
            list(RELAY.CAPTURE_NAMES),
        )
        for sample, committed in zip(
            base.corpus.samples,
            manifest["roleSamples"],
            strict=True,
        ):
            self.assertEqual(committed["sourceSha256"], digest(sample.raw_source))
            self.assertEqual(
                committed["normalizedSha256"],
                RELAY._normalized_observation_sha256(
                    sample.expected,
                    sample.role,
                    sample.raw_source,
                ),
            )

        mutated_sample = RELAY.AdapterCorpusSample(
            role=base.corpus.samples[0].role,
            raw_source=base.corpus.samples[0].raw_source + b"mutated",
            expected=base.corpus.samples[0].expected,
        )
        tampered_manifest = json.loads(base.corpus.corpus_manifest)
        tampered_manifest["roleSamples"][0]["sourceSha256"] = "0" * 64
        tampered_normalized_manifest = json.loads(base.corpus.corpus_manifest)
        tampered_normalized_manifest["roleSamples"][0]["normalizedSha256"] = "0" * 64
        rejected_samples = tuple(
            RELAY.AdapterCorpusSample(
                role=sample.role,
                raw_source=b"not-reviewed-output",
                expected=sample.expected,
            )
            for sample in base.corpus.samples
        )

        invalid_metadata = (
            ("kind", synthetic_corpus(adapter_kind="production"), "kind"),
            ("platform", synthetic_corpus(platform="wsl"), "platform"),
            ("schema", synthetic_corpus(schema_version="legacy"), "platform"),
            (
                "manifest-shape",
                synthetic_corpus(corpus_manifest=compact({"unexpected": True})),
                "corpus manifest",
            ),
            (
                "manifest-metadata-mismatch",
                synthetic_corpus(
                    tailscale_client_version="0.0.1-test",
                    corpus_manifest=base.corpus.corpus_manifest,
                ),
                "manifest does not bind",
            ),
            (
                "missing-sample",
                synthetic_corpus(samples=base.corpus.samples[:-1]),
                "every role in order",
            ),
            (
                "reordered-samples",
                synthetic_corpus(
                    samples=(
                        base.corpus.samples[1],
                        base.corpus.samples[0],
                        *base.corpus.samples[2:],
                    )
                ),
                "every role in order",
            ),
            (
                "mutated-sample-bytes",
                synthetic_corpus(
                    samples=(mutated_sample, *base.corpus.samples[1:]),
                    corpus_manifest=base.corpus.corpus_manifest,
                ),
                "cannot reproduce",
            ),
            (
                "mutated-manifest-sample-digest",
                synthetic_corpus(
                    samples=base.corpus.samples,
                    corpus_manifest=compact(tampered_manifest),
                ),
                "manifest does not bind",
            ),
            (
                "mutated-manifest-normalized-digest",
                synthetic_corpus(
                    samples=base.corpus.samples,
                    corpus_manifest=compact(tampered_normalized_manifest),
                ),
                "manifest does not bind",
            ),
            (
                "parser-rejected-samples",
                synthetic_corpus(
                    samples=rejected_samples,
                    corpus_manifest=base.corpus.corpus_manifest,
                ),
                "cannot reproduce",
            ),
            (
                "client-version",
                synthetic_corpus(tailscale_client_version="not exact!"),
                "exact",
            ),
            (
                "help-hash",
                synthetic_corpus(client_help_sha256="0" * 63),
                "clientHelpSha256",
            ),
        )
        for name, metadata, expected in invalid_metadata:
            with self.subTest(name=name):
                with self.assertRaisesRegex(RELAY.RelayEvidenceError, expected):
                    RELAY._assert_adapter_metadata(
                        synthetic_version_adapter(corpus=metadata), "test"
                    )

        for name, normalizers in (
            ("missing", base.role_normalizers[:-1]),
            ("reordered", (base.role_normalizers[1], base.role_normalizers[0], *base.role_normalizers[2:])),
            ("duplicate", (base.role_normalizers[0], base.role_normalizers[0], *base.role_normalizers[2:])),
        ):
            with self.subTest(name=name):
                with self.assertRaisesRegex(RELAY.RelayEvidenceError, "every protected role"):
                    RELAY._assert_adapter_metadata(
                        synthetic_version_adapter(role_normalizers=normalizers), "test"
                    )

        production_corpus = synthetic_corpus(
            adapter_id="windows-contract-v1",
            adapter_kind="production",
        )
        RELAY._assert_adapter_metadata(
            synthetic_version_adapter(
                adapter_id="windows-contract-v1",
                corpus=production_corpus,
            ),
            "production",
        )
        for name, adapter, expected_kind in (
            (
                "injected-production-name",
                synthetic_version_adapter(adapter_id="windows-contract-v1"),
                "test",
            ),
            (
                "production-test-name",
                synthetic_version_adapter(
                    corpus=synthetic_corpus(adapter_kind="production")
                ),
                "production",
            ),
        ):
            with self.subTest(name=name):
                with self.assertRaisesRegex(RELAY.RelayEvidenceError, "distinguishable"):
                    RELAY._assert_adapter_metadata(adapter, expected_kind)

        for name, metadata in (
            (
                "windows-version",
                synthetic_corpus(windows_version="11.0.99999"),
            ),
            (
                "wsl-version",
                synthetic_corpus(wsl_version="2.99.0.0"),
            ),
            (
                "ubuntu-version",
                synthetic_corpus(ubuntu_version="24.99"),
            ),
            (
                "docker-desktop-version",
                synthetic_corpus(docker_desktop_version="4.99.0"),
            ),
            (
                "docker-engine-version",
                synthetic_corpus(docker_engine_version="29.99.0"),
            ),
            (
                "client-version",
                synthetic_corpus(tailscale_client_version="0.0.1-test"),
            ),
            (
                "daemon-version",
                synthetic_corpus(tailscale_daemon_version="0.0.1-test"),
            ),
            (
                "client-help",
                synthetic_corpus(client_help_sha256=digest("different-client-help")),
            ),
            (
                "daemon-help",
                synthetic_corpus(daemon_help_sha256=digest("different-daemon-help")),
            ),
        ):
            with self.subTest(name=name):
                adapter = synthetic_version_adapter(corpus=metadata)
                with self.assertRaisesRegex(RELAY.RelayEvidenceError, "environment and help corpora"):
                    RELAY.normalize_relay_report_candidate(
                        str(self.index), adapters={adapter.adapter_id: adapter}
                    )

    def test_production_registry_rejects_synthetic_and_legacy_generations(self) -> None:
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "adapter is not supported"):
            RELAY.normalize_relay_report_candidate(str(self.index))
        index = json.loads(self.index.read_text(encoding="utf-8"))
        for legacy in (
            "nutrition-tracker-tailscale-relay-review-package-v1",
            "nutrition-tracker-physical-device-relay-report-v2",
        ):
            index["schemaVersion"] = legacy
            self.index.write_bytes(compact(index))
            self.index.chmod(0o600)
            with self.assertRaisesRegex(RELAY.RelayEvidenceError, "Windows v2"):
                normalize_synthetic(self.index)

    def test_rejects_policy_gate_cold_restart_and_session_ledger_hash_drift(self) -> None:
        cases = (
            (
                "policyGate",
                lambda envelope: envelope["observation"].update(
                    currentPolicyCaptureSha256="0" * 64
                ),
                "policyGate",
            ),
            (
                "coldRestartEvent",
                lambda envelope: envelope["observation"]["postRestart"].update(
                    restartPolicyState="0" * 64
                ),
                "coldRestartEvent",
            ),
            (
                "sessionLedger",
                lambda envelope: envelope["observation"]["entries"][0].update(sha256="0" * 64),
                "sessionLedger",
            ),
        )
        for role, mutate, expected in cases:
            with self.subTest(role=role):
                self.bundle = CaptureBundle(Path(self.temporary.name) / f"review-{role}")
                self.index = self.bundle.write()
                self.rewrite(role, mutate)
                with self.assertRaisesRegex(RELAY.RelayEvidenceError, expected):
                    normalize_synthetic(self.index)

    def test_rejects_wildcard_ipv6_nonloopback_and_inventory_drift(self) -> None:
        for host in ("*", "0.0.0.0", "::", "192.168.1.10"):
            with self.subTest(host=host):
                self.bundle = CaptureBundle(Path(self.temporary.name) / f"review-bind-{host.replace(':', 'v6').replace('*', 'wild')}")
                self.index = self.bundle.write()
                self.rewrite(
                    "activeWindowsListeners",
                    lambda envelope, host=host: envelope["observation"]["bindings"][0].update(host=host),
                )
                with self.assertRaisesRegex(RELAY.RelayEvidenceError, "wildcard, IPv6, non-loopback"):
                    normalize_synthetic(self.index)
        self.bundle = CaptureBundle(Path(self.temporary.name) / "review-inventory")
        self.index = self.bundle.write()
        self.rewrite(
            "activeDockerPorts",
            lambda envelope: envelope["observation"]["inventoriedNon443TcpPorts"].pop(),
        )
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "binding inventory"):
            normalize_synthetic(self.index)

    def test_rejects_current_policy_content_and_revision_drift_in_every_phase(self) -> None:
        cases = (
            (
                "activePolicyState",
                lambda envelope: envelope["observation"]["policy"]["grants"][0].update(
                    ip=["tcp:8443"]
                ),
            ),
            (
                "restartPolicyState",
                lambda envelope: envelope["observation"].update(
                    policyRevisionSha256="0" * 64
                ),
            ),
            (
                "teardownPolicyState",
                lambda envelope: envelope["observation"]["policy"]["tests"][0].update(
                    deny=[]
                ),
            ),
        )
        for role, mutate in cases:
            with self.subTest(role=role):
                self.bundle = CaptureBundle(Path(self.temporary.name) / f"review-{role}")
                self.index = self.bundle.write()
                self.rewrite(role, mutate)
                with self.assertRaisesRegex(
                    RELAY.RelayEvidenceError,
                    f"{role} does not prove the exact applied current-policy revision",
                ):
                    normalize_synthetic(self.index)

    def test_rejects_policy_tcp_deny_omission_from_complete_boundary_inventory(self) -> None:
        policy_listeners = [
            listener for listener in POLICY_LISTENERS if listener["port"] != 49231
        ]
        self.bundle = CaptureBundle(
            Path(self.temporary.name) / "review-policy-custom-port-omission",
            policy_listeners=policy_listeners,
        )
        self.index = self.bundle.write()
        with self.assertRaisesRegex(
            RELAY.RelayEvidenceError,
            "per-phone TCP deny tests do not equal the complete boundary inventory",
        ):
            normalize_synthetic(self.index)

    def test_rejects_raw_boundary_claims_without_adapter_binding_and_partial_adapters(self) -> None:
        self.rewrite(
            "activeWindowsListeners",
            lambda envelope: envelope["observation"].update(safe="blocked"),
            rebind_source=False,
        )
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "version adapter"):
            normalize_synthetic(self.index)

        adapter = synthetic_version_adapter()
        partial = synthetic_version_adapter(
            role_normalizers=adapter.role_normalizers[:-1],
        )
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "every protected role"):
            RELAY.normalize_relay_report_candidate(
                str(self.index), adapters={partial.adapter_id: partial}
            )

    def test_normalizers_derive_only_from_raw_bytes_and_reject_forged_claims(self) -> None:
        self.rewrite(
            "activeEnvironment",
            lambda envelope: envelope["observation"].update(rawStatusSha256="0" * 64),
            rebind_source=False,
        )
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "raw output failed"):
            normalize_synthetic(self.index)

        self.bundle = CaptureBundle(Path(self.temporary.name) / "review-raw-only-spy")
        self.index = self.bundle.write()
        base = synthetic_version_adapter()
        seen: list[bytes] = []
        original = base.role_normalizers[0]

        def spy(raw: bytes):
            seen.append(raw)
            return original.normalize(raw)

        spy_adapter = synthetic_version_adapter(
            corpus=base.corpus,
            role_normalizers=(
                RELAY.RoleNormalizer(role=original.role, normalize=spy),
                *base.role_normalizers[1:],
            ),
        )
        RELAY.normalize_relay_report_candidate(
            str(self.index), adapters={spy_adapter.adapter_id: spy_adapter}
        )
        self.assertEqual(len(seen), 2)
        self.assertEqual(seen[0], base.corpus.samples[0].raw_source)
        self.assertIsInstance(seen[1], bytes)
        normalized = original.normalize(seen[1])
        with self.assertRaises(AttributeError):
            normalized.session_id = "forged-session"
        with self.assertRaises(TypeError):
            normalized.raw_output[0] = 0

        def adapter_with_first(callback):
            def corpus_safe_callback(raw: bytes):
                if raw == base.corpus.samples[0].raw_source:
                    return original.normalize(raw)
                return callback(raw)

            return synthetic_version_adapter(
                corpus=base.corpus,
                role_normalizers=(
                    RELAY.RoleNormalizer(
                        role=original.role,
                        normalize=corpus_safe_callback,
                    ),
                    *base.role_normalizers[1:],
                ),
            )

        def with_observation(raw: bytes, observation_json: bytes):
            derived = original.normalize(raw)
            return RELAY.NormalizedObservation(
                role=derived.role,
                session_id=derived.session_id,
                captured_at=derived.captured_at,
                source_sha256=derived.source_sha256,
                raw_output=derived.raw_output,
                observation_json=observation_json,
            )

        def missing(raw: bytes):
            return with_observation(raw, compact({}))

        def extra(raw: bytes):
            derived = json.loads(original.normalize(raw).observation_json)
            derived["hostBoundarySha256"] = "0" * 64
            return with_observation(raw, compact(derived))

        def noncanonical(raw: bytes):
            return with_observation(raw, b'{"unserializable":true}')

        def wrong_source_digest(raw: bytes):
            derived = original.normalize(raw)
            return RELAY.NormalizedObservation(
                role=derived.role,
                session_id=derived.session_id,
                captured_at=derived.captured_at,
                source_sha256="0" * 64,
                raw_output=derived.raw_output,
                observation_json=derived.observation_json,
            )

        for name, callback in (
            ("missing", missing),
            ("extra-core-field", extra),
            ("noncanonical", noncanonical),
            ("wrong-source-digest", wrong_source_digest),
        ):
            with self.subTest(name=name):
                adapter = adapter_with_first(callback)
                with self.assertRaisesRegex(RELAY.RelayEvidenceError, "raw output failed") as raised:
                    RELAY.normalize_relay_report_candidate(
                        str(self.index), adapters={adapter.adapter_id: adapter}
                    )
                self.assertIsNone(raised.exception.__cause__)
                self.assertIsNone(raised.exception.__context__)

    def test_rejects_cross_role_cross_session_and_stale_timestamp_source_replay(self) -> None:
        def rewrite_protected_source(role: str, mutate) -> None:
            path = Path(self.bundle.paths[role])
            capture = json.loads(path.read_text(encoding="utf-8"))
            protected = json.loads(
                base64.b64decode(capture["rawSourceBase64"], validate=True)
            )
            mutate(protected)
            raw_source = compact(protected)
            capture["rawSourceSha256"] = digest(raw_source)
            capture["rawSourceBase64"] = base64.b64encode(raw_source).decode("ascii")
            path.write_bytes(compact(capture))
            path.chmod(0o600)

        for name, field, value in (
            ("cross-role", "role", "restartEnvironment"),
            (
                "cross-session",
                "sessionId",
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            ),
            ("stale-timestamp", "capturedAt", "2026-08-27T23:59:59.000Z"),
        ):
            with self.subTest(name=name):
                self.bundle = CaptureBundle(Path(self.temporary.name) / f"review-{name}")
                self.index = self.bundle.write()
                rewrite_protected_source(
                    "activeEnvironment",
                    lambda protected, key=field, replacement=value: protected.update(
                        {key: replacement}
                    ),
                )
                with self.assertRaisesRegex(RELAY.RelayEvidenceError, "raw output failed"):
                    normalize_synthetic(self.index)

        self.bundle = CaptureBundle(Path(self.temporary.name) / "review-current-session")
        self.index = self.bundle.write()
        stale_bundle = CaptureBundle(
            Path(self.temporary.name) / "review-stale-session",
            session_id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        )
        stale_bundle.write()
        stale_capture = json.loads(
            Path(stale_bundle.paths["activeEnvironment"]).read_text(encoding="utf-8")
        )
        current_path = Path(self.bundle.paths["activeEnvironment"])
        current_capture = json.loads(current_path.read_text(encoding="utf-8"))
        current_capture["rawSourceSha256"] = stale_capture["rawSourceSha256"]
        current_capture["rawSourceBase64"] = stale_capture["rawSourceBase64"]
        current_path.write_bytes(compact(current_capture))
        current_path.chmod(0o600)
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "raw output failed"):
            normalize_synthetic(self.index)

    def test_preserves_policy_restart_and_ledger_raw_payload_byte_bindings(self) -> None:
        base = synthetic_version_adapter()
        for role, expected in (
            ("policyProposal", "exact canonical protected policy input"),
            ("policy", "byte-bind the exact reviewed proposal"),
            ("coldRestartEvent", "exact canonical ordered event record"),
            ("sessionLedger", "exact canonical preceding-entry ledger"),
        ):
            with self.subTest(role=role):
                index = RELAY.CAPTURE_NAMES.index(role)
                original = base.role_normalizers[index]

                def substitute_raw_output(raw: bytes, *, selected=original):
                    derived = selected.normalize(raw)
                    if raw == base.corpus.samples[index].raw_source:
                        return derived
                    return RELAY.NormalizedObservation(
                        role=derived.role,
                        session_id=derived.session_id,
                        captured_at=derived.captured_at,
                        source_sha256=derived.source_sha256,
                        raw_output=compact({"tampered": True}),
                        observation_json=derived.observation_json,
                    )

                normalizers = list(base.role_normalizers)
                normalizers[index] = RELAY.RoleNormalizer(
                    role=role,
                    normalize=substitute_raw_output,
                )
                adapter = synthetic_version_adapter(
                    corpus=base.corpus,
                    role_normalizers=tuple(normalizers),
                )
                with self.assertRaisesRegex(RELAY.RelayEvidenceError, expected):
                    RELAY.normalize_relay_report_candidate(
                        str(self.index), adapters={adapter.adapter_id: adapter}
                    )

    def test_rejects_bundle_wide_mutation_after_an_earlier_read(self) -> None:
        for target_role, trigger_call in ((None, 2), ("sessionEnvironment", 3)):
            with self.subTest(target_role=target_role or "index"):
                self.bundle = CaptureBundle(
                    Path(self.temporary.name) / f"review-mutation-{target_role or 'index'}"
                )
                self.index = self.bundle.write()
                target = (
                    self.index
                    if target_role is None
                    else Path(self.bundle.paths[target_role])
                )
                original_read = RELAY._secure_read_at
                calls = 0

                def mutate_after_read(*args, **kwargs):
                    nonlocal calls
                    result = original_read(*args, **kwargs)
                    calls += 1
                    if calls == trigger_call:
                        raw = target.read_bytes()
                        target.write_bytes(raw[:-1] + b" ")
                        target.chmod(0o600)
                    return result

                with mock.patch.object(RELAY, "_secure_read_at", side_effect=mutate_after_read):
                    with self.assertRaisesRegex(RELAY.RelayEvidenceError, "changed after"):
                        normalize_synthetic(self.index)

    def test_sanitizes_every_adapter_exception(self) -> None:
        for exception in (
            RELAY.RelayEvidenceError("protected-adapter-secret"),
            ValueError("protected-adapter-secret"),
        ):
            with self.subTest(exception=type(exception).__name__):
                base = synthetic_version_adapter()

                def reject(_raw, *, error=exception):
                    raise error

                adapter = synthetic_version_adapter(
                    corpus=base.corpus,
                    role_normalizers=(
                        RELAY.RoleNormalizer(
                            role=base.role_normalizers[0].role,
                            normalize=reject,
                        ),
                        *base.role_normalizers[1:],
                    ),
                )
                with self.assertRaises(RELAY.RelayEvidenceError) as raised:
                    RELAY.normalize_relay_report_candidate(
                        str(self.index), adapters={adapter.adapter_id: adapter}
                    )
                self.assertNotIn("protected-adapter-secret", str(raised.exception))
                self.assertNotIn("protected-adapter-secret", repr(raised.exception))
                self.assertNotIn(
                    "protected-adapter-secret",
                    "".join(
                        traceback.format_exception(
                            type(raised.exception),
                            raised.exception,
                            raised.exception.__traceback__,
                        )
                    ),
                )
                self.assertIsNone(raised.exception.__cause__)
                self.assertIsNone(raised.exception.__context__)

    def test_sanitizes_protected_parser_path_base64_and_os_failures(self) -> None:
        secret = "protected-source-secret"

        def assert_sanitized(operation) -> None:
            with self.assertRaises(RELAY.RelayEvidenceError) as raised:
                operation()
            rendered = (
                str(raised.exception),
                repr(raised.exception),
                "".join(
                    traceback.format_exception(
                        type(raised.exception),
                        raised.exception,
                        raised.exception.__traceback__,
                    )
                ),
            )
            for value in rendered:
                self.assertNotIn(secret, value)
            self.assertIsNone(raised.exception.__cause__)
            self.assertIsNone(raised.exception.__context__)

        canary = secret.encode("utf-8")
        malformed_utf8 = b'{"canary":"' + canary + b'"}\xff'
        malformed_json = b'{"canary":"' + canary + b'",}'
        deep_json = (
            b'{"canary":"'
            + canary
            + b'","nested":'
            + b"[" * 2_000
            + b"0"
            + b"]" * 2_000
            + b"}"
        )
        oversized_integer = (
            b'{"canary":"' + canary + b'","value":' + b"9" * 10_000 + b"}"
        )
        assert_sanitized(lambda: RELAY._json(malformed_utf8, "protected JSON"))
        assert_sanitized(lambda: RELAY._json(malformed_json, "protected JSON"))
        assert_sanitized(lambda: RELAY._json(deep_json, "protected JSON"))
        assert_sanitized(lambda: RELAY._json(oversized_integer, "protected JSON"))
        with mock.patch.object(RELAY.json, "loads", side_effect=ValueError(secret)):
            assert_sanitized(lambda: RELAY._json(malformed_json, "protected JSON"))

        recursive = {"canary": secret}
        recursive["recursive"] = recursive
        assert_sanitized(lambda: RELAY._canonical(recursive))
        invalid_unicode = {"canary": secret, "invalid": "\ud800"}
        assert_sanitized(lambda: RELAY._canonical(invalid_unicode))
        oversized_canonical = {
            "canary": secret,
            "large": "x" * (RELAY.MAX_CAPTURE_BYTES + 1),
        }
        assert_sanitized(lambda: RELAY._canonical(oversized_canonical))
        assert_sanitized(
            lambda: RELAY._instant("2026-99-99T00:00:00.000Z", "protected instant")
        )
        malformed_path = f"/tmp/{secret}\ud800/index.json"
        assert_sanitized(lambda: RELAY._checked_review_directory(malformed_path))

        raw_source = {
            "rawSourceBase64": base64.b64encode(b"source").decode("ascii"),
            "rawSourceSha256": digest(b"source"),
        }
        with mock.patch.object(RELAY.base64, "b64decode", side_effect=ValueError(secret)):
            assert_sanitized(lambda: RELAY._decode_raw_source(raw_source, "protectedRole"))
        with mock.patch.object(Path, "lstat", side_effect=OSError(secret)):
            assert_sanitized(
                lambda: RELAY._checked_review_directory(f"/tmp/{secret}/index.json")
            )
        with mock.patch.object(RELAY.os, "open", side_effect=OSError(secret)):
            assert_sanitized(
                lambda: RELAY._open_review_directory(Path("/tmp/protected-review"), os.stat_result((0,) * 10))
            )
        with mock.patch.object(RELAY.os, "stat", side_effect=OSError(secret)):
            assert_sanitized(
                lambda: RELAY._secure_read_at(0, 0, 0, "capture.json", "protected capture", 1024)
            )
            assert_sanitized(
                lambda: RELAY._assert_stable_entry_at(
                    0, "capture.json", (0,) * 8, "protected capture"
                )
            )
        with mock.patch.object(RELAY.os.path, "normpath", side_effect=ValueError(secret)):
            assert_sanitized(
                lambda: RELAY._capture_filename(
                    "/tmp/protected-review/capture.json",
                    Path("/tmp/protected-review"),
                    "protectedRole",
                )
            )
        with mock.patch.object(Path, "stat", side_effect=OSError(secret)):
            assert_sanitized(lambda: RELAY._native_linux_filesystem(Path("/tmp")))
        with mock.patch.object(RELAY.ctypes, "CDLL", side_effect=OSError(secret)):
            assert_sanitized(lambda: RELAY._filesystem_magic(0))
        with mock.patch.object(
            RELAY,
            "parse_phone_policy_input",
            side_effect=ValueError(secret),
        ):
            assert_sanitized(lambda: normalize_synthetic(self.index))

        self.index.write_bytes(malformed_utf8)
        self.index.chmod(0o600)
        stderr = io.StringIO()
        with mock.patch.object(RELAY.sys, "stderr", stderr):
            self.assertEqual(
                RELAY.main(
                    (
                        "--capture-index",
                        str(self.index),
                        "--acknowledge-unsigned-candidate",
                    )
                ),
                1,
            )
        self.assertNotIn(secret, stderr.getvalue())

    def test_rejects_identity_peer_and_build_substitution(self) -> None:
        cases = (
            (
                "same-approved-identity",
                "preflightIdentities",
                lambda envelope: envelope["observation"].update(
                    iosIdentitySha256=envelope["observation"]["relayHostIdentitySha256"]
                ),
                "distinct reviewed identities",
            ),
            (
                "swapped-build",
                "iosProbe",
                lambda envelope: envelope["observation"].update(
                    testedEasBuildId=ANDROID_BUILD
                ),
                "reviewed build",
            ),
            (
                "swapped-phone",
                "iosProbe",
                lambda envelope: envelope["observation"].update(
                    phoneIdentitySha256=digest("android-identity")
                ),
                "reviewed build, origin, policy, identity",
            ),
        )
        for name, role, mutate, expected in cases:
            with self.subTest(name=name):
                self.bundle = CaptureBundle(Path(self.temporary.name) / f"review-{name}")
                self.index = self.bundle.write()
                self.rewrite(role, mutate)
                with self.assertRaisesRegex(RELAY.RelayEvidenceError, expected):
                    normalize_synthetic(self.index)

        self.bundle = CaptureBundle(Path(self.temporary.name) / "review-same-denied-peer")
        self.index = self.bundle.write()
        for role in ("lanProbe", "restartLanProbe"):
            self.rewrite(
                role,
                lambda envelope: envelope["observation"].update(
                    peerClassSha256=digest("unapproved-tailnet-peer-class")
                ),
            )
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "distinct"):
            normalize_synthetic(self.index)

    def test_requires_strict_security_transition_and_ledger_timestamps(self) -> None:
        chronology = RELAY._creation_chronology()
        self.assertLess(chronology.index("policyTests"), chronology.index("activeIdentities"))
        self.assertLess(
            chronology.index("activeIdentities"), chronology.index("activePolicyState")
        )
        self.assertLess(chronology.index("activePolicyState"), chronology.index("policyGate"))
        self.assertLess(chronology.index("policyGate"), chronology.index("activeIncoming"))
        self.assertLess(
            chronology.index("restartWindowsReadyProbe"),
            chronology.index("restartPolicyState"),
        )
        self.assertLess(
            chronology.index("restartPolicyState"), chronology.index("restartActiveIncoming")
        )
        self.assertLess(
            chronology.index("teardownDockerPorts"), chronology.index("teardownPolicyState")
        )
        self.assertLess(
            chronology.index("teardownPolicyState"), chronology.index("teardownDisconnect")
        )
        self.assertEqual(chronology[-1], "sessionLedger")
        for earlier, later in (
            ("policyTests", "activeIdentities"),
            ("restartLanProbe", "coldRestartEvent"),
            ("teardownDockerPorts", "teardownDisconnect"),
            ("teardownDisconnect", "sessionLedger"),
        ):
            with self.subTest(earlier=earlier, later=later):
                self.bundle = CaptureBundle(
                    Path(self.temporary.name) / f"review-equal-{later}"
                )
                self.bundle.times[later] = self.bundle.times[earlier]
                self.index = self.bundle.write()
                with self.assertRaisesRegex(RELAY.RelayEvidenceError, "strict canonical"):
                    normalize_synthetic(self.index)

    def test_rejects_noncanonical_wrong_mode_hardlink_symlink_and_directory_changes(self) -> None:
        self.index.write_text(json.dumps(json.loads(self.index.read_text())), encoding="utf-8")
        self.index.chmod(0o600)
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "canonical JSON"):
            normalize_synthetic(self.index)

        self.bundle = CaptureBundle(Path(self.temporary.name) / "review-mode")
        self.index = self.bundle.write()
        Path(self.bundle.paths["iosProbe"]).chmod(0o644)
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "mode-0600"):
            normalize_synthetic(self.index)

        self.bundle = CaptureBundle(Path(self.temporary.name) / "review-hardlink")
        self.index = self.bundle.write()
        source = Path(self.bundle.paths["iosProbe"])
        os.link(source, source.with_suffix(".hardlink"))
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "nlink 1"):
            normalize_synthetic(self.index)

        self.bundle = CaptureBundle(Path(self.temporary.name) / "review-symlink")
        self.index = self.bundle.write()
        source = Path(self.bundle.paths["androidProbe"])
        link = source.with_suffix(".link")
        link.symlink_to(source)
        index = json.loads(self.index.read_text())
        index["captures"]["androidProbe"] = str(link)
        self.index.write_bytes(compact(index))
        self.index.chmod(0o600)
        with self.assertRaises(RELAY.RelayEvidenceError):
            normalize_synthetic(self.index)

        self.bundle = CaptureBundle(Path(self.temporary.name) / "review-directory-swap")
        self.index = self.bundle.write()
        review_directory, _index_name, checked = RELAY._checked_review_directory(str(self.index))
        moved = review_directory.with_name(f"{review_directory.name}-old")
        review_directory.rename(moved)
        review_directory.mkdir(mode=0o700)
        with self.assertRaisesRegex(RELAY.RelayEvidenceError, "changed"):
            RELAY._open_review_directory(review_directory, checked)

        self.bundle = CaptureBundle(Path(self.temporary.name) / "review-filesystem-swap")
        self.index = self.bundle.write()
        with mock.patch.object(
            RELAY,
            "_filesystem_magic",
            side_effect=(next(iter(RELAY.LINUX_NATIVE_FILESYSTEM_MAGIC)), 0xDEADBEEF),
        ):
            with self.assertRaisesRegex(RELAY.RelayEvidenceError, "share the review directory"):
                normalize_synthetic(self.index)

    def test_requires_native_linux_review_directory_outside_mount_git_and_onedrive(self) -> None:
        self.assertNotIn("overlay", RELAY.LINUX_NATIVE_FILESYSTEMS)
        self.assertNotIn(0x794C7630, RELAY.LINUX_NATIVE_FILESYSTEM_MAGIC)
        for path in ("/mnt/c/review/index.json", "/home/user/OneDrive/review/index.json"):
            with self.subTest(path=path):
                with self.assertRaises(RELAY.RelayEvidenceError):
                    RELAY._checked_review_directory(path)
        with mock.patch.object(RELAY, "_native_linux_filesystem", side_effect=RELAY.RelayEvidenceError("not native")):
            with self.assertRaisesRegex(RELAY.RelayEvidenceError, "not native"):
                normalize_synthetic(self.index)

    def test_fixed_origin_vector_and_noncollecting_command_surface(self) -> None:
        self.assertEqual(
            RELAY.api_origin_commitment_sha256(RELAY.ORIGIN_COMMITMENT_VECTOR_ORIGIN),
            RELAY.ORIGIN_COMMITMENT_VECTOR_SHA256,
        )
        source = MODULE.read_text(encoding="utf-8")
        for forbidden in (
            "wsl.exe",
            "powershell.exe",
            "--phone-ip",
            "--mac-ip",
            "nutrition-tracker-mac",
        ):
            self.assertNotIn(forbidden, source)

        self.assertEqual(noncollecting_surface_violations(source), [])
        parser = RELAY._parser()
        options = {option for action in parser._actions for option in action.option_strings}
        self.assertEqual(
            options - {"-h", "--help"},
            {"--capture-index", "--acknowledge-unsigned-candidate"},
        )

    def test_noncollecting_ast_guard_rejects_capability_bypasses(self) -> None:
        source = MODULE.read_text(encoding="utf-8")
        mutations = {
            "from-imported-os-system": "from os import system\nsystem('unsafe')",
            "os-remove": "os.remove('/tmp/unsafe')",
            "dynamic-getattr": "getattr(os, 'system')('unsafe')",
            "from-imported-ctypes-cdll": "from ctypes import CDLL\nCDLL(None)",
            "aliased-ctypes-cdll": "loader = ctypes.CDLL\nloader(None)",
            "chained-module-alias": "left = right = os\nleft.replace('a', 'b')",
            "direct-module-alias": "p = os\np.replace('a', 'b')",
            "destructured-capability-alias": (
                "left, right = os, ctypes.CDLL\nright('/tmp/evil.so')"
            ),
            "annotated-module-alias": "module: object = os\nmodule.replace('a', 'b')",
            "container-module-alias": "module = [os][0]\nmodule.replace('a', 'b')",
            "comprehension-module-alias": (
                "[module.replace('a', 'b') for module in (os,)]"
            ),
            "function-default-module-alias": "def unsafe(module=os):\n    module.replace('a', 'b')",
            "loop-module-alias": "for module in (os,):\n    module.replace('a', 'b')",
            "named-expression-module-alias": "(module := os).replace('a', 'b')",
            "os-module-receiver-alias": "module = os\nmodule.replace('a', 'b')",
            "os-open-callable-alias": (
                "writer = os.open\nwriter('/tmp/unsafe', os.O_WRONLY)"
            ),
            "duplicate-protected-import": "import os",
            "exception-protected-rebind": (
                "try:\n    raise RuntimeError()\nexcept RuntimeError as Path:\n    pass"
            ),
            "parameter-protected-rebind": "def unsafe(Path):\n    return Path('/tmp/unsafe')",
            "path-os-open-rebind": "Path = os.open\nPath('/tmp/unsafe', os.O_WRONLY)",
            "path-ctypes-rebind": "Path = ctypes.CDLL\nPath('/tmp/evil.so')",
            "path-replace": "Path('/tmp/a').replace('/tmp/b')",
            "path-write": "Path('/tmp/unsafe').write_text('unsafe')",
            "protected-local-rebind": "_canonical = os.open",
            "raw-stdout-exfiltration": (
                "def leak(raw):\n    sys.stdout.buffer.write(raw)\n    return {}"
            ),
            "normalized-output-rebind": "normalized_output = b'raw-exfiltration'",
        }
        for name, addition in mutations.items():
            with self.subTest(name=name):
                violations = noncollecting_surface_violations(f"{source}\n{addition}\n")
                self.assertTrue(violations, f"AST guard accepted {name}")

        with self.subTest(name="foreign-cdll"):
            mutated = source.replace(
                "ctypes.CDLL(None, use_errno=True)",
                "ctypes.CDLL('libc.so.6', use_errno=True)",
                1,
            )
            self.assertTrue(noncollecting_surface_violations(mutated))
        with self.subTest(name="libc-system"):
            mutated = source.replace("libc.fstatfs", "libc.system", 1)
            self.assertTrue(noncollecting_surface_violations(mutated))
        with self.subTest(name="writable-os-open"):
            mutated = source.replace("os.O_RDONLY", "os.O_WRONLY", 1)
            self.assertTrue(noncollecting_surface_violations(mutated))
        with self.subTest(name="unbounded-json-integer"):
            mutated = source.replace("parse_int=_bounded_integer,", "parse_int=int,", 1)
            self.assertTrue(noncollecting_surface_violations(mutated))


if __name__ == "__main__":
    unittest.main()
