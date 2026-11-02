#!/usr/bin/env bats
#
# Tests for scripts/ci/verify-lmk-pressure-binaries.sh (#16402): each released
# memory-pressure payload must be a 64-bit ELF built for its own ABI, so a
# mis-targeted build cannot ship under a valid checksum.

SCRIPT="scripts/ci/verify-lmk-pressure-binaries.sh"

setup() {
  OUT="$BATS_TEST_TMPDIR/out"
  mkdir -p "$OUT/arm64-v8a" "$OUT/x86_64"
}

# $1 = path, $2 = ELF class byte (\002 = 64-bit), $3 = e_machine low byte, $4 = high byte.
write_elf() {
  {
    printf '\177ELF%b\001\001' "$2"
    printf '\000%.0s' $(seq 1 9)
    printf '\003\000'
    printf '%b%b' "$3" "$4"
    printf '\000%.0s' $(seq 1 44)
  } > "$1"
}

@test "accepts an aarch64 arm64-v8a binary and an x86-64 x86_64 binary" {
  write_elf "$OUT/arm64-v8a/lmk_pressure" '\002' '\267' '\000'
  write_elf "$OUT/x86_64/lmk_pressure" '\002' '\076' '\000'
  run bash "$SCRIPT" "$OUT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"arm64-v8a/lmk_pressure: 64-bit ELF, machine 0x00b7"* ]]
  [[ "$output" == *"x86_64/lmk_pressure: 64-bit ELF, machine 0x003e"* ]]
}

@test "rejects swapped ABIs" {
  write_elf "$OUT/arm64-v8a/lmk_pressure" '\002' '\076' '\000'
  write_elf "$OUT/x86_64/lmk_pressure" '\002' '\267' '\000'
  run bash "$SCRIPT" "$OUT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"arm64-v8a/lmk_pressure"*"expected machine 0x00b7"* ]]
}

@test "rejects a 32-bit ELF" {
  write_elf "$OUT/arm64-v8a/lmk_pressure" '\001' '\267' '\000'
  write_elf "$OUT/x86_64/lmk_pressure" '\002' '\076' '\000'
  run bash "$SCRIPT" "$OUT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not a 64-bit ELF"* ]]
}

@test "rejects a file that is not an ELF" {
  printf '#!/bin/sh\necho hi\n' > "$OUT/arm64-v8a/lmk_pressure"
  write_elf "$OUT/x86_64/lmk_pressure" '\002' '\076' '\000'
  run bash "$SCRIPT" "$OUT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not a 64-bit ELF"* ]]
}

@test "rejects a missing binary" {
  write_elf "$OUT/arm64-v8a/lmk_pressure" '\002' '\267' '\000'
  run bash "$SCRIPT" "$OUT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"x86_64/lmk_pressure: missing"* ]]
}

@test "requires the output directory argument" {
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"Usage:"* ]]
}
