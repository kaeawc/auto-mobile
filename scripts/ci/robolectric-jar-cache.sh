#!/usr/bin/env bash
#
# Helpers for the shared Robolectric android-all jar cache in
# .github/actions/gradle-task-run (#16396).
#
# Robolectric downloads one android-all-instrumented jar per SDK level into
# ~/.m2/repository at test time, with a single attempt. gradle-task-run caches
# that directory: the key names the Robolectric version (the jar set changes
# with it), and the fingerprint tells the saving job whether the run added jars.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  robolectric-jar-cache.sh key <libs.versions.toml>
      Print the cache key prefix for the catalog's [versions] robolectric.
  robolectric-jar-cache.sh fingerprint <dir>
      Print a digest of the *.jar files under <dir> (relative path and size),
      or "none" when there are none.
USAGE
}

robolectric_version() {
  # A structured TOML parse, not a line regex: the catalog has several
  # robolectric-prefixed keys and inline tables.
  python3 - "$1" <<'PY'
import sys
import tomllib

with open(sys.argv[1], "rb") as handle:
    catalog = tomllib.load(handle)
version = catalog.get("versions", {}).get("robolectric")
if not isinstance(version, str) or not version:
    sys.exit("no [versions] robolectric in " + sys.argv[1])
print(version)
PY
}

cmd_key() {
  [ "$#" -eq 1 ] || { usage >&2; exit 2; }
  local version
  version="$(robolectric_version "$1")"
  printf 'robolectric-android-all-v1-%s\n' "$version"
}

cmd_fingerprint() {
  [ "$#" -eq 1 ] || { usage >&2; exit 2; }
  local dir="$1" listing
  if [ ! -d "$dir" ]; then
    echo none
    return 0
  fi
  # Portable find/wc/cksum (no GNU -printf or sha256sum): this only has to
  # notice a jar that was added or replaced.
  local jar
  listing="$(
    cd "$dir" && find . -type f -name '*.jar' | LC_ALL=C sort | while IFS= read -r jar; do
      printf '%s %s\n' "$jar" "$(wc -c < "$jar" | tr -d ' ')"
    done
  )"
  if [ -z "$listing" ]; then
    echo none
    return 0
  fi
  printf '%s\n' "$listing" | cksum | cut -d' ' -f1-2 | tr ' ' '-'
}

main() {
  local cmd="${1:-}"
  [ "$#" -gt 0 ] && shift
  case "$cmd" in
    key) cmd_key "$@" ;;
    fingerprint) cmd_fingerprint "$@" ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
