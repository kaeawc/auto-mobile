#!/usr/bin/env bash
#
# Check that each built deviceCondition memory-pressure payload is a 64-bit ELF
# for its own ABI (#16402). A binary built for the wrong target would otherwise
# ship under a valid release checksum and only fail on a device.
#
# Usage: verify-lmk-pressure-binaries.sh <build-dir>
#   <build-dir> holds <abi>/lmk_pressure, as written by
#   scripts/android/build-lmk-pressure.sh (LMK_PRESSURE_OUT).

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: verify-lmk-pressure-binaries.sh <build-dir>" >&2
  exit 2
fi

build_dir="$1"
abis=(arm64-v8a x86_64)
# ELF e_machine: EM_AARCH64 = 0xb7, EM_X86_64 = 0x3e.
machines=(00b7 003e)
failed=0

# Print <count> header bytes from <offset> as contiguous lowercase hex.
header_hex() {
  od -An -tx1 -j "$2" -N "$3" "$1" | tr -d ' \n'
}

for i in "${!abis[@]}"; do
  binary="$build_dir/${abis[$i]}/lmk_pressure"
  label="${abis[$i]}/lmk_pressure"
  if [ ! -f "$binary" ]; then
    echo "FAIL $label: missing"
    failed=1
    continue
  fi
  magic_and_class="$(header_hex "$binary" 0 5)"
  if [ "$magic_and_class" != "7f454c4602" ]; then
    echo "FAIL $label: not a 64-bit ELF"
    failed=1
    continue
  fi
  # e_machine is a little-endian u16 at offset 18; print it high byte first.
  machine_le="$(header_hex "$binary" 18 2)"
  machine="${machine_le:2:2}${machine_le:0:2}"
  if [ "$machine" != "${machines[$i]}" ]; then
    echo "FAIL $label: machine 0x$machine, expected machine 0x${machines[$i]}"
    failed=1
    continue
  fi
  echo "OK   $label: 64-bit ELF, machine 0x$machine"
done

exit "$failed"
