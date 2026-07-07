#!/usr/bin/env bash
#
# Generate the XCTestRunner's baked version constant from the canonical
# package.json version.
#
# ios/XCTestRunner/Sources/XCTestRunner/AutoMobileVersion.swift is a GENERATED
# artifact: this script is its single source of truth. Baking the constant from
# package.json (rather than hand-editing, or regex-editing it in-place from the
# bump script) is what stops it drifting from the release it was cut from — the
# same guarantee the Android jar gets by stamping Implementation-Version from
# package.json at build time.
#
# Modes:
#   (default)  Write mode. Render AutoMobileVersion.swift from package.json.
#   --check    Drift gate. Exit non-zero if the committed file differs from what
#              this script would generate. CI runs this so a stale constant
#              fails the build instead of shipping.
#
# All paths are resolved relative to the current working directory (the repo
# root), mirroring scripts/versioning/bump-versions.sh, so the bump script can
# invoke this generator and both operate on the same tree.

set -euo pipefail

check_only=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      check_only=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

package_json="package.json"
swift_file="ios/XCTestRunner/Sources/XCTestRunner/AutoMobileVersion.swift"

if [[ ! -f "$package_json" ]]; then
  echo "ERROR: ${package_json} not found (run from the repo root)" >&2
  exit 1
fi

version="$(python3 - "$package_json" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        data = json.load(handle)
except json.JSONDecodeError as exc:
    sys.stderr.write(f"ERROR: package.json is not valid JSON: {exc}\n")
    sys.exit(1)

version = data.get("version")
if not version:
    sys.stderr.write("ERROR: package.json has no version field\n")
    sys.exit(1)
print(version)
PY
)"

# Guard against a malformed version leaking into the generated Swift. The daemon
# handshake compares the MAJOR.MINOR.PATCH release portion, so require that shape.
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$ ]]; then
  echo "ERROR: package.json version '${version}' is not MAJOR.MINOR.PATCH semver" >&2
  exit 1
fi

render() {
  cat <<EOF
// GENERATED FILE — DO NOT EDIT.
//
// Rendered from package.json by scripts/versioning/generate-ios-version.sh.
// To change the version, bump package.json (scripts/versioning/bump-versions.sh
// does this and regenerates), then re-run the generator. CI runs
// \`generate-ios-version.sh --check\` and fails on drift.
import Foundation

/// Baked client version the XCTestRunner declares to the AutoMobile daemon.
///
/// The runner shares one per-uid daemon socket with the TypeScript MCP proxy and the
/// Android JUnit runner. The daemon runs a server-side version handshake (#2744) and
/// rejects a client whose release version does not match its own, so the runner needs
/// a concrete version to declare — this constant is that value.
///
/// Generated from \`package.json\` so it can't drift from the release it was cut from;
/// mirrors the Android runner deriving its version from the jar \`Implementation-Version\`.
/// The daemon compares only the release portion, so a plain \`MAJOR.MINOR.PATCH\` here
/// matches a source-checkout daemon carrying a \`+g<sha>\` dev stamp at the same release.
public enum AutoMobileVersion {
    /// The current AutoMobile release version. Generated — do not edit by hand.
    public static let current = "${version}"
}
EOF
}

generated="$(render)"

if [[ "$check_only" == true ]]; then
  if [[ ! -f "$swift_file" ]]; then
    echo "ERROR: ${swift_file} is missing — run generate-ios-version.sh to create it" >&2
    exit 1
  fi
  if ! diff -u "$swift_file" <(printf '%s\n' "$generated") >/dev/null; then
    echo "ERROR: ${swift_file} has drifted from package.json (version ${version})." >&2
    echo "       Run scripts/versioning/generate-ios-version.sh to regenerate." >&2
    diff -u "$swift_file" <(printf '%s\n' "$generated") >&2 || true
    exit 1
  fi
  echo "OK: ${swift_file} matches package.json (${version})"
  exit 0
fi

printf '%s\n' "$generated" > "$swift_file"
echo "Generated ${swift_file} for version ${version}"
