#!/usr/bin/env bash
set -euo pipefail

readonly lock_file=/run/nutrition-object-credential-rotation.lock
readonly token_file=/run/nutrition-object-credential-rotation.token
readonly admission_file=/run/nutrition-object-credential-start-admission
owns_lock=0
temporary=

cleanup() {
  if [[ $owns_lock -eq 1 ]]; then
    rm -f -- "$token_file" "$admission_file"
  fi
  [[ -z "$temporary" ]] || rm -f -- "$temporary"
}
trap cleanup EXIT HUP INT TERM

[[ $EUID -eq 0 && $# -eq 0 ]] || { echo "Run the rotation lock holder as root without arguments" >&2; exit 64; }
IFS= read -r token
[[ "$token" =~ ^[0-9a-f]{64}$ ]] || { echo "Invalid credential-rotation token" >&2; exit 1; }

umask 077
exec 9>"$lock_file"
[[ ! -L "$lock_file" && -f "$lock_file" && "$(stat -c '%U:%G:%a' "$lock_file")" == root:root:600 ]] || {
  echo "Unsafe object credential rotation lock file" >&2
  exit 1
}
flock -n -E 75 9 || { echo "Another object credential rotation is active" >&2; exit 75; }
owns_lock=1
rm -f -- "$admission_file"
temporary=$(mktemp /run/.nutrition-object-credential-token.XXXXXX)
printf '%s\n' "$token" >"$temporary"
chown root:root "$temporary"
chmod 0400 "$temporary"
mv -f "$temporary" "$token_file"
temporary=
sync -f /run
echo LOCKED

# The local provisioner holds the FIFO writer open. EOF releases the lock.
while IFS= read -r _ignored; do :; done
