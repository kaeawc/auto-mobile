#!/usr/bin/env bats
#
# Tests for scripts/desktop/conveyor-native-audit.sh (#5543): classifies jars and loose native
# libraries in a built Conveyor package as native to, or foreign to, the target platform.

SCRIPT="scripts/desktop/conveyor-native-audit.sh"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  PKG="$(mktemp -d)"
}

teardown() {
  rm -rf "$PKG"
}

# Creates a file of exactly $2 bytes at $PKG/$1.
make_file() {
  mkdir -p "$(dirname "$PKG/$1")"
  head -c "$2" /dev/zero >"$PKG/$1"
}

foreign_bytes() {
  sed -n 's/^Foreign to target: *\([0-9]*\) bytes$/\1/p' <<<"$output"
}

@test "counts other-OS skiko and ffmpeg jars as foreign for a linux target" {
  make_file app/skiko-awt-runtime-linux-x64-0.9.jar 100
  make_file app/skiko-awt-runtime-macos-arm64-0.9.jar 200
  make_file app/ffmpeg-7.1-1.5-macosx-x86_64.jar 300
  make_file app/ffmpeg-7.1-1.5-linux-x86_64.jar 50
  run "$ABS_SCRIPT" --target linux-amd64 "$PKG"
  [ "$status" -eq 0 ]
  [ "$(foreign_bytes)" = "500" ]
  [[ "$output" == *"skiko-awt-runtime-macos-arm64-0.9.jar"* ]]
  [[ "$output" != *"skiko-awt-runtime-linux-x64-0.9.jar"* ]]
}

@test "treats the other architecture of the same OS as foreign" {
  make_file app/skiko-awt-runtime-macos-arm64-0.9.jar 200
  make_file app/skiko-awt-runtime-macos-x64-0.9.jar 70
  run "$ABS_SCRIPT" --target mac-aarch64 "$PKG"
  [ "$status" -eq 0 ]
  [ "$(foreign_bytes)" = "70" ]
}

@test "classifies loose native libraries by extension" {
  make_file lib/libskiko.so 400
  make_file lib/libskiko.dylib 30
  make_file lib/skiko.dll 5
  run "$ABS_SCRIPT" --target mac-amd64 "$PKG"
  [ "$status" -eq 0 ]
  [ "$(foreign_bytes)" = "405" ]
}

@test "flags javacpp -platform meta jars as foreign everywhere" {
  make_file app/ffmpeg-platform-7.1-1.5.jar 900
  make_file app/compose-runtime.jar 10
  run "$ABS_SCRIPT" --target linux-amd64 "$PKG"
  [ "$status" -eq 0 ]
  [ "$(foreign_bytes)" = "900" ]
}

@test "platform-neutral jars are never foreign" {
  make_file app/kotlin-stdlib.jar 1000
  run "$ABS_SCRIPT" --target linux-amd64 "$PKG"
  [ "$status" -eq 0 ]
  [ "$(foreign_bytes)" = "0" ]
  [[ "$output" == *"Scanned jars + native libraries: 1000 bytes"* ]]
}

@test "reads a zip archive" {
  make_file app/skiko-awt-runtime-linux-x64-0.9.jar 100
  make_file app/skiko-awt-runtime-macos-arm64-0.9.jar 200
  (cd "$PKG" && zip -qr ../pkg.zip app)
  run "$ABS_SCRIPT" --target mac-aarch64 "$PKG/../pkg.zip"
  rm -f "$PKG/../pkg.zip"
  [ "$status" -eq 0 ]
  [ "$(foreign_bytes)" = "100" ]
}

@test "--max-foreign-bytes fails only when foreign bytes exceed the budget" {
  make_file app/skiko-awt-runtime-macos-arm64-0.9.jar 200
  run "$ABS_SCRIPT" --target linux-amd64 --max-foreign-bytes 200 "$PKG"
  [ "$status" -eq 0 ]
  run "$ABS_SCRIPT" --target linux-amd64 --max-foreign-bytes 199 "$PKG"
  [ "$status" -eq 1 ]
  [[ "$output" == *"exceed --max-foreign-bytes 199"* ]]
}

@test "rejects an unknown target and a missing path" {
  run "$ABS_SCRIPT" --target windows-amd64 "$PKG"
  [ "$status" -eq 2 ]
  run "$ABS_SCRIPT" --target linux-amd64 "$PKG/missing"
  [ "$status" -eq 2 ]
}
