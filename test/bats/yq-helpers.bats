#!/usr/bin/env bats
#
# Covers require_mikefarah_yq (test/bats/yq-helpers.bash) with stub yq binaries.
# Each case runs the helper in a child bash whose PATH holds only the stub dir,
# so the host's own yq (mikefarah, python-yq or none) cannot leak in. `skip` is
# stubbed to print its reason and exit 3, standing in for bats' skip.

setup() {
  STUB_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB_BIN"
  HELPER="$BATS_TEST_DIRNAME/yq-helpers.bash"
  BASH_BIN="$(command -v bash)"
}

stub_yq() {
  printf '#!%s\nprintf "%%s\\n" %q\n' "$BASH_BIN" "$1" > "$STUB_BIN/yq"
  chmod +x "$STUB_BIN/yq"
}

run_guard() {
  local ci="$1"
  run env -i PATH="$STUB_BIN" CI="$ci" HELPER="$HELPER" BATS_TEST_FILENAME=/x/example.bats \
    "$BASH_BIN" -c '
      skip() { printf "skip: %s\n" "$*"; exit 3; }
      source "$HELPER"
      require_mikefarah_yq
      echo "rc=$?"
    '
}

@test "mikefarah yq v4 passes the guard locally and in CI" {
  stub_yq 'yq (https://github.com/mikefarah/yq/) version v4.44.3'
  run_guard ""
  [ "$status" -eq 0 ]
  [ "$output" = "rc=0" ]
  run_guard true
  [ "$status" -eq 0 ]
  [ "$output" = "rc=0" ]
}

@test "mikefarah yq v4 without the leading v passes the guard" {
  stub_yq 'yq (https://github.com/mikefarah/yq/) version 4.9.6'
  run_guard ""
  [ "$output" = "rc=0" ]
}

@test "python-yq skips locally with the reported version in the reason" {
  stub_yq 'yq 0.0.0'
  run_guard ""
  [ "$status" -eq 3 ]
  [ "$output" = "skip: requires mikefarah yq v4: yq on PATH is not mikefarah yq v4 (reports: yq 0.0.0)" ]
}

@test "python-yq fails in CI instead of skipping" {
  stub_yq 'yq 0.0.0'
  run_guard true
  [ "$status" -eq 0 ]
  [[ "$output" == *"mikefarah yq v4 is required in CI for example.bats: yq on PATH is not mikefarah yq v4 (reports: yq 0.0.0)"* ]]
  [[ "$output" == *"rc=1"* ]]
  [[ "$output" != *"skip:"* ]]
}

@test "mikefarah yq v3 is not accepted" {
  stub_yq 'yq version 3.4.1 (mikefarah)'
  run_guard ""
  [ "$status" -eq 3 ]
  [[ "$output" == *"not mikefarah yq v4"* ]]
}

@test "missing yq skips locally and fails in CI" {
  run_guard ""
  [ "$status" -eq 3 ]
  [ "$output" = "skip: requires mikefarah yq v4: yq is not installed" ]
  run_guard 1
  [[ "$output" == *"mikefarah yq v4 is required in CI for example.bats: yq is not installed"* ]]
  [[ "$output" == *"rc=1"* ]]
}
