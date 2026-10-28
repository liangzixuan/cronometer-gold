#!/usr/bin/env bash
set -euo pipefail

# Ubuntu 24.04 ships this tool-specific profile as an optional packaged profile.
# Load it only on the ephemeral CI runner; keep the host-wide restriction enabled.
sudo apt-get update
sudo apt-get install --no-install-recommends -y \
  erofs-utils=1.7.1-1build2 \
  bubblewrap=0.9.0-1ubuntu0.3 \
  apparmor-profiles=4.0.1really4.0.1-0ubuntu0.24.04.9
profile=/usr/share/apparmor/extra-profiles/bwrap-userns-restrict
printf '%s  %s\n' \
  11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9 \
  "$profile" | sha256sum --check --strict -
sudo install -m 0644 "$profile" /etc/apparmor.d/bwrap-userns-restrict
sudo /usr/sbin/apparmor_parser --replace /etc/apparmor.d/bwrap-userns-restrict

# Fail here with the native diagnostic, before tests or any provider request.
timeout 30 /usr/bin/bwrap \
  --unshare-all --die-with-parent --new-session --clearenv \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --cap-drop ALL -- /usr/bin/true