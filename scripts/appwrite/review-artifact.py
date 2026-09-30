"""Read a bounded same-revision review artifact; never execute its contents."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import time
import zipfile

REPOSITORY = "liangzixuan/cronometer-gold"
BRANCH = "codex/retention-features"
ARCHIVE_LIMIT = 1024 * 1024
FILE_LIMIT = 512 * 1024
TOTAL_LIMIT = 1024 * 1024
COMMAND_SECONDS = 30
NAMES = {"qualification.json", "candidate-receipt.json", "staging-config.json", "staging-receipt.json"}


class AdmissionError(Exception):
    pass


def require(condition):
    if not condition:
        raise AdmissionError("review_artifact_rejected")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def parse_json(data):
    try:
        return json.loads(data, object_pairs_hook=unique_object,
                          parse_constant=lambda _: require(False))
    except (ValueError, UnicodeError, RecursionError) as error:
        raise AdmissionError("review_artifact_json_invalid") from error


def bounded_gh(path, maximum):
    # gh handles GitHub's expiring artifact redirect; no signed URL or token is logged.
    command = ["gh", "api", "--hostname", "github.com", "-H",
               "X-GitHub-Api-Version: 2026-03-10", path]
    env = dict(os.environ, GH_PROMPT_DISABLED="1", GH_PAGER="cat")
    deadline = time.monotonic() + COMMAND_SECONDS
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env=env, start_new_session=True)
    data = bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                require(remaining > 0)
                require(selector.select(remaining))
                chunk = os.read(child.stdout.fileno(), 65536)
                if not chunk:
                    break
                data.extend(chunk)
                require(len(data) <= maximum)
        require(child.wait(timeout=max(0.001, deadline - time.monotonic())) == 0)
        return bytes(data)
    finally:
        # The dedicated process group can outlive its leader while retaining stdout.
        # Always terminate that owned group, including when the leader has exited.
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=2)
            child.stdout.close()


def validate_metadata(metadata, artifact_id, revision):
    require(isinstance(metadata, dict))
    run = metadata.get("workflow_run")
    require(isinstance(run, dict))
    require(metadata.get("id") == artifact_id and metadata.get("expired") is False)
    size = metadata.get("size_in_bytes")
    require(type(size) is int and 0 < size <= ARCHIVE_LIMIT)
    require(metadata.get("url") ==
            f"https://api.github.com/repos/{REPOSITORY}/actions/artifacts/{artifact_id}")
    require(run.get("head_sha") == revision and run.get("head_branch") == BRANCH)
    require(type(run.get("repository_id")) is int and run["repository_id"] > 0)
    require(run.get("head_repository_id") == run["repository_id"])
    digest = metadata.get("digest")
    require(isinstance(digest, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", digest))
    return digest.removeprefix("sha256:")


def review_files(archive, expected_sha, operation, target):
    require(operation in {"prepare", "activate"} and target in {"staging", "production"})
    require(0 < len(archive) <= ARCHIVE_LIMIT)
    require(hashlib.sha256(archive).hexdigest() == expected_sha)
    required = {"qualification.json"}
    if operation == "activate":
        required.add("candidate-receipt.json")
    if target == "production":
        required.update({"staging-config.json", "staging-receipt.json"})
    result = {}
    total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as source:
            entries = source.infolist()
            require(1 <= len(entries) <= len(NAMES))
            for entry in entries:
                require(entry.filename in NAMES and entry.filename not in result)
                require(entry.filename in required)
                require(not entry.is_dir() and not (entry.flag_bits & 1))
                require(stat.S_IFMT(entry.external_attr >> 16) in {0, stat.S_IFREG})
                require(entry.compress_type in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED})
                require(0 < entry.file_size <= FILE_LIMIT)
                total += entry.file_size
                require(total <= TOTAL_LIMIT)
                with source.open(entry) as stream:
                    data = stream.read(FILE_LIMIT + 1)
                require(len(data) == entry.file_size and len(data) <= FILE_LIMIT)
                require(isinstance(parse_json(data), dict))
                result[entry.filename] = data
    except (zipfile.BadZipFile, RuntimeError, EOFError, OSError) as error:
        raise AdmissionError("review_artifact_archive_invalid") from error
    require(set(result) == required)
    return result


def download(artifact_id, revision, operation, target, output, fetch=bounded_gh):
    require(type(artifact_id) is int and 0 < artifact_id <= 2**53 - 1)
    require(isinstance(revision, str) and re.fullmatch(r"[0-9a-f]{40}", revision))
    endpoint = f"/repos/{REPOSITORY}/actions/artifacts/{artifact_id}"
    metadata = parse_json(fetch(endpoint, 32 * 1024))
    expected_sha = validate_metadata(metadata, artifact_id, revision)
    files = review_files(fetch(endpoint + "/zip", ARCHIVE_LIMIT), expected_sha, operation, target)
    # Validate every inert JSON file before creating an output directory or publishing files.
    output = Path(output)
    require(output.is_absolute() and not output.exists() and not output.is_symlink())
    output.mkdir(mode=0o700)
    for name, data in files.items():
        fd = os.open(output / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
    return {"artifactId": artifact_id, "archiveSha256": expected_sha,
            "revision": revision, "files": sorted(files)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-id", type=int, required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--operation", choices=["prepare", "activate"], required=True)
    parser.add_argument("--target", choices=["staging", "production"], required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    try:
        result = download(args.artifact_id, args.revision, args.operation, args.target, args.out)
        print(json.dumps(result))
    except (AdmissionError, OSError, subprocess.SubprocessError):
        raise SystemExit("Review artifact admission failed; no deployment action was taken.")


if __name__ == "__main__":
    main()
