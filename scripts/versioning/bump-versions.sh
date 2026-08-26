#!/usr/bin/env bash

set -euo pipefail

# Every path (or glob pattern) this script may rewrite. The prepare-release
# workflow's versioned-tree guard consumes this list via --print-managed-paths,
# so a new managed file added here extends the release allow-list automatically
# instead of tripping the guard on the next release run (#5008). Patterns use
# bash [[ == ]] semantics, where `*` also matches `/`.
managed_path_patterns=(
  ".claude-plugin/marketplace.json"
  ".claude-plugin/plugin.json"
  "android/gradle.properties"
  "android/*/build.gradle.kts"
  "docs/design-docs/mcp/daemon/client-frame-snapshot.md"
  "docs/design-docs/mcp/daemon/client-screen-control.md"
  "docs/design-docs/mcp/daemon/unix-socket-api.md"
  "ios/XCTestRunner/Sources/XCTestRunner/AutoMobileVersion.swift"
  "package.json"
  "server.json"
)

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
    --print-managed-paths)
      printf '%s\n' "${managed_path_patterns[@]}"
      exit 0
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

# Rewrite version strings *in place* rather than reserializing the document.
# json.dump(indent=2) re-indents the whole file and explodes short arrays onto
# one element per line, which oxfmt then collapses again — so every release
# commit (which carries [skip ci]) landed a formatter failure on main (#5743).
#
# Every argument after the dry-run flag is a dot path to a version string, e.g.
# "version", "plugins.0.version", or "packages.*.version" (`*` covers every
# element of a list or every value of an object). Only the pointed-at leaves are
# rewritten: marketplace.json's own schema version must survive the release
# where the plugin version happens to equal it.
update_json_version_at() {
  local path="$1"
  local version="$2"
  local dry="$3"
  shift 3
  if [[ "$dry" == true ]]; then
    return 0
  fi
  python3 - "$path" "$version" "$@" <<'PY'
import json
import re
import sys

path = sys.argv[1]
version = sys.argv[2]
pointers = sys.argv[3:]


def child(node, part):
    return node[int(part)] if isinstance(node, list) else node[part]


def expand(node, parts, prefix=()):
    """Concrete paths for a dot pointer, resolving `*` against the document."""
    if not parts:
        yield prefix
        return
    head, rest = parts[0], parts[1:]
    if head == "*":
        keys = range(len(node)) if isinstance(node, list) else node.keys()
        for key in keys:
            yield from expand(child(node, str(key)), rest, prefix + (str(key),))
    else:
        yield from expand(child(node, head), rest, prefix + (head,))


def string_entries(node, prefix=()):
    """Every string-valued object entry, in document order.

    json.loads preserves source order, so this enumerates exactly the
    `"key": "value"` pairs the regex below finds, in the same order.
    """
    if isinstance(node, dict):
        for key, value in node.items():
            if isinstance(value, str):
                yield prefix + (key,), key, value
            else:
                yield from string_entries(value, prefix + (key,))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            if not isinstance(value, str):
                yield from string_entries(value, prefix + (str(index),))


with open(path, "r", encoding="utf-8") as handle:
    raw = handle.read()

document = json.loads(raw)

targets = []
for pointer in pointers:
    concrete = list(expand(document, pointer.split(".")))
    if not concrete:
        raise SystemExit(f"Pointer {pointer!r} matched nothing in {path}")
    targets.extend(concrete)

# Group by (key, current value): entries sharing both are indistinguishable to
# the regex, so they must be located together and selected by position.
groups = {}
for target in targets:
    current = document
    for part in target:
        current = child(current, part)
    if not isinstance(current, str):
        raise SystemExit(f"Pointer {'.'.join(target)} in {path} is not a string")
    groups.setdefault((target[-1], current), []).append(target)

edits = []
for (key, current), selected in groups.items():
    if current == version:
        continue
    occurrences = [
        found for found, name, value in string_entries(document)
        if name == key and value == current
    ]
    pattern = re.compile(
        r'("{}"\s*:\s*){}'.format(re.escape(key), re.escape(json.dumps(current)))
    )
    matches = list(pattern.finditer(raw))
    if len(matches) != len(occurrences):
        raise SystemExit(
            f"Found {len(matches)} textual {key!r} matches for {current!r} in "
            f"{path} but {len(occurrences)} in the parsed document"
        )
    for target in selected:
        match = matches[occurrences.index(target)]
        edits.append((match.start(), match.end(), match.group(1) + json.dumps(version)))

updated = raw
for begin, finish, replacement in sorted(edits, reverse=True):
    updated = updated[:begin] + replacement + updated[finish:]

# Reparse so a bad substitution fails the release rather than shipping broken JSON.
rewritten = json.loads(updated)
for target in targets:
    current = rewritten
    for part in target:
        current = child(current, part)
    if current != version:
        raise SystemExit(f"Failed to set {'.'.join(target)} to {version} in {path}")

with open(path, "w", encoding="utf-8") as handle:
    handle.write(updated)
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

update_json_version_at "package.json" "$new_version" "$dry_run" "version"
update_json_version_at ".claude-plugin/plugin.json" "$new_version" "$dry_run" "version"

# server.json carries the version at the top level and on every packages[]
# entry the MCP registry reads.
update_json_version_at "server.json" "$new_version" "$dry_run" \
  "version" "packages.*.version"

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

# marketplace.json nests the plugin version under plugins[0]; its own top-level
# "version" is the marketplace schema version and must not move.
update_json_version_at ".claude-plugin/marketplace.json" "$new_version" "$dry_run" \
  "plugins.*.version"

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
