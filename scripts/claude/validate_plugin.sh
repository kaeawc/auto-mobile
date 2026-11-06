#!/usr/bin/env bash

set -euo pipefail

# Validate the Claude plugin marketplace and the plugin it publishes.
#
# The marketplace manifest lives at .claude-plugin/marketplace.json. Its
# plugins[0].source names the plugin directory, which is the plugin root at
# install time: the runtime reads <root>/.claude-plugin/plugin.json and resolves
# every relative path in it (hooks, commands) from <root>. These checks follow
# that same chain so a path that only resolves from the repository root fails
# here, with or without the claude CLI installed.
#
# VALIDATE_PLUGIN_ROOT overrides the repository root (used by the BATS tests).

ROOT="${VALIDATE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

MARKETPLACE_JSON=".claude-plugin/marketplace.json"

echo "Validating Claude plugin..."

if [[ ! -f "$MARKETPLACE_JSON" ]]; then
  echo "ERROR: Required file '$MARKETPLACE_JSON' not found"
  exit 1
fi

# Resolve the plugin root from the marketplace entry and check every path the
# manifest declares, relative to that root, the way the runtime loader does.
if ! PLUGIN_DIR="$(python3 - "$MARKETPLACE_JSON" <<'PY'
import json
import os
import sys

def fail(message):
    sys.stderr.write(f"ERROR: {message}\n")
    sys.exit(1)

marketplace_path = sys.argv[1]
try:
    with open(marketplace_path, encoding="utf-8") as handle:
        marketplace = json.load(handle)
except (OSError, ValueError) as exc:
    fail(f"Invalid JSON in '{marketplace_path}': {exc}")

plugins = marketplace.get("plugins") or []
if not plugins:
    fail(f"'{marketplace_path}' lists no plugins")
source = plugins[0].get("source")
if not isinstance(source, str) or not source.startswith("./"):
    fail(f"'{marketplace_path}' plugins[0].source must be a ./relative path, got {source!r}")

plugin_dir = os.path.normpath(source)
manifest_path = os.path.join(plugin_dir, ".claude-plugin", "plugin.json")
if not os.path.isfile(manifest_path):
    fail(
        f"Plugin manifest '{manifest_path}' not found. The marketplace source "
        f"'{source}' is the plugin root, and the runtime reads "
        "<root>/.claude-plugin/plugin.json."
    )
try:
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
except (OSError, ValueError) as exc:
    fail(f"Invalid JSON in '{manifest_path}': {exc}")

def as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]

hooks_paths = [p for p in as_list(manifest.get("hooks")) if isinstance(p, str)]
for field in ("hooks", "commands"):
    for rel in as_list(manifest.get(field)):
        if not isinstance(rel, str):
            continue
        resolved = os.path.normpath(os.path.join(plugin_dir, rel))
        if not os.path.exists(resolved):
            fail(
                f"plugin.json {field} path '{rel}' not found: it resolves from "
                f"the plugin root '{plugin_dir}' to '{resolved}'"
            )

for rel in hooks_paths:
    resolved = os.path.normpath(os.path.join(plugin_dir, rel))
    try:
        with open(resolved, encoding="utf-8") as handle:
            hooks = json.load(handle)
    except (OSError, ValueError) as exc:
        fail(f"Invalid JSON in hooks file '{resolved}': {exc}")
    if not isinstance(hooks, dict) or not isinstance(hooks.get("hooks"), dict):
        fail(
            f"Hooks file '{resolved}' must hold its hook events under a "
            "top-level \"hooks\" object; the runtime loads no hooks otherwise"
        )

print(plugin_dir)
PY
)"; then
  exit 1
fi

PLUGIN_JSON="$PLUGIN_DIR/.claude-plugin/plugin.json"
echo "  ✓ $MARKETPLACE_JSON -> $PLUGIN_DIR"
echo "  ✓ $PLUGIN_JSON paths resolve from the plugin root"

# Check skills directory exists and has files
if [[ ! -d "$PLUGIN_DIR/skills" ]]; then
  echo "ERROR: Skills directory '$PLUGIN_DIR/skills' not found"
  exit 1
fi

skill_count=$(find "$PLUGIN_DIR/skills" -name "*.md" -type f | wc -l | tr -d ' ')
if [[ "$skill_count" -eq 0 ]]; then
  echo "ERROR: No skill files found in '$PLUGIN_DIR/skills'"
  exit 1
fi

echo "Found $skill_count skill file(s)"

