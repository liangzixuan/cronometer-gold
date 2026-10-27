"""Decode an EROFS image as inert entries inside the caller's private sandbox."""
import os
import stat
import subprocess
import sys
import tarfile

max_bytes, max_files = map(int, sys.argv[1:])
subprocess.run([
    '/usr/bin/fsck.erofs', '--extract=/output', '--no-preserve-owner',
    '--preserve-perms', '/input',
], check=True, timeout=25, stdout=sys.stderr)
entries = []
total = 0
for parent, directories, files in os.walk('/output', followlinks=False):
    for name in sorted(directories + files):
        path = os.path.join(parent, name)
        metadata = os.lstat(path)
        mode = metadata.st_mode
        if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
            raise ValueError('unsupported_output_entry')
        if mode & 0o7000:
            raise ValueError('unsafe_output_mode')
        if stat.S_ISREG(mode):
            total += metadata.st_size
        entries.append(path)
        if total > max_bytes or len(entries) > max_files:
            raise ValueError('output_entry_limit')
# tarfile serializes data only; no image-supplied code or entrypoint is run.
with tarfile.open(fileobj=sys.stdout.buffer, mode='w|gz', format=tarfile.PAX_FORMAT) as output:
    for path in sorted(entries):
        name = os.path.relpath(path, '/output')
        row = output.gettarinfo(path, arcname=name)
        if row.islnk():
            # EROFS deduplicated regular inodes still have independent manifest paths.
            row.type = tarfile.REGTYPE
            row.linkname = ''
            row.size = os.lstat(path).st_size
        if row.isfile():
            with open(path, 'rb') as source:
                output.addfile(row, source)
        else:
            output.addfile(row)