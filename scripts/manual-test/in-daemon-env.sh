#!/usr/bin/env bash
# Run a command with one private daemon env; cwd changes only with --cd.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: in-daemon-env.sh --batch-dir B --daemon K [--cd DIR] [--] <command> [args...]
  --batch-dir B  Initialized batch directory (required).
  --daemon K     Daemon number (required).
  --cd DIR       Absolute existing directory; change cwd before exec (default: preserve cwd).
  --             End wrapper options.
  --help, -h     Show help and exit 0.
Shorthands:
  daemon  bun "$MT_SERVER" --daemon ... (requires MT_SERVER; start/restart refused).
  cli     bun "$MT_SERVER" --cli ... (requires MT_SERVER).
  proxy   Run proxy-session.ts.
  frame   Run daemon-frame.ts.
  aux     Run aux-socket.ts.
Examples:
  in-daemon-env.sh --batch-dir /private/batch --daemon 1 cli listDevices
  in-daemon-env.sh --batch-dir /private/batch --daemon 1 --cd /checkout daemon status
  in-daemon-env.sh --batch-dir /private/batch --daemon 1 frame send daemon/capabilities
HELP
}
fail() {
  echo "error: $1" >&2
  usage >&2
  exit 2
}
batch_dir=''
daemon=''
cd_dir=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help | -h) usage; exit 0 ;;
    --batch-dir | --daemon | --cd)
      flag="$1"
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "missing value for ${flag}"
      case "$flag" in
        --batch-dir) batch_dir="$2" ;;
        --daemon) daemon="$2" ;;
        --cd) cd_dir="$2" ;;
      esac
      shift 2
      ;;
    --) shift; break ;;
    -*) fail "unknown flag $1" ;;
    *) break ;;
  esac
done
if [[ -n "$cd_dir" ]]; then
  [[ "$cd_dir" == /* ]] || fail '--cd must be absolute'
  [[ -d "$cd_dir" ]] || fail '--cd directory must exist'
fi
[[ -n "$batch_dir" ]] || fail 'missing --batch-dir'
[[ "$daemon" =~ ^[0-9]+$ && "$daemon" != 0 ]] || fail '--daemon must be numeric and positive'
[[ $# -gt 0 ]] || fail 'missing command'
env_file="${batch_dir}/daemon${daemon}/env.sh"
[[ -f "$env_file" ]] || fail "missing env file ${env_file}"
# shellcheck disable=SC1090 # The selected private daemon generates its environment file at runtime.
source "$env_file"
[[ "${AUTOMOBILE_AUX_SOCKET_DIR:-}" == /* && "${AUTOMOBILE_DAEMON_SOCKET_PATH:-}" == /* ]] || fail 'env needs absolute aux/socket paths'
case "$1" in
  proxy | frame | aux)
    repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
    ;;
esac
if [[ -n "$cd_dir" ]]; then cd -- "$cd_dir"; fi
case "$1" in
  cli)
    [[ -n "${MT_SERVER:-}" ]] || fail 'env needs MT_SERVER for cli shorthand'
    shift
    exec bun "$MT_SERVER" --cli "$@"
    ;;
  daemon)
    [[ -n "${MT_SERVER:-}" ]] || fail 'env needs MT_SERVER for daemon shorthand'
    shift
    case "${1:-}" in
      start* | restart*) fail 'use private-daemon.ts start, which owns --port --strict-port; a restart is stop + start' ;;
    esac
    exec bun "$MT_SERVER" --daemon "$@"
    ;;
  proxy | frame | aux)
    shorthand="$1"
    shift
    case "$shorthand" in
      proxy) script='proxy-session.ts' ;;
      frame) script='daemon-frame.ts' ;;
      aux) script='aux-socket.ts' ;;
    esac
    exec bun "${repo_root}/scripts/manual-test/${script}" "$@"
    ;;
  *) exec "$@" ;;
esac
