#!/usr/bin/python3
"""Install one internally consistent initial secret set without overwriting files."""

import base64
import json
import os
import pathlib
import re
import secrets
import sys
import tempfile


CONFIG_DIRECTORY = pathlib.Path("/etc/nutrition-tracker")
TARGET_NAMES = ("runtime", "database", "api", "worker", "meili", "restore")
ALLOWED_REMAINING_MARKERS = {
    "api": {
        "REPLACE_SCOPED_MEILI_SEARCH_KEY",
        "REPLACE_OCI_EXPORT_READER_ACCESS_KEY_ID",
        "REPLACE_OCI_EXPORT_READER_SECRET_ACCESS_KEY",
    },
    "worker": {
        "REPLACE_SCOPED_MEILI_ADMIN_KEY",
        "REPLACE_OCI_EXPORT_WRITER_ACCESS_KEY_ID",
        "REPLACE_OCI_EXPORT_WRITER_SECRET_ACCESS_KEY",
        "REPLACE_OCI_LEDGER_WRITER_ACCESS_KEY_ID",
        "REPLACE_OCI_LEDGER_WRITER_SECRET_ACCESS_KEY",
    },
    "restore": {
        "REPLACE_OCI_LEDGER_RESTORE_ACCESS_KEY_ID",
        "REPLACE_OCI_LEDGER_RESTORE_SECRET_ACCESS_KEY",
        "REPLACE_OCI_LEDGER_RESTORE_KEY_FINGERPRINT",
    },
}


def canonical_base64_32() -> str:
    return base64.b64encode(secrets.token_bytes(32)).decode("ascii")


def substitute(template: str, replacements: dict[str, str], name: str) -> str:
    rendered = template
    for marker, value in replacements.items():
        if marker not in rendered:
            raise SystemExit(f"Expected marker is absent from {name}.env.example: {marker}")
        rendered = rendered.replace(marker, value)
    remaining = set(re.findall(r"REPLACE_[A-Z0-9_]+", rendered))
    if remaining != ALLOWED_REMAINING_MARKERS.get(name, set()):
        raise SystemExit(f"Unexpected unresolved marker set in {name}.env.example")
    return rendered


