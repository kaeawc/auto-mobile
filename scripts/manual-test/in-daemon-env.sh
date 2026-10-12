#!/usr/bin/env bash
# Run a command with one initialized private daemon's env; never change cwd.
set -euo pipefail

usage() {
  echo 'Usage: in-daemon-env.sh --batch-dir B --daemon K [--] <command> [args...]' >&2
}
fail() {
  echo "error: $1" >&2
  usage
  exit 2
}
batch_dir=''
daemon=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --batch-dir | --daemon)
      flag="$1"
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "missing value for ${flag}"
      if [[ "$flag" == --batch-dir ]]; then batch_dir="$2"; else daemon="$2"; fi
      shift 2
      ;;
    --) shift; break ;;
    -*) fail "unknown flag $1" ;;
    *) break ;;
  esac
done
[[ -n "$batch_dir" ]] || fail 'missing --batch-dir'
[[ "$daemon" =~ ^[0-9]+$ && "$daemon" != 0 ]] || fail '--daemon must be numeric and positive'
[[ $# -gt 0 ]] || fail 'missing command'
env_file="${batch_dir}/daemon${daemon}/env.sh"
[[ -f "$env_file" ]] || fail "missing env file ${env_file}"
# shellcheck disable=SC1090
source "$env_file"
[[ "${AUTOMOBILE_AUX_SOCKET_DIR:-}" == /* && "${AUTOMOBILE_DAEMON_SOCKET_PATH:-}" == /* ]] || fail 'env needs absolute aux/socket paths'
case "$1" in
  daemon)
    [[ -n "${MT_SERVER:-}" ]] || fail 'env needs MT_SERVER for daemon shorthand'
    shift
    exec bun "$MT_SERVER" --daemon "$@"
    ;;
  proxy)
    shift
    repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
    exec bun "${repo_root}/scripts/manual-test/proxy-session.ts" "$@"
    ;;
  *) exec "$@" ;;
esac
