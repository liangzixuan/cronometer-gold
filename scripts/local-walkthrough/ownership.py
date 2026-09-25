"""Fail-closed identity checks for a private Linux walkthrough runtime."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import signal
import stat
import time


class WalkthroughError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise WalkthroughError(message)


def linux_directory(value, *, private=False):
    path = Path(value)
    require(path.is_absolute() and path == path.resolve(strict=True),
            "Use an existing absolute directory without symlinks or traversal.")
    require(not any(path == base or base in path.parents
                    for base in map(Path, ("/mnt", "/proc", "/sys", "/dev"))),
            "Use the Linux filesystem, outside mount and system directories.")
    metadata = path.lstat()
    require(stat.S_ISDIR(metadata.st_mode), "Expected a directory.")
    if private:
        require(metadata.st_uid == os.getuid() and stat.S_IMODE(metadata.st_mode) == 0o700,
                "Runtime must be an owner-private directory (0700).")
    return path


def read_private_json(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "r") as stream:
        metadata = os.fstat(stream.fileno())
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                and metadata.st_uid == os.getuid()
                and stat.S_IMODE(metadata.st_mode) == 0o600
                and 0 < metadata.st_size <= 1_048_576,
                "State must be a small owner-private regular file (0600).")
        return json.load(stream)


@contextmanager
def operation_lock(directory):
    descriptor = os.open(directory / "operation.lock",
                         os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        metadata = os.fstat(descriptor)
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                and metadata.st_uid == os.getuid() and stat.S_IMODE(metadata.st_mode) == 0o600,
                "Invalid runtime operation lock.")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise WalkthroughError("Another command is operating on this runtime.") from error
        yield
    finally:
        os.close(descriptor)


def write_json(path, value):
    # Unique receipts and state are never overwritten, followed, or silently resumed.
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                           0o600), "w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def process_identity(pid):
    require(type(pid) is int and pid > 1, "Invalid recorded process ID.")
    directory = Path("/proc") / str(pid)
    fields = (directory / "stat").read_text().rsplit(") ", 1)[1].split()
    if fields[0] == "Z":
        return None
    return {"pid": pid, "startTicks": fields[19], "processGroup": int(fields[2]),
            "uid": directory.stat().st_uid, "cwd": str((directory / "cwd").resolve(strict=True)),
            "exe": str((directory / "exe").resolve(strict=True))}


def live_identity(pid):
    try:
        return process_identity(pid)
    except (FileNotFoundError, ProcessLookupError):
        return None


def assert_process_identity(expected, actual):
    require(actual == expected and actual["uid"] == os.getuid()
            and actual["processGroup"] == actual["pid"],
            "Process identity changed; refusing to signal it.")


def group_members(group):
    members = []
    for directory in Path("/proc").iterdir():
        if directory.name.isdecimal():
            try:
                fields = (directory / "stat").read_text().rsplit(") ", 1)[1].split()
                if int(fields[2]) == group and fields[0] != "Z":
                    members.append(int(directory.name))
            except (FileNotFoundError, ProcessLookupError):
                pass
    return members


def process_has_owner(pid, run_id):
    marker = ("NOURISHING_WALKTHROUGH_OWNER=" + run_id).encode()
    return marker in (Path("/proc") / str(pid) / "environ").read_bytes().split(b"\0")


def stop_process(record, run_id, *, grace_seconds=35):
    """Pin every owned group member with a pidfd before sending any signal."""
    expected = record["identity"]
    actual = live_identity(expected["pid"])
    members = group_members(expected["processGroup"])
    if actual is None:
        require(not members, "Leader is gone but its group remains; inspect it manually.")
        return
    assert_process_identity(expected, actual)
    require(members and expected["pid"] in members, "Owned process group is missing.")
    handles = []
    try:
        for pid in members:
            descriptor = os.pidfd_open(pid)
            handles.append(descriptor)
            identity = live_identity(pid)
            require(identity is not None and identity["uid"] == os.getuid()
                    and identity["processGroup"] == expected["processGroup"]
                    and process_has_owner(pid, run_id),
                    "Process group contains an unowned member; refusing to signal it.")
        assert_process_identity(expected, live_identity(expected["pid"]))
        # pidfds cannot accidentally target a replacement process after PID reuse.
        for descriptor in handles:
            try:
                signal.pidfd_send_signal(descriptor, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + grace_seconds
        while time.monotonic() < deadline:
            remaining = group_members(expected["processGroup"])
            if not remaining:
                return
            time.sleep(0.1)
        raise WalkthroughError("Owned group did not stop gracefully; no force-kill was issued.")
    finally:
        for descriptor in handles:
            os.close(descriptor)


def container_identity(value):
    labels = value["Config"].get("Labels") or {}
    return {"id": value["Id"], "name": value["Name"], "image": value["Image"],
            "project": labels.get("com.docker.compose.project"),
            "service": labels.get("com.docker.compose.service"),
            "owner": labels.get("io.nourishing.walkthrough"),
            "ports": value["HostConfig"]["PortBindings"],
            "memory": value["HostConfig"]["Memory"],
            "memorySwap": value["HostConfig"]["MemorySwap"],
            "nanoCpus": value["HostConfig"]["NanoCpus"],
            "pidsLimit": value["HostConfig"]["PidsLimit"]}


def assert_container_identity(expected, actual, run_id):
    require(expected == actual and actual["owner"] == run_id
            and actual["project"] == "nourishing-walkthrough-" + run_id
            and actual["service"] in ("postgres", "meilisearch"),
            "Container identity changed; refusing to stop it.")