def main() -> None:
    if os.geteuid() != 0:
        raise SystemExit("Run this installer as root")
    if len(sys.argv) != 2 or not re.fullmatch(r"[0-9a-f]{40}", sys.argv[1]):
        raise SystemExit("Usage: nutrition-install-initial-secrets <full-lowercase-Git-SHA>")

    targets = {name: CONFIG_DIRECTORY / f"{name}.env" for name in TARGET_NAMES}
    admission_epoch_target = CONFIG_DIRECTORY / "admitted-restore-epoch"
    existing = [str(path) for path in (*targets.values(), admission_epoch_target) if path.exists()]
    if existing:
        raise SystemExit(
            "Refusing to create or rotate any secrets because managed files already exist: "
            + ", ".join(existing)
        )
    templates = {}
    for name in TARGET_NAMES:
        source = CONFIG_DIRECTORY / f"{name}.env.example"
        if not source.is_file():
            raise SystemExit(f"Missing initial-secret template: {source}")
        templates[name] = source.read_text(encoding="utf-8")

    database_password = secrets.token_hex(32)
    restore_epoch = f"restore-v1-{secrets.token_hex(32)}"
    export_key_id = f"export-{secrets.token_hex(8)}"
    ledger_key_id = f"ledger-{secrets.token_hex(8)}"
    locator_key_id = f"locator-{secrets.token_hex(8)}"
    export_ring = json.dumps({export_key_id: canonical_base64_32()}, separators=(",", ":"))
    ledger_ring = json.dumps({ledger_key_id: canonical_base64_32()}, separators=(",", ":"))
    locator_ring = json.dumps({locator_key_id: canonical_base64_32()}, separators=(",", ":"))

    # The worker example uses one marker spelling for two distinct encryption
    # rings. Resolve those labelled lines before the generic marker pass.
    templates["worker"] = templates["worker"].replace(
        "EXPORT_ARTIFACT_ENCRYPTION_KEYS=REPLACE_CANONICAL_KEYRING_JSON",
        f"EXPORT_ARTIFACT_ENCRYPTION_KEYS={export_ring}",
    ).replace(
        "ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS=REPLACE_CANONICAL_KEYRING_JSON",
        f"ERASURE_REPLAY_LEDGER_ENCRYPTION_KEYS={ledger_ring}",
    )

    replacements = {
        "runtime": {
            "REPLACE_GIT_COMMIT_SHA": sys.argv[1],
            "REPLACE_EXPORT_KEY_ID": export_key_id,
            "REPLACE_ERASURE_KEY_ID": ledger_key_id,
            "REPLACE_LOCATOR_KEY_ID": locator_key_id,
        },
        "database": {
            "REPLACE_RANDOM_DATABASE_PASSWORD": database_password,
            "REPLACE_URL_SAFE_DATABASE_PASSWORD": database_password,
            "REPLACE_FRESH_32_PLUS_CHARACTER_RESTORE_EPOCH": restore_epoch,
        },
        "api": {
            "REPLACE_RANDOM_32_PLUS_CHARACTER_SECRET": canonical_base64_32(),
            "REPLACE_CANONICAL_KEYRING_JSON": export_ring,
            "REPLACE_CANONICAL_LOCATOR_KEYRING_JSON": locator_ring,
            "REPLACE_CANONICAL_BASE64_32_BYTE_KEY": canonical_base64_32(),
            "REPLACE_DIFFERENT_CANONICAL_BASE64_32_BYTE_KEY": canonical_base64_32(),
        },
        "worker": {
            "REPLACE_CANONICAL_LOCATOR_KEYRING_JSON": locator_ring,
        },
        "meili": {
            "REPLACE_RANDOM_32_PLUS_CHARACTER_MASTER_KEY": canonical_base64_32(),
        },
        "restore": {
            "REPLACE_CANONICAL_KEYRING_JSON": ledger_ring,
            "REPLACE_CANONICAL_LOCATOR_KEYRING_JSON": locator_ring,
        },
    }
    rendered = {
        name: substitute(templates[name], replacements[name], name) for name in TARGET_NAMES
    }

    CONFIG_DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(CONFIG_DIRECTORY, 0o700)
    published: list[pathlib.Path] = []
    try:
        with tempfile.TemporaryDirectory(prefix=".initial-secrets-", dir=CONFIG_DIRECTORY) as staging:
            staging_path = pathlib.Path(staging)
            os.chmod(staging_path, 0o700)
            staged_paths = {}
            for name, content in rendered.items():
                staged = staging_path / f"{name}.env"
                with staged.open("x", encoding="utf-8") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.chmod(staged, 0o600)
                staged_paths[name] = staged
            staged_epoch = staging_path / "admitted-restore-epoch"
            with staged_epoch.open("x", encoding="utf-8") as stream:
                stream.write(restore_epoch + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(staged_epoch, 0o400)
            for name in TARGET_NAMES:
                # Hard-link publication is atomic and refuses an unexpected
                # pre-existing target instead of replacing it.
                os.link(staged_paths[name], targets[name])
                published.append(targets[name])
            os.link(staged_epoch, admission_epoch_target)
            published.append(admission_epoch_target)
        directory_fd = os.open(CONFIG_DIRECTORY, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        for path in reversed(published):
            path.unlink(missing_ok=True)
        raise

    print("Installed root-owned mode-0600 initial environment files without logging values:")
    for name in TARGET_NAMES:
        print(f"  {targets[name]}")
    print(f"  {admission_epoch_target}")
    print("Meilisearch scoped-key and OCI credential markers remain for the separate guarded installers.")


if __name__ == "__main__":
    main()
