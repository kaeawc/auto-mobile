#!/usr/bin/env bash

set -euo pipefail

new_version=""
dry_run=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --new-version)
      new_version="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$new_version" ]]; then
  echo "Missing --new-version <semver> argument." >&2
  exit 1
fi

snapshot_version="${new_version}-SNAPSHOT"

update_json_version() {
  local path="$1"
  local version="$2"
  python3 - "$path" "$version" <<'PY'
import json
import sys

path = sys.argv[1]
version = sys.argv[2]

with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

data["version"] = version

with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
PY
}

replace_single_match() {
  local path="$1"
  local pattern="$2"
  local replacement="$3"
  python3 - "$path" "$pattern" "$replacement" <<'PY'
import re
import sys

path = sys.argv[1]
pattern = sys.argv[2]
replacement = sys.argv[3]

with open(path, "r", encoding="utf-8") as handle:
    data = handle.read()

matches = list(re.finditer(pattern, data, flags=re.MULTILINE))
if len(matches) != 1:
    raise SystemExit(
        f"Expected one match for {pattern!r} in {path}, found {len(matches)}"
    )

updated = re.sub(pattern, replacement, data, flags=re.MULTILINE)

with open(path, "w", encoding="utf-8") as handle:
    handle.write(updated)
PY
}

if [[ "$dry_run" == true ]]; then
  echo "Dry run complete. package.json -> ${new_version}"
  echo "Gradle version -> ${snapshot_version}"
  exit 0
fi

update_json_version "package.json" "$new_version"

replace_single_match \
  "android/auto-mobile-sdk/build.gradle.kts" \
  '^version\s*=\s*"[^"]*"' \
  "version = \"${snapshot_version}\""

replace_single_match \
  "android/junit-runner/build.gradle.kts" \
  '^version\s*=\s*"[^"]*"' \
  "version = \"${snapshot_version}\""

replace_single_match \
  "android/accessibility-service/build.gradle.kts" \
  'versionName\s*=\s*"[^"]*"' \
  "versionName = \"${snapshot_version}\""

replace_single_match \
  "android/playground/app/build.gradle.kts" \
  'versionName\s*=\s*"[^"]*"' \
  "versionName = \"${snapshot_version}\""
