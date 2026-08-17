#!/usr/bin/python3
"""Terraform external-data helper for deterministic XZ bootstrap compression."""

import base64
import hashlib
import json
import lzma
import sys


query = json.load(sys.stdin)
if set(query) != {"payload"} or not isinstance(query["payload"], str):
    raise SystemExit("Expected one string payload")
payload = json.loads(query["payload"])
if not isinstance(payload, dict) or not 20 <= len(payload) <= 64:
    raise SystemExit("Bootstrap payload has an unexpected file count")
for specification in payload.values():
    if not isinstance(specification, dict) or set(specification) != {"content", "mode"}:
        raise SystemExit("Bootstrap payload has an invalid file specification")
    content = specification["content"]
    if not isinstance(content, str) or not isinstance(specification["mode"], str):
        raise SystemExit("Bootstrap payload content or mode is invalid")
    # Repository sources remain readable. Host executable copies omit only
    # blank and comment-only lines; shebangs and all executable text remain.
    if specification["mode"] in {"0555", "0750"}:
        lines = content.splitlines()
        compacted = [
            line for index, line in enumerate(lines)
            if index == 0 or (line.strip() and not line.lstrip().startswith("#"))
        ]
        specification["content"] = "\n".join(compacted) + ("\n" if content.endswith("\n") else "")
raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
if len(raw) > 1_000_000:
    raise SystemExit("Bootstrap payload is unexpectedly large")
compressed = lzma.compress(raw, format=lzma.FORMAT_XZ, check=lzma.CHECK_SHA256, preset=9)
json.dump(
    {
        "bundle_base85": base64.b85encode(compressed).decode("ascii"),
        "payload_sha256": hashlib.sha256(raw).hexdigest(),
    },
    sys.stdout,
    separators=(",", ":"),
)
