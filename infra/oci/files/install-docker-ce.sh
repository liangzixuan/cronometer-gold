#!/usr/bin/env bash
set -euo pipefail

export DNF_YUM_AUTO_YES=1

for attempt in $(seq 1 20); do
  if dnf -q -y install curl dnf-plugins-core openssl policycoreutils-python-utils python3; then
    break
  fi
  if [[ "$attempt" == "20" ]]; then
    echo "Unable to install base container-runtime packages after 20 attempts" >&2
    exit 1
  fi
  sleep 15
done

if [[ ! -f /etc/yum.repos.d/docker-ce.repo ]]; then
  dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
fi

grep -Eq '^gpgcheck=1$' /etc/yum.repos.d/docker-ce.repo || {
  echo "Docker repository must enforce RPM signature verification" >&2
  exit 1
}

readonly docker_ce='docker-ce-29.7.2-1.el9'
readonly docker_cli='docker-ce-cli-29.7.2-1.el9'
readonly containerd='containerd.io-2.3.3-1.el9'
readonly buildx='docker-buildx-plugin-0.36.1-1.el9'
readonly compose='docker-compose-plugin-5.4.0-1.el9'

for attempt in $(seq 1 20); do
  if dnf -q -y install "$docker_ce" "$docker_cli" "$containerd" "$buildx" "$compose"; then
    systemctl enable --now docker
    exit 0
  fi
  if [[ "$attempt" == "20" ]]; then
    echo "Unable to install Docker CE and Compose after 20 attempts" >&2
    exit 1
  fi
  sleep 15
done
