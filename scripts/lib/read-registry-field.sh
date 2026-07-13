#!/usr/bin/env bash
#
# Single source of truth for reading a scalar field out of the FIRST entry of
# RELEASE_CHECKSUM_REGISTRY in src/constants/release.ts.
#
# Historically the same entry-anchored awk was copy-pasted into
# nightly.yml, verify-artifact-sha256.sh, and verify-release-integrity.sh, and
# a *fourth*, subtly-different `grep "$FIELD" | head -1 | sed` variant existed
# that matched the `ReleaseChecksumEntry` interface declaration
# (`apkSha256: string;`) instead of registry[0]. That collision silently
# no-op'd nightly APK/IPA updates and aborted releases with a misleading
# "No SHA256 checksum found" (#3784). Consolidating the readers here removes the
# drift surface and lets one bats suite cover the extraction.
#
# Anchoring on the entry's quoted `version: "` line is what makes the read
# immune to the interface: the interface's `version: string;` has no quote, so
# the block never arms while scanning the type declarations that precede the
# registry.
#
# An optional third argument anchors on a SPECIFIC `version: "<version>"` block
# instead of the first entry. The nightly checksum job uses this to read the
# dedicated NIGHTLY_CHECKSUM_ENTRY (`version: "nightly"`) — a standalone const
# after the registry — without ever touching a tagged release entry (#3784).
#
# Sourcing convention mirrors scripts/lib/tool-install.sh:
#   # shellcheck source=scripts/lib/read-registry-field.sh disable=SC1091
#   source "$(dirname "${BASH_SOURCE[0]}")/../lib/read-registry-field.sh"
# GitHub Actions run-steps execute from the repo root, so a workflow can source
# it by repo-relative path: `source scripts/lib/read-registry-field.sh`.

# read_registry_field <field> <release.ts path> [version]
# Prints the field's value from the target entry, or nothing if the field is
# absent or the entry does not exist. Never prints the interface type line.
# When [version] is empty/omitted, reads registry[0] (the first entry). When
# given (e.g. "nightly"), reads the block anchored on `version: "<version>"`.
# The closing anchor allows a column-0 `}` so the standalone NIGHTLY_CHECKSUM_ENTRY
# const (which closes with `};`) is matched as well as indented registry entries.
read_registry_field() {
  local field="$1" file="$2" version="${3:-}"
  awk -v field="$field" -v want="$version" '
    want == "" && /^[[:space:]]+version: "/ { in_block = 1 }
    want != "" && $0 ~ ("^[[:space:]]+version: \"" want "\"") { in_block = 1 }
    in_block && $0 ~ ("^[[:space:]]+" field ": \"") {
      line = $0
      sub(".*" field ": \"", "", line)
      sub(/".*/, "", line)
      print line
      exit
    }
    in_block && /^[[:space:]]*}/ { exit }
  ' "$file"
}

# Allow direct invocation: read-registry-field.sh <field> <release.ts> [version]
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  read_registry_field \
    "${1:?Usage: read-registry-field.sh <field> <release.ts> [version]}" \
    "${2:?Usage: read-registry-field.sh <field> <release.ts> [version]}" \
    "${3:-}"
fi
