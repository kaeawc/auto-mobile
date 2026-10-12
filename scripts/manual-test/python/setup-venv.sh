#!/usr/bin/env bash
set -euo pipefail
usage() {
  echo 'Usage: setup-venv.sh --batch-dir <absolute existing dir> [--python <interpreter>] [--mcp-version <X.Y.Z>]' >&2
}
refuse() {
  echo "error: $1" >&2
  usage
  exit 2
}
batch_dir=''
python=python3
mcp_version=''
while (($#)); do
  case "$1" in
    --batch-dir|--python|--mcp-version)
      (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || refuse "missing value for $1"
      case "$1" in
        --batch-dir) batch_dir="$2" ;;
        --python) python="$2" ;;
        --mcp-version) mcp_version="$2" ;;
      esac
      shift 2
      ;;
    *) refuse "unknown argument: $1" ;;
  esac
done
[[ -n "$batch_dir" ]] || refuse '--batch-dir is required'
[[ "$batch_dir" == /* ]] || refuse '--batch-dir must be absolute'
[[ -d "$batch_dir" ]] || refuse '--batch-dir must name an existing directory'
[[ -z "$mcp_version" || "$mcp_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || refuse '--mcp-version must be X.Y.Z'
# realpath resolves aliases without changing the caller's working directory.
canonical_batch="$(realpath "$batch_dir")" || refuse 'cannot resolve --batch-dir'
canonical_state="$(realpath "$HOME")/.auto-mobile"
if [[ -e "$HOME/.auto-mobile" ]]; then
  canonical_state="$(realpath "$HOME/.auto-mobile")" || refuse 'cannot resolve resident state root'
fi
[[ "$canonical_batch" != / && "$canonical_batch" != "$canonical_state" && "$canonical_batch" != "$canonical_state/"* ]] || refuse 'batch directory must be outside / and resident product state'
venv="$batch_dir/python-venv"
if [[ -e "$venv" || -L "$venv" ]]; then
  [[ -d "$venv" && ! -L "$venv" ]] || refuse 'existing python-venv must be a real directory'
  [[ "$(realpath "$venv")" == "$canonical_batch/python-venv" ]] || refuse 'existing python-venv escapes batch directory'
  [[ -x "$venv/bin/python" ]] || refuse 'existing python-venv requires executable bin/python'
fi
"$python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1 || refuse 'Python 3.11 or newer is required'
script_dir="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
if [[ ! -e "$venv" ]]; then
  "$python" -m venv "$venv" >&2
fi
"$venv/bin/python" -m pip install --disable-pip-version-check --require-hashes -r "$script_dir/requirements.txt" >&2
if [[ -n "$mcp_version" ]]; then
  "$venv/bin/python" -m pip install --disable-pip-version-check "mcp==$mcp_version" >&2
  echo "notice: venv is now UNLOCKED (mcp==$mcp_version); comparison only" >&2
fi
printf '%s\n' "$venv/bin/python"