# Validate skill files have required frontmatter
echo "Validating skill files..."
for skill_file in "$PLUGIN_DIR/skills"/*.md; do
  skill_name=$(basename "$skill_file")

  # Check for YAML frontmatter
  if ! skill_header=$(head -1 "$skill_file") || ! grep -q '^---$' <<<"${skill_header}"; then
    echo "ERROR: Skill '$skill_name' missing YAML frontmatter"
    exit 1
  fi

  # Check for description field
  if ! grep -q '^description:' "$skill_file"; then
    echo "ERROR: Skill '$skill_name' missing 'description' field"
    exit 1
  fi

  # Check for allowed-tools field
  if ! grep -q '^allowed-tools:' "$skill_file"; then
    echo "ERROR: Skill '$skill_name' missing 'allowed-tools' field"
    exit 1
  fi

  echo "  ✓ $skill_name"
done

# Validate version consistency between package.json and plugin.json
echo "Validating version consistency..."
package_version=$(python3 -c "import json, sys; print(json.load(open(sys.argv[1]))['version'])" package.json)
plugin_version=$(python3 -c "import json, sys; print(json.load(open(sys.argv[1]))['version'])" "$PLUGIN_JSON")

if [[ "$package_version" != "$plugin_version" ]]; then
  echo "ERROR: Version mismatch - package.json ($package_version) != $PLUGIN_JSON ($plugin_version)"
  exit 1
fi

echo "  ✓ Versions match: $package_version"

# The plugin directory wants the plugin's own README. `claude plugin validate
# --profile directory` falls back to the repository README, so it cannot catch
# a removed plugin README by itself (#16963).
if [[ ! -f "$PLUGIN_DIR/README.md" ]]; then
  echo "ERROR: Plugin README '$PLUGIN_DIR/README.md' not found"
  exit 1
fi
echo "  ✓ $PLUGIN_DIR/README.md"

# The icon is read straight from a marketplace clone, which does not fetch LFS
# objects, so a pointer committed in its place ships as a broken icon (#16963).
if ! python3 - "$PLUGIN_DIR" "$PLUGIN_JSON" <<'PY'
import json
import os
import sys

plugin_dir, manifest_path = sys.argv[1], sys.argv[2]
with open(manifest_path, encoding="utf-8") as handle:
    icon = json.load(handle).get("icon")
if isinstance(icon, str) and icon.lower().endswith(".png"):
    path = os.path.normpath(os.path.join(plugin_dir, icon))
    try:
        with open(path, "rb") as handle:
            header = handle.read(8)
    except OSError as exc:
        sys.stderr.write(f"ERROR: plugin.json icon '{icon}' not readable at '{path}': {exc}\n")
        sys.exit(1)
    if header != b"\x89PNG\r\n\x1a\n":
        sys.stderr.write(
            f"ERROR: plugin.json icon '{path}' is not a PNG (an LFS pointer?); "
            "commit the real image outside LFS\n"
        )
        sys.exit(1)
    print(f"  ✓ {path} is a PNG")
PY
then
  exit 1
fi

# CI must run the Claude CLI checks: a runner without the CLI fails instead of
# silently skipping them. Locally a missing CLI skips with a note, and an older
# CLI without --profile skips only the plugin directory checks.
IN_CI=false
if [[ "${CI:-}" == "true" || "${CI:-}" == "1" ]]; then
  IN_CI=true
fi

# Validate the marketplace from the repository root and the plugin from its own
# root, the directory the runtime loads it from.
if command -v claude &>/dev/null; then
  echo "Running Claude CLI validation..."
  if ! claude plugin validate .; then
    echo "ERROR: Claude CLI marketplace validation failed"
    exit 1
  fi
  if ! claude plugin validate "$PLUGIN_DIR"; then
    echo "ERROR: Claude CLI plugin validation failed"
    exit 1
  fi
  # The plugin directory profile also requires its README and icon.
  validate_help="$(claude plugin validate --help 2>&1 || true)"
  if [[ "$validate_help" == *"--profile"* ]]; then
    if ! claude plugin validate --profile directory "$PLUGIN_DIR"; then
      echo "ERROR: Claude CLI plugin directory profile validation failed"
      exit 1
    fi
  else
    echo "Note: Claude CLI has no 'plugin validate --profile', skipping the plugin directory checks"
  fi
elif [[ "$IN_CI" == "true" ]]; then
  echo "ERROR: Claude CLI not installed; CI must run the Claude CLI plugin checks (install it with scripts/ci/install-claude-code.sh)"
  exit 1
else
  echo "Note: Claude CLI not installed, skipping advanced validation"
fi

echo ""
echo "✓ Claude plugin validation passed"
