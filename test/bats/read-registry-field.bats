#!/usr/bin/env bats
#
# Tests for scripts/lib/read-registry-field.sh — the shared reader that extracts
# a scalar field from registry[0] of RELEASE_CHECKSUM_REGISTRY. This is the
# regression guard for the interface-collision bug (#3784): the extraction must
# read the registry entry, never the `ReleaseChecksumEntry` interface
# declaration (`apkSha256: string;`) that precedes it.

HELPER="scripts/lib/read-registry-field.sh"

setup() {
  ABS_HELPER="$(cd "$(dirname "$HELPER")" && pwd)/$(basename "$HELPER")"
  PROJECT="$(mktemp -d)"
  RELEASE_TS="$PROJECT/release.ts"
}

teardown() {
  rm -rf "$PROJECT"
}

# Emits a production-shaped release.ts: the interface (whose field names collide
# with the registry field names) followed by two multi-line registry entries.
write_release_ts() {
  cat > "$RELEASE_TS" <<'EOF'
export interface ReleaseChecksumEntry {
  version: string;
  apkSha256: string;
  ipaSha256: string;
  runnerSha256: string;
}

export const RELEASE_CHECKSUM_REGISTRY: ReleaseChecksumEntry[] = [
  {
    version: "0.0.44",
    apkSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ipaSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    runnerSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  },
  {
    version: "0.0.43",
    apkSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    ipaSha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    runnerSha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  },
];
EOF
}

read_field() {
  bash "$ABS_HELPER" "$1" "$RELEASE_TS"
}

@test "reads registry[0].apkSha256, not the interface type line" {
  write_release_ts
  run read_field apkSha256
  [ "$status" -eq 0 ]
  [ "$output" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ]
}

@test "reads registry[0].ipaSha256 and runnerSha256" {
  write_release_ts
  run read_field ipaSha256
  [ "$output" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]
  run read_field runnerSha256
  [ "$output" = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" ]
}

@test "returns registry[0], never a later entry" {
  write_release_ts
  run read_field apkSha256
  # 0.0.43's apk (dddd…) must never be returned.
  [ "$output" != "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" ]
}

@test "empty registry[0] field yields empty output (not the interface line)" {
  write_release_ts
  # Blank registry[0].runnerSha256.
  sed -i.bak 's/runnerSha256: "cccc[c]*"/runnerSha256: ""/' "$RELEASE_TS"
  run read_field runnerSha256
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "can be sourced and called as a function" {
  write_release_ts
  run bash -c 'source "$1"; read_registry_field ipaSha256 "$2"' _ "$ABS_HELPER" "$RELEASE_TS"
  [ "$status" -eq 0 ]
  [ "$output" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]
}
