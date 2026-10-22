#!/usr/bin/env bash
# Stop the AutoMobile daemons this job's WebRTC device integration started, and no
# others (#14826). The integration test isolates each daemon's state under its
# artifact directory (`<artifact-dir>/daemon-*/daemon.pid`). A self-hosted Mac also
# runs the owner's resident daemon and verification daemons, which a host-wide
# `pkill -f "index.js --daemon-mode"` killed along with the job's own.
#
# Usage: reap-job-daemons.sh <artifact-dir> [TERM|KILL]
#
# A PID is signalled only while its command line is still an AutoMobile daemon, so a
# PID file left by a daemon that already exited cannot hit a recycled PID. Exits 0
# after a valid invocation: cleanup is best-effort, and the caller re-checks its port.
set -uo pipefail

usage() {
  echo "usage: $0 <artifact-dir> [TERM|KILL]" >&2
}

if [[ $# -lt 1 || $# -gt 2 || -z "$1" ]]; then
  usage
  exit 2
fi
readonly artifact_dir="$1"
readonly signal="${2:-TERM}"
if [[ "${signal}" != "TERM" && "${signal}" != "KILL" ]]; then
  usage
  exit 2
fi

if [[ ! -d "${artifact_dir}" ]]; then
  echo "No job daemons to reap: ${artifact_dir} does not exist."
  exit 0
fi

reaped=0
while IFS= read -r -d '' pid_file; do
  pid="$(jq -r '.pid // empty' "${pid_file}" 2>/dev/null || true)"
  if [[ ! "${pid}" =~ ^[0-9]+$ ]]; then
    echo "warn: ${pid_file} records no daemon pid" >&2
    continue
  fi
  command="$(ps -o command= -p "${pid}" 2>/dev/null || true)"
  if [[ "${command}" != *"--daemon-mode"* ]]; then
    continue
  fi
  if kill "-${signal}" "${pid}" 2>/dev/null; then
    echo "Sent SIG${signal} to job daemon ${pid} (${pid_file})"
    reaped=$((reaped + 1))
  fi
done < <(find "${artifact_dir}" -name daemon.pid -type f -print0)

echo "Reaped ${reaped} job daemon(s) with SIG${signal}."
