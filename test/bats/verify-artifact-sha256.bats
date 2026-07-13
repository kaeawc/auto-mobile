#!/usr/bin/env bats
#
# Tests for scripts/ci/verify-artifact-sha256.sh
#
# Regression guards for #3658:
#  1. An empty/malformed registry value (e.g. ipaSha256: "") must produce the
#     actionable "No SHA256 checksum found" error, not a spurious "SHA256
#     mismatch". The old unanchored `sed 's///'` passed the whole source line
#     through on no match, making SOURCE_SHA256 non-empty and defeating the
#     `[ -z ]` guard.
#  2. sha256 must be computed via sha256sum-or-shasum so it works on macOS
#     (stock macOS has no sha256sum).

SCRIPT="scripts/ci/verify-artifact-sha256.sh"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  PROJECT="$(mktemp -d)"
  mkdir -p "$PROJECT/src/constants"
  ARTIFACT="$PROJECT/control-proxy.ipa"
  printf 'dummy artifact contents\n' > "$ARTIFACT"
  if command -v sha256sum >/dev/null 2>&1; then
    ART_SHA="$(sha256sum "$ARTIFACT" | cut -d' ' -f1)"
  else
    ART_SHA="$(shasum -a 256 "$ARTIFACT" | cut -d' ' -f1)"
  fi
}

teardown() {
  rm -rf "$PROJECT"
}

# $1 = ipaSha256 value (may be empty)
write_release_ts() {
  cat > "$PROJECT/src/constants/release.ts" <<EOF
interface ReleaseChecksumEntry {
  version: string;
  apkSha256: string;
  ipaSha256: string;
}

export const RELEASE_CHECKSUM_REGISTRY: ReleaseChecksumEntry[] = [
  {
    version: "1.0.0",
    apkSha256: "",
    ipaSha256: "$1",
  },
];
EOF
}

@test "empty ipaSha256 reports 'no checksum', not a spurious mismatch" {
  write_release_ts ""
  cd "$PROJECT"
  run bash "$ABS_SCRIPT" "$ARTIFACT" ios
  [ "$status" -ne 0 ]
  [[ "$output" == *"No SHA256 checksum found"* ]]
  [[ "$output" != *"SHA256 mismatch"* ]]
}

@test "matching ipaSha256 verifies successfully" {
  write_release_ts "$ART_SHA"
  cd "$PROJECT"
  run bash "$ABS_SCRIPT" "$ARTIFACT" ios
  [ "$status" -eq 0 ]
  [[ "$output" == *"verified successfully"* ]]
}

@test "sha256_of falls back to shasum when sha256sum is absent" {
  command -v shasum >/dev/null 2>&1 || skip "shasum not available"
  local bin
  bin="$(mktemp -d)"
  ln -s "$(command -v bash)" "$bin/bash"
  ln -s "$(command -v cut)" "$bin/cut"
  ln -s "$(command -v shasum)" "$bin/shasum"   # shasum present, sha256sum absent

  local fn="$PROJECT/sha256_of.sh"
  awk '/^sha256_of\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$ABS_SCRIPT" > "$fn"

  run env PATH="$bin" bash -c 'source "$1"; sha256_of "$2"' _ "$fn" "$ARTIFACT"
  rm -rf "$bin"
  [ "$status" -eq 0 ]
  [ "$output" = "$ART_SHA" ]
}
