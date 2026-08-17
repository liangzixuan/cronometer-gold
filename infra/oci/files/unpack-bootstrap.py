#!/usr/bin/python3
"""Atomically unpack the non-secret cloud-init bootstrap file bundle."""

import base64
import json
import hashlib
import lzma
import os
import pathlib
import re
import tempfile


BUNDLE = pathlib.Path("/var/lib/cloud/nutrition-bootstrap-files.json.xz.b85")
DIGEST = pathlib.Path("/var/lib/cloud/nutrition-bootstrap-files.sha256")
ALLOWED_ROOTS = (
    pathlib.Path("/etc/docker"),
    pathlib.Path("/etc/nutrition-tracker"),
    pathlib.Path("/etc/ssh/sshd_config.d"),
    pathlib.Path("/etc/systemd/system"),
    pathlib.Path("/opt/nutrition-tracker"),
    pathlib.Path("/usr/local/sbin"),
)
ALLOWED_MODES = {0o400, 0o555, 0o600, 0o644, 0o750}


def allowed_path(path: pathlib.Path) -> bool:
    return path.is_absolute() and any(path == root or root in path.parents for root in ALLOWED_ROOTS)


def main() -> None:
    if os.geteuid() != 0:
        raise SystemExit("Bootstrap bundle unpacker must run as root")
    for source in (BUNDLE, DIGEST):
        source_stat = source.stat()
        if source_stat.st_uid != 0 or source_stat.st_gid != 0 or source_stat.st_mode & 0o777 != 0o600:
            raise SystemExit("Bootstrap bundle and digest must be root:root mode 0600")
    try:
        compressed = base64.b85decode(BUNDLE.read_text(encoding="ascii"))
    except (ValueError, UnicodeDecodeError) as error:
        raise SystemExit(f"Bootstrap bundle transport encoding is invalid: {error}") from error
    raw = lzma.decompress(compressed, format=lzma.FORMAT_XZ)
    expected_digest = DIGEST.read_text(encoding="ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_digest) or hashlib.sha256(raw).hexdigest() != expected_digest:
        raise SystemExit("Bootstrap bundle digest verification failed")
    payload = json.loads(raw.decode("utf-8"))
    if not isinstance(payload, dict) or not 20 <= len(payload) <= 64:
        raise SystemExit("Bootstrap bundle has an unexpected file count")

    parsed = []
    for filename, specification in payload.items():
        path = pathlib.Path(filename)
        if not allowed_path(path) or path != pathlib.Path(os.path.normpath(path)):
            raise SystemExit("Bootstrap bundle contains a path outside its allowlist")
        if not isinstance(specification, dict) or set(specification) != {"content", "mode"}:
            raise SystemExit(f"Invalid bootstrap specification for {path}")
        content = specification["content"]
        mode_text = specification["mode"]
        if not isinstance(content, str) or "\x00" in content or len(content.encode()) > 1_000_000:
            raise SystemExit(f"Invalid bootstrap content for {path}")
        if not isinstance(mode_text, str) or not re.fullmatch(r"0[0-7]{3}", mode_text):
            raise SystemExit(f"Invalid bootstrap mode for {path}")
        mode = int(mode_text, 8)
        if mode not in ALLOWED_MODES:
            raise SystemExit(f"Unapproved bootstrap mode for {path}")
        parsed.append((path, content, mode))

    staged = []
    try:
        for path, content, mode in sorted(parsed):
            path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
            temporary = pathlib.Path(temporary_name)
            staged.append(temporary)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.chown(temporary, 0, 0)
            os.chmod(temporary, mode)
            os.replace(temporary, path)
            staged.remove(temporary)
        for directory in sorted({path.parent for path, _, _ in parsed}):
            descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        for temporary in staged:
            temporary.unlink(missing_ok=True)

    BUNDLE.unlink()
    DIGEST.unlink()
    print(f"Installed {len(parsed)} reviewed non-secret bootstrap files")


if __name__ == "__main__":
    main()
