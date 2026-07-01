#!/usr/bin/env bash
# Verify release integrity before publishing.
#
# Two independent gaps this gate closes (see issue #2745):
#   1. Version equality — the npm version, every release manifest, the checksum
#      registry, and the git tag must all name the SAME version. Nothing else
#      enforces this; bump-versions.sh merely writes them together.
#   2. iOS runner-binary checksum — IOS_CTRL_PROXY_RUNNER_SHA256 must be a real
#      sha256, not the "" default. Empty silently disables runner integrity
#      verification for the simulator path.
#
# package.json is the canonical version source; every other value is checked
# against the <version> argument (the git tag), which prepare-release keeps
# equal to package.json.
#
# Usage: verify-release-integrity.sh <version>
#   <version> is the release version / git tag. A leading "v" is stripped.
set -euo pipefail

RAW_VERSION="${1:?Usage: verify-release-integrity.sh <version>}"
EXPECTED="${RAW_VERSION#v}"

PACKAGE_JSON="package.json"
PLUGIN_JSON=".claude-plugin/plugin.json"
MARKETPLACE_JSON=".claude-plugin/marketplace.json"
SERVER_JSON="server.json"
GRADLE_PROPS="android/gradle.properties"
RELEASE_TS="src/constants/release.ts"

for f in "$PACKAGE_JSON" "$PLUGIN_JSON" "$MARKETPLACE_JSON" "$SERVER_JSON" \
  "$GRADLE_PROPS" "$RELEASE_TS"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: required file not found: $f"
    exit 1
  fi
done

errors=()

# check <label> <actual-version>
check() {
  local label="$1" actual="$2"
  if [ "$actual" != "$EXPECTED" ]; then
    errors+=("${label}: expected '${EXPECTED}', got '${actual}'")
  else
    echo "  OK  ${label} = ${actual}"
  fi
}

# Extract a JSON field, failing the whole gate loudly (clean message, no python
# traceback) if the file is malformed or the field is missing — a swallowed
# extraction would otherwise surface only as a confusing "expected X, got ''".
json_field() {
  # $1 = file, $2 = python expression evaluated against `d` (parsed JSON)
  python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
    print(eval(sys.argv[2]))
except Exception as exc:
    sys.stderr.write(f"failed to read {sys.argv[2]} from {sys.argv[1]}: {exc}\n")
    sys.exit(1)' "$1" "$2"
}

pkg_version="$(json_field "$PACKAGE_JSON" 'd["version"]')" || exit 1
check "package.json version" "$pkg_version"
plugin_version="$(json_field "$PLUGIN_JSON" 'd["version"]')" || exit 1
check ".claude-plugin/plugin.json version" "$plugin_version"
marketplace_version="$(json_field "$MARKETPLACE_JSON" 'd["plugins"][0]["version"]')" || exit 1
check ".claude-plugin/marketplace.json plugins[0].version" "$marketplace_version"
server_version="$(json_field "$SERVER_JSON" 'd["version"]')" || exit 1
check "server.json version" "$server_version"

server_packages="$(python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
    for p in d.get("packages", []):
        print(p["version"])
except Exception as exc:
    sys.stderr.write(f"failed to read packages from {sys.argv[1]}: {exc}\n")
    sys.exit(1)' "$SERVER_JSON")" || exit 1
while IFS= read -r pkg_ver; do
  [ -n "$pkg_ver" ] && check "server.json packages[].version" "$pkg_ver"
done <<< "$server_packages"

# gradle.properties keeps a -SNAPSHOT suffix for dev/Maven coordinates; the
# release coordinate is overridden with -PVERSION_NAME at publish. Only the base
# version participates in equality. (tr strips a stray CR from CRLF checkouts.)
gradle_version="$(grep -E '^VERSION_NAME=' "$GRADLE_PROPS" | head -1 | cut -d= -f2 | tr -d '\r')"
check "android/gradle.properties VERSION_NAME (base)" "${gradle_version%-SNAPSHOT}"

registry_version="$(grep -m1 -E '^[[:space:]]+version: "' "$RELEASE_TS" \
  | sed 's/.*version: "\([^"]*\)".*/\1/')"
check "src/constants/release.ts registry[0].version" "$registry_version"

# Runner-binary checksum must be populated. Empty ("" default) means integrity
# verification is silently skipped — exactly the gap this gate exists to catch.
runner_sha="$(grep -E '^export const IOS_CTRL_PROXY_RUNNER_SHA256' "$RELEASE_TS" \
  | sed 's/.*= "\([^"]*\)".*/\1/')"
if [[ "$runner_sha" =~ ^[a-f0-9]{64}$ ]]; then
  echo "  OK  IOS_CTRL_PROXY_RUNNER_SHA256 populated"
else
  errors+=("IOS_CTRL_PROXY_RUNNER_SHA256 must be a 64-char hex sha256, got '${runner_sha}' (empty disables runner integrity verification)")
fi

if [ "${#errors[@]}" -gt 0 ]; then
  echo ""
  echo "ERROR: release integrity check failed for version '${EXPECTED}':"
  for e in "${errors[@]}"; do
    echo "  - ${e}"
  done
  echo ""
  echo "All manifests + the checksum registry + the git tag must name the same"
  echo "version, and the iOS runner checksum must be populated, before releasing."
  exit 1
fi

echo ""
echo "Release integrity verified for version ${EXPECTED}."
