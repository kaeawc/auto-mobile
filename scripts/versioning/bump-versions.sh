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

# Validate the version shape up front, before any file is written. The iOS
# generator (invoked late, below) rejects non-semver; validating here avoids
# aborting mid-bump with a half-updated tree on operator error.
# Restrict the optional pre-release/build segment to valid semver characters
# ([0-9A-Za-z.-]); the old `([-+].*)?` allowed `/`, `\`, `&` etc. which then
# broke the downstream sed/re.sub substitutions (#3653).
if ! [[ "$new_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid --new-version '${new_version}': expected MAJOR.MINOR.PATCH semver." >&2
  exit 1
fi

snapshot_version="${new_version}-SNAPSHOT"

update_json_version() {
  local path="$1"
  local version="$2"
  local dry="$3"
  if [[ "$dry" == true ]]; then
    return 0
  fi
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

replace_optional_single_match() {
  local path="$1"
  local pattern="$2"
  local replacement="$3"
  local dry="$4"
  python3 - "$path" "$pattern" "$replacement" "$dry" <<'PY'
import re
import sys

path = sys.argv[1]
pattern = sys.argv[2]
replacement = sys.argv[3]
dry = sys.argv[4].lower() == "true"

with open(path, "r", encoding="utf-8") as handle:
    data = handle.read()

matches = list(re.finditer(pattern, data, flags=re.MULTILINE))
if len(matches) > 1:
    raise SystemExit(
        f"Expected at most one match for {pattern!r} in {path}, found {len(matches)}"
    )

if len(matches) == 0:
    sys.exit(0)

updated = re.sub(pattern, replacement, data, flags=re.MULTILINE)

if not dry:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(updated)
PY
}

update_json_version "package.json" "$new_version" "$dry_run"
update_json_version ".claude-plugin/plugin.json" "$new_version" "$dry_run"

# Update server.json top-level version and packages[0].version for MCP registry
update_server_json_version() {
  local path="$1"
  local version="$2"
  local dry="$3"
  if [[ "$dry" == true ]]; then
    return 0
  fi
  python3 - "$path" "$version" <<'PY'
import json
import sys

path = sys.argv[1]
version = sys.argv[2]

with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

data["version"] = version

if "packages" in data:
    for pkg in data["packages"]:
        pkg["version"] = version

with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
PY
}
update_server_json_version "server.json" "$new_version" "$dry_run"

# Update VERSION_NAME in android/gradle.properties. This is the Android
# dev/Maven coordinate version, so local source builds intentionally keep the
# -SNAPSHOT suffix while package/runtime identity surfaces use plain semver.
update_gradle_properties_version() {
  local path="$1"
  local version="$2"
  local dry="$3"
  if [[ "$dry" == true ]]; then
    echo "Would update VERSION_NAME to $version in $path"
    return 0
  fi
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s/^VERSION_NAME=.*/VERSION_NAME=$version/" "$path"
  else
    sed -i "s/^VERSION_NAME=.*/VERSION_NAME=$version/" "$path"
  fi
}
update_gradle_properties_version "android/gradle.properties" "${snapshot_version}" "$dry_run"

# Update marketplace.json plugin version (nested in plugins[0].version)
update_marketplace_plugin_version() {
  local path="$1"
  local version="$2"
  local dry="$3"
  if [[ "$dry" == true ]]; then
    return 0
  fi
  python3 - "$path" "$version" <<'PY'
import json
import sys

path = sys.argv[1]
version = sys.argv[2]

with open(path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

if "plugins" in data and len(data["plugins"]) > 0:
    data["plugins"][0]["version"] = version

with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
PY
}
update_marketplace_plugin_version ".claude-plugin/marketplace.json" "$new_version" "$dry_run"

# Keep daemon consumer documentation aligned with the CtrlProxy artifacts that
# ship in the release. These references are intentionally updated as part of
# the same atomic version bump so prepare-release cannot leave main with a
# stale docs-test fixture.
update_ctrl_proxy_docs_version() {
  local version="$1"
  local dry="$2"
  local path
  local docs=(
    "docs/design-docs/mcp/daemon/client-screen-control.md"
    "docs/design-docs/mcp/daemon/client-frame-snapshot.md"
    "docs/design-docs/mcp/daemon/unix-socket-api.md"
  )

  for path in "${docs[@]}"; do
    if [[ "$dry" == true ]]; then
      echo "Would update CtrlProxy version references to $version in $path"
      continue
    fi
    python3 - "$path" "$version" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
version = sys.argv[2]
text = path.read_text(encoding="utf-8")
updated, count = re.subn(
    r"(default `)[^`]+(` CtrlProxy artifacts)",
    rf"\g<1>{version}\g<2>",
    text,
)
if count == 0:
    raise SystemExit(f"no default CtrlProxy version reference found in {path}")
path.write_text(updated, encoding="utf-8")
PY
  done
}
update_ctrl_proxy_docs_version "$new_version" "$dry_run"

# Keep the iOS XCTestRunner's baked client version in sync (mirrors Android's jar
# Implementation-Version). The daemon's version handshake compares the release portion,
# so this carries the plain MAJOR.MINOR.PATCH with no SNAPSHOT suffix.
#
# AutoMobileVersion.swift is a generated artifact. package.json is already updated
# above, so regenerate the Swift constant from it rather than regex-editing in place:
# this keeps package.json the single source of truth and lets the generator's
# `--check` drift gate catch any skew in CI. Resolve the generator relative to this
# script so it works regardless of the caller's cwd.
if [[ "$dry_run" != true ]]; then
  bump_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  bash "${bump_script_dir}/generate-ios-version.sh"
fi

if ! command -v rg >/dev/null 2>&1; then
  echo "ripgrep (rg) is required for fast Gradle scanning." >&2
  exit 1
fi

while IFS= read -r -d '' gradle_file; do
  replace_optional_single_match \
    "$gradle_file" \
    '^version\s*=\s*"[^"]*"' \
    "version = \"${snapshot_version}\"" \
    "$dry_run"

  replace_optional_single_match \
    "$gradle_file" \
    'versionName\s*=\s*"[^"]*"' \
    "versionName = \"${snapshot_version}\"" \
    "$dry_run"
done < <(rg -l --null -g 'build.gradle.kts' -e 'versionName\s*=' -e '^version\s*=' android)

if [[ "$dry_run" == true ]]; then
  echo "Dry run complete."
  echo "Package/runtime version -> ${new_version}"
  echo "Android dev/Maven coordinate -> ${snapshot_version}"
fi
