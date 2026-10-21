#!/usr/bin/env bash
# Capture verbatim Linux /proc status and cmdline samples from Docker images.
# Usage: scripts/capture-proc-fixtures.sh [out-dir]
set -euo pipefail

OUT_DIR="${1:-test/fixtures/android-boot-admission}"

if ! command -v docker >/dev/null 2>&1; then
  echo "capture-proc-fixtures.sh requires docker on PATH" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "capture-proc-fixtures.sh cannot reach the Docker daemon; start Docker and retry" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
for image_label in alpine debian; do
  if [ "$image_label" = alpine ]; then
    image="alpine:3.20"
  else
    image="debian:12-slim"
  fi
  container="am-proc-capture-${image_label}-$$"
  cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  docker run -d --name "$container" "$image" sh -c \
    'sleep 300 & echo $! > /tmp/capture.pid; wait' >/dev/null
  ready=0
  attempt=0
  while [ "$attempt" -lt 50 ]; do
    if docker exec "$container" test -s /tmp/capture.pid; then
      ready=1
      break
    fi
    sleep 0.1
    attempt=$((attempt + 1))
  done
  if [ "$ready" -ne 1 ]; then
    printf 'Timed out waiting for /tmp/capture.pid in container %s\n' "$container" >&2
    exit 1
  fi
  pid="$(docker exec "$container" cat /tmp/capture.pid)"
  docker exec "$container" cat "/proc/$pid/status" >"$OUT_DIR/proc-$image_label-status.txt"
  docker exec "$container" cat "/proc/$pid/cmdline" >"$OUT_DIR/proc-$image_label-cmdline.bin"
  docker exec "$container" cat /proc/1/status >"$OUT_DIR/proc-$image_label-pid1-status.txt"

  digest="$(docker image inspect --format '{{join .RepoDigests ","}}' "$image")"
  if [ -z "$digest" ]; then
    digest="$image (local tag; RepoDigest unavailable)"
  fi
  {
    printf 'image: %s\n' "$digest"
    printf 'uname -r: '
    docker exec "$container" uname -r
    printf 'date -u: '
    date -u
    printf 'captured pid: %s\n' "$pid"
  } >"$OUT_DIR/proc-$image_label-provenance.txt"
  cleanup
  trap - EXIT
done
