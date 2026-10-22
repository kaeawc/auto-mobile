#!/usr/bin/env bash
#
# Reap only the processes a CI job itself started (#14826).
#
# The WHEP device-capture retry used to run `pkill -f "index.js --daemon-mode"`,
# which on a shared self-hosted Mac also killed every other AutoMobile daemon on
# the host (the owner's resident daemon, manual-test daemons). A process is only
# reaped here when it matches a known pattern AND either
#   - its pid is recorded in a `daemon.pid` file under a given job-owned data
#     directory (AutoMobile daemons), or
#   - its working directory is inside the job workspace (mediamtx, Chrome).
#
# Usage: reap-job-processes.sh <workspace-dir> [<data-dir-root>...]
#   Each data-dir-root is searched (depth 2) for daemon.pid files.
# Env: REAP_GRACE_SECONDS (default 2) between TERM and KILL.
# Prints the pids it signalled to stdout; never signals pids outside the scope.

set -uo pipefail

workspace="${1:-}"
if [[ -z "${workspace}" || ! -d "${workspace}" ]]; then
  echo "usage: $0 <workspace-dir> [<data-dir-root>...]" >&2
  exit 2
fi
shift
workspace="$(cd "${workspace}" && pwd -P)"
grace="${REAP_GRACE_SECONDS:-2}"

cwd_of() {
  lsof -a -d cwd -p "$1" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

in_workspace() {
  local dir
  dir="$(cwd_of "$1")"
  [[ -n "${dir}" && ( "${dir}" == "${workspace}" || "${dir}" == "${workspace}/"* ) ]]
}

command_of() {
  ps -o command= -p "$1" 2>/dev/null
}

pids=()

# Daemons: only pids recorded by this job's own pid files.
for root in "$@"; do
  [[ -d "${root}" ]] || continue
  while IFS= read -r pid_file; do
    pid="$(tr -dc '0-9' <"${pid_file}" 2>/dev/null | head -c 10)"
    [[ -n "${pid}" ]] || continue
    if command_of "${pid}" | grep -q -- "--daemon-mode"; then
      pids+=("${pid}")
    fi
  done < <(find "${root}" -maxdepth 2 -name daemon.pid 2>/dev/null)
done

# mediamtx and the WHEP Chrome: pattern match, kept only when rooted in the workspace.
while IFS= read -r pid; do
  [[ -n "${pid}" ]] || continue
  if in_workspace "${pid}"; then
    pids+=("${pid}")
  fi
done < <({ pgrep -x mediamtx; pgrep -f "remote-debugging-port=9222"; } 2>/dev/null)

if [[ ${#pids[@]} -eq 0 ]]; then
  exit 0
fi

unique=()
while IFS= read -r pid; do
  unique+=("${pid}")
done < <(printf '%s\n' "${pids[@]}" | sort -un)
pids=("${unique[@]}")
printf '%s\n' "${pids[@]}"
kill -TERM "${pids[@]}" 2>/dev/null || true
sleep "${grace}"
for pid in "${pids[@]}"; do
  if kill -0 "${pid}" 2>/dev/null; then
    kill -KILL "${pid}" 2>/dev/null || true
  fi
done
exit 0
